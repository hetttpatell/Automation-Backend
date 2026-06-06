import { env } from '../config/env.js';
import { supabase } from '../config/supabase.js';
import axios from 'axios';

/**
 * Extracts and verifies the Supabase user session from the Authorization header.
 * @param {object} req - Express request object.
 * @returns {Promise<{user: object|null, error: string|null}>}
 */
async function authenticateRequest(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { user: null, error: 'Missing or invalid Authorization header' };
  }

  const token = authHeader.split(' ')[1];
  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) {
    return { user: null, error: error?.message || 'Invalid user token' };
  }

  return { user, error: null };
}

/**
 * Exchanges the client-side short-lived user token for a long-lived system/user token,
 * fetches the corresponding WhatsApp Business Account (WABA) ID and Phone Number ID,
 * and persists them into the Supabase database.
 */
export async function exchangeToken(req, res) {
  try {
    // ── Step A: Authenticate ──
    const { user, error: authError } = await authenticateRequest(req);
    if (authError || !user) {
      console.error('[Meta Auth] Authentication failed:', authError);
      return res.status(401).json({ error: 'Unauthorized user session.' });
    }

    const { accessToken } = req.body;
    if (!accessToken) {
      return res.status(400).json({ error: 'Missing client short-lived accessToken in request body.' });
    }

    // Resolve tenant matching owner_email
    const { data: tenant, error: tenantError } = await supabase
      .from('tenants')
      .select('id')
      .eq('owner_email', user.email)
      .single();

    if (tenantError || !tenant) {
      console.error('[Meta Auth] Tenant context resolution failed:', tenantError?.message);
      return res.status(404).json({ error: 'Tenant context not found for user.' });
    }

    console.log(`[Meta OAuth] Starting token exchange for Tenant ID: ${tenant.id}...`);

    // ── Step B: Token Exchange ──
    let longLivedTokenResponse;
    try {
      longLivedTokenResponse = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
        params: {
          grant_type: 'fb_exchange_token',
          client_id: env.META_APP_ID,
          client_secret: env.META_APP_SECRET,
          fb_exchange_token: accessToken
        }
      });
    } catch (apiErr) {
      console.error('[Meta OAuth] Token exchange with Graph API failed:', apiErr.response?.data || apiErr.message);
      return res.status(400).json({
        error: 'Failed to exchange token with Meta API.',
        details: apiErr.response?.data || apiErr.message
      });
    }

    const longLivedToken = longLivedTokenResponse.data.access_token;
    if (!longLivedToken) {
      console.error('[Meta OAuth] Long-lived token missing from response payload:', longLivedTokenResponse.data);
      return res.status(500).json({ error: 'Long-lived token missing from Meta API response.' });
    }

    console.log('[Meta OAuth] Token exchanged successfully. Fetching connected accounts...');

    // ── Step C: Discover WABA ID via Debug Token ──
    // With only whatsapp_business_management + whatsapp_business_messaging scopes,
    // we cannot call /me/businesses or /me/whatsapp_business_accounts (those need
    // the general business_management scope). Instead, use the Debug Token endpoint
    // which returns `granular_scopes` containing the WABA IDs the token was granted.
    let wabaId = null;

    try {
      const debugResponse = await axios.get('https://graph.facebook.com/v19.0/debug_token', {
        params: {
          input_token: longLivedToken,
          access_token: `${env.META_APP_ID}|${env.META_APP_SECRET}`
        }
      });

      console.log('[Meta OAuth] Debug token response:', JSON.stringify(debugResponse.data, null, 2));

      const tokenData = debugResponse.data?.data;
      if (!tokenData) {
        console.error('[Meta OAuth] Debug token returned no data payload.');
        return res.status(400).json({ error: 'Could not inspect the access token. Debug endpoint returned no data.' });
      }

      // Extract WABA IDs from granular_scopes
      // The whatsapp_business_management scope entry contains the WABA IDs the token can access
      const granularScopes = tokenData.granular_scopes || [];
      const wabmScope = granularScopes.find(
        (s) => s.scope === 'whatsapp_business_management'
      );

      if (wabmScope && wabmScope.target_ids && wabmScope.target_ids.length > 0) {
        wabaId = wabmScope.target_ids[0];
        console.log(`[Meta OAuth] Discovered WABA ID from granular_scopes: ${wabaId}`);
      }

      // Fallback: also check whatsapp_business_messaging scope
      if (!wabaId) {
        const wbmScope = granularScopes.find(
          (s) => s.scope === 'whatsapp_business_messaging'
        );
        if (wbmScope && wbmScope.target_ids && wbmScope.target_ids.length > 0) {
          wabaId = wbmScope.target_ids[0];
          console.log(`[Meta OAuth] Discovered WABA ID from whatsapp_business_messaging scope: ${wabaId}`);
        }
      }
    } catch (debugErr) {
      console.error('[Meta OAuth] Debug token inspection failed:', debugErr.response?.data || debugErr.message);
      return res.status(400).json({
        error: 'Failed to inspect access token via Meta Debug Token endpoint.',
        details: debugErr.response?.data || debugErr.message
      });
    }

    if (!wabaId) {
      console.error('[Meta OAuth] No WABA ID found in granular_scopes. The user may not have shared a WhatsApp Business Account during login.');
      return res.status(400).json({
        error: 'No WhatsApp Business Account (WABA) was shared during the Meta login flow. Please re-connect and ensure you select a WhatsApp Business Account.'
      });
    }

    console.log(`[Meta OAuth] Using WABA ID: ${wabaId}. Fetching Phone Numbers...`);

    // ── Step C (cont): Fetch Phone Number ID ──
    let phoneResponse;
    try {
      phoneResponse = await axios.get(`https://graph.facebook.com/v19.0/${wabaId}/phone_numbers`, {
        headers: { Authorization: `Bearer ${longLivedToken}` }
      });
    } catch (phoneErr) {
      console.error(`[Meta OAuth] Failed to fetch Phone Numbers for WABA ${wabaId}:`, phoneErr.response?.data || phoneErr.message);
      return res.status(400).json({
        error: 'Failed to fetch WhatsApp phone numbers associated with the business account.',
        details: phoneErr.response?.data || phoneErr.message
      });
    }

    const phoneList = phoneResponse.data.data;
    if (!phoneList || phoneList.length === 0) {
      console.error(`[Meta OAuth] No phone numbers found under WABA ID: ${wabaId}. Response:`, phoneResponse.data);
      return res.status(400).json({ error: 'No phone numbers found in the associated WhatsApp Business Account.' });
    }

    const phoneNumberId = phoneList[0].id;
    console.log(`[Meta OAuth] Selected Phone Number ID: ${phoneNumberId}`);

    // ── Step D: Persist to Supabase ──
    console.log(`[Meta OAuth] Persisting credentials to Supabase for Tenant ID: ${tenant.id}`);
    const { error: updateError } = await supabase
      .from('tenants')
      .update({
        whatsapp_access_token: longLivedToken,
        whatsapp_phone_number_id: phoneNumberId,
        waba_id: wabaId,
        whatsapp_business_account_id: wabaId
      })
      .eq('id', tenant.id);

    if (updateError) {
      console.error('[Meta OAuth] Database update error:', updateError.message);
      return res.status(500).json({ error: 'Failed to save Meta credentials into the database.' });
    }

    console.log(`[Meta OAuth] Successfully connected WhatsApp Business for Tenant ID: ${tenant.id}`);
    return res.status(200).json({
      success: true,
      message: 'WhatsApp Business account connected successfully.',
      data: {
        wabaId,
        phoneNumberId
      }
    });

  } catch (err) {
    console.error('[Meta OAuth Error] Uncaught runtime exception in exchangeToken:', err.response?.data || err.message || err);
    return res.status(500).json({
      error: 'An internal server error occurred while processing Meta OAuth token exchange.',
      details: err.message || err
    });
  }
}
