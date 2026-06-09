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

    const { accessToken: shortLivedToken } = req.body;
    if (!shortLivedToken) {
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
          fb_exchange_token: shortLivedToken
        }
      });
    } catch (apiErr) {
      console.error('[Meta OAuth] Token exchange with Graph API failed:', apiErr.response?.data || apiErr.message);
      return res.status(400).json({
        error: 'Failed to exchange token with Meta API.',
        details: apiErr.response?.data || apiErr.message
      });
    }

    const accessToken = longLivedTokenResponse.data.access_token;
    if (!accessToken) {
      console.error('[Meta OAuth] Long-lived token missing from response payload:', longLivedTokenResponse.data);
      return res.status(500).json({ error: 'Long-lived token missing from Meta API response.' });
    }

    console.log('[Meta OAuth] Token exchanged successfully. Fetching connected accounts...');

    // ── Step C: Discover WABA ID via Client WhatsApp Business Accounts Edge ──
    const longLivedToken = accessToken;
    let wabaId = null;

    try {
      // Fetch the shared accounts explicitly authorized by the granular picker
      const wabaUrl = `https://graph.facebook.com/v19.0/me/client_whatsapp_business_accounts?access_token=${longLivedToken}`;
      const wabaResponse = await fetch(wabaUrl);
      const wabaData = await wabaResponse.json();

      console.log('[Meta OAuth] Client WABAs response:', JSON.stringify(wabaData, null, 2));

      if (wabaData && wabaData.data && wabaData.data.length > 0) {
          wabaId = wabaData.data[0].id; 
      } else {
          // Secondary Fallback: Try the debug token inspect edge
          console.log("[Meta OAuth] Primary WABA array empty. Triggering debug_token metadata lookup...");
          
          const debugUrl = `https://graph.facebook.com/debug_token?input_token=${longLivedToken}&access_token=${process.env.META_APP_ID || env.META_APP_ID}|${process.env.META_APP_SECRET || env.META_APP_SECRET}`;
          const debugRes = await fetch(debugUrl);
          const debugData = await debugRes.json();

          // Meta often returns granularity data inside the debug metadata structure
          if (debugData && debugData.data && debugData.data.granular_scopes) {
              const whatsappScope = debugData.data.granular_scopes.find(s => s.scope === 'whatsapp_business_management');
              if (whatsappScope && whatsappScope.target_ids && whatsappScope.target_ids.length > 0) {
                  // Found the WABA ID hidden inside the target_ids metadata!
                  wabaId = whatsappScope.target_ids[0];
                  console.log(`[Meta OAuth] Successfully extracted WABA ID from granular scopes target_ids: ${wabaId}`);
              }
          }
      }
    } catch (apiErr) {
      console.error('[Meta OAuth] Failed during WABA discovery process:', apiErr.message);
      return res.status(400).json({
        error: 'Failed to retrieve WhatsApp Business Accounts associated with the user token.',
        details: apiErr.message
      });
    }

    // Ultimate check and exit guard
    if (!wabaId) {
        console.error("[Meta OAuth Error] Failed to extract WABA ID from both primary data and granular debug scopes.");
        return res.status(400).json({ 
            error: "No WhatsApp Business Account (WABA) was shared during the Meta login flow. Please re-connect and ensure you select a WhatsApp Business Account." 
        });
    }

    console.log(`[Meta OAuth] Using WABA ID: ${wabaId}. Fetching Phone Numbers...`);

    // ── Step C (cont): Fetch Phone Number ID ──
    let phoneResponse;
    try {
      phoneResponse = await axios.get(`https://graph.facebook.com/v19.0/${wabaId}/phone_numbers`, {
        headers: { Authorization: `Bearer ${accessToken}` }
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

    const phoneId = phoneList[0].id;
    console.log(`[Meta OAuth] Selected Phone Number ID: ${phoneId}`);

    // ── Step D: Persist to Supabase ──
    console.log("Saving Meta Credentials to DB:", { phoneId, wabaId, hasAccessToken: !!accessToken });
    const { error: updateError } = await supabase
      .from('tenants')
      .update({
        whatsapp_access_token: accessToken,
        whatsapp_phone_number_id: phoneId,
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
        phoneNumberId: phoneId
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
