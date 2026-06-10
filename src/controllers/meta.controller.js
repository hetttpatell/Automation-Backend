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

    // Fetch tenant details for the authenticated user
    const { data: tenant, error: tenantError } = await supabase
      .from('tenants')
      .select('id')
      .eq('owner_email', user.email)
      .single();

    if (tenantError || !tenant) {
      console.error('[Meta Auth] Tenant profile not found for user:', user.email);
      return res.status(404).json({ error: 'Tenant profile not found.' });
    }

    const receivedCode = req.body.token || req.body.code; 

    console.log("[Meta OAuth] Exchanging code utilizing JS SDK empty redirect_uri proxy...");

    if (!process.env.META_APP_ID || !process.env.META_APP_SECRET) {
        console.error("[Meta OAuth FATAL] Missing META_APP_ID or META_APP_SECRET.");
        return res.status(500).json({ error: "Server configuration missing Meta App credentials." });
    }

    // CRITICAL: &redirect_uri= must be present but completely empty to match the JS SDK signature
    const tokenUrl = `https://graph.facebook.com/v19.0/oauth/access_token?client_id=${process.env.META_APP_ID}&client_secret=${process.env.META_APP_SECRET}&code=${receivedCode}&redirect_uri=`;

    try {
        const tokenRes = await fetch(tokenUrl);
        const tokenData = await tokenRes.json();

        if (!tokenRes.ok) {
            console.error("[Meta OAuth ERROR] Code Exchange Failed:", JSON.stringify(tokenData));
            return res.status(400).json({ error: "Failed to exchange authorization code with Meta API." });
        }

        const longLivedToken = tokenData.access_token;
        const accessToken = longLivedToken;
        console.log("[Meta OAuth] Code exchanged successfully! Extracted User Access Token.");

        // =======================================================================
        // ---> DO NOT DELETE: KEEP EXISTING WABA EXTRACTION LOGIC BELOW THIS LINE 
        // =======================================================================
        // Your existing Attempt 1 (whatsapp_business_accounts), Attempt 2, and 
        // debug_token fallback logic should begin here, using `longLivedToken`.

        let wabaId = null;
        console.log(`[Meta OAuth] Starting WABA extraction for token: ${longLivedToken.substring(0, 15)}...`);

        // Try multiple fallback mechanisms to retrieve the WABA ID:
        // 1. Direct user WABAs endpoint: /me/whatsapp_business_accounts
        // 2. Client-shared WABAs endpoint: /me/client_whatsapp_business_accounts
        // 3. Metadata inspection via /debug_token (granular scopes fallback)

        try {
          // ─── Attempt 1: /me/whatsapp_business_accounts (standard owned accounts) ───
          console.log('[Meta OAuth] Attempt 1: /me/whatsapp_business_accounts...');
          const ownedWabaUrl = `https://graph.facebook.com/v19.0/me/whatsapp_business_accounts?access_token=${longLivedToken}`;
          const ownedResponse = await fetch(ownedWabaUrl);
          if (ownedResponse.ok) {
            const ownedData = await ownedResponse.json();
            console.log('[Meta OAuth] Owned WABAs response:', JSON.stringify(ownedData, null, 2));
            if (ownedData && ownedData.data && ownedData.data.length > 0) {
              wabaId = ownedData.data[0].id;
              console.log(`[Meta OAuth] Success: WABA ID found in owned accounts -> ${wabaId}`);
            } else {
              console.log('[Meta OAuth] Owned accounts array is empty or missing.');
            }
          } else {
            const errData = await ownedResponse.json().catch(() => ({}));
            console.warn('[Meta OAuth] /me/whatsapp_business_accounts returned non-OK:', ownedResponse.status, JSON.stringify(errData));
          }

          // ─── Attempt 2: /me/client_whatsapp_business_accounts (shared accounts) ───
          if (!wabaId) {
            console.log('[Meta OAuth] Attempt 2: /me/client_whatsapp_business_accounts...');
            const clientWabaUrl = `https://graph.facebook.com/v19.0/me/client_whatsapp_business_accounts?access_token=${longLivedToken}`;
            const clientResponse = await fetch(clientWabaUrl);
            if (clientResponse.ok) {
              const clientData = await clientResponse.json();
              console.log('[Meta OAuth] Client WABAs response:', JSON.stringify(clientData, null, 2));
              if (clientData && clientData.data && clientData.data.length > 0) {
                wabaId = clientData.data[0].id;
                console.log(`[Meta OAuth] Success: WABA ID found in client shared accounts -> ${wabaId}`);
              } else {
                console.log('[Meta OAuth] Client shared accounts array is empty or missing.');
              }
            } else {
              const errData = await clientResponse.json().catch(() => ({}));
              console.warn('[Meta OAuth] /me/client_whatsapp_business_accounts returned non-OK:', clientResponse.status, JSON.stringify(errData));
            }
          }

          // ─── Attempt 3: /debug_token granular scopes fallback ───
          if (!wabaId) {
            console.log("[Meta OAuth] Standard arrays empty. Initiating granular scope fallback via debug_token...");

            if (!env.META_APP_ID || !env.META_APP_SECRET) {
              console.error("[Meta OAuth FATAL] META_APP_ID or META_APP_SECRET is missing from environment variables!");
            }

            // CRITICAL: Do NOT encodeURIComponent the app access token.
            // The pipe '|' separator between appId and appSecret is a valid
            // delimiter in Facebook's app access token format and must be
            // sent as-is. Encoding it to '%7C' causes the Graph API to
            // reject the token with an OAuthException.
            const appAccessToken = `${env.META_APP_ID}|${env.META_APP_SECRET}`;

            const debugUrl = `https://graph.facebook.com/debug_token?input_token=${longLivedToken}&access_token=${appAccessToken}`;

            try {
              const debugRes = await fetch(debugUrl);
              const debugData = await debugRes.json();

              console.log("[Meta OAuth] Debug Token Response (granular_scopes):", JSON.stringify(debugData?.data?.granular_scopes || "No granular scopes found"));
              console.log("[Meta OAuth] Debug Token Full Response:", JSON.stringify(debugData, null, 2));

              if (debugData?.data?.granular_scopes) {
                // Priority: check whatsapp_business_management first
                const whatsappScope = debugData.data.granular_scopes.find(s => s.scope === 'whatsapp_business_management');

                if (whatsappScope?.target_ids?.length > 0) {
                  wabaId = whatsappScope.target_ids[0];
                  console.log(`[Meta OAuth] Success: WABA ID extracted from 'whatsapp_business_management' granular target_ids -> ${wabaId}`);
                } else {
                  console.warn("[Meta OAuth] 'whatsapp_business_management' scope found, but target_ids array is empty or missing!");

                  // Fallback: check whatsapp_business_messaging
                  const messagingScope = debugData.data.granular_scopes.find(s => s.scope === 'whatsapp_business_messaging');
                  if (messagingScope?.target_ids?.length > 0) {
                    wabaId = messagingScope.target_ids[0];
                    console.log(`[Meta OAuth] Success: WABA ID extracted from 'whatsapp_business_messaging' granular target_ids -> ${wabaId}`);
                  }
                }

                // Last resort: scan ALL scopes for any target_ids
                if (!wabaId) {
                  for (const gs of debugData.data.granular_scopes) {
                    if (gs.target_ids && gs.target_ids.length > 0) {
                      wabaId = gs.target_ids[0];
                      console.log(`[Meta OAuth] Wildcard fallback: WABA ID from scope '${gs.scope}' target_ids -> ${wabaId}`);
                      break;
                    }
                  }
                }
              } else {
                console.warn("[Meta OAuth] debug_token response has no granular_scopes data at all.");
              }
            } catch (debugErr) {
              console.error("[Meta OAuth] debug_token fetch failed:", debugErr.message || debugErr);
            }
          }
        } catch (apiErr) {
          console.error('[Meta OAuth] Failed during WABA discovery process:', apiErr.message);
          return res.status(400).json({
            error: 'Failed to retrieve WhatsApp Business Accounts associated with the user token.',
            details: apiErr.message
          });
        }

        // ─── Final Guard ───
        if (!wabaId) {
          console.error("[Meta OAuth] FINAL FAILURE: Could not resolve WABA ID from any method (owned, client, debug_token).");
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
        console.error("[Meta OAuth FATAL] Exception during token exchange:", err);
        return res.status(500).json({ error: "Internal Server Error during token exchange." });
    }

  } catch (err) {
    console.error('[Meta OAuth Error] Uncaught runtime exception in exchangeToken:', err.response?.data || err.message || err);
    return res.status(500).json({
      error: 'An internal server error occurred while processing Meta OAuth token exchange.',
      details: err.message || err
    });
  }
}
