import { getOAuth2Client } from '../services/calendar.service.js';
import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';

const supabase = createClient(
  env.SUPABASE_URL || '',
  env.SUPABASE_SERVICE_ROLE_KEY || ''
);

/**
 * Redirects the user to Google's OAuth 2.0 consent screen.
 * Triggers: GET /api/calendar/auth?tenant_id=XYZ
 */
export async function redirectToAuth(req, res) {
  const { tenant_id } = req.query;

  if (!tenant_id) {
    console.error('[Calendar OAuth] Missing tenant_id in auth redirect request.');
    return res.status(400).json({ error: 'Missing tenant_id parameter' });
  }

  try {
    const oauth2Client = getOAuth2Client();

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline', // Crucial to obtain refresh token
      scope: ['https://www.googleapis.com/auth/calendar'],
      state: tenant_id,
      prompt: 'consent' // Forces consent screen to show to always guarantee receiving refresh token
    });

    console.log(`[Calendar OAuth] Redirecting tenant ${tenant_id} to Google consent screen...`);
    return res.redirect(authUrl);
  } catch (error) {
    console.error('[Calendar OAuth] Error generating auth URL:', error.message || error);
    return res.status(500).json({ error: 'Failed to initiate calendar connection', details: error.message });
  }
}

/**
 * Captures the Google authorization code, exchanges it for access/refresh tokens,
 * and saves them to the correct tenant_id in Supabase.
 * Triggers: GET /api/calendar/callback?code=...&state=tenant_id
 */
export async function calendarCallback(req, res) {
  const { code, state: tenantId } = req.query;

  if (!code || !tenantId) {
    console.error('[Calendar OAuth] Missing code or state (tenant_id) in Google callback.');
    return res.redirect('http://localhost:3000/settings?error=oauth_failed');
  }

  try {
    console.log(`[Calendar OAuth] Exchanging code for tokens for tenant: ${tenantId}...`);
    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);

    console.log(`[Calendar OAuth] Tokens received. Saving to database...`);
    
    // Save tokens and connect status to the tenant in Supabase
    const { error: dbError } = await supabase
      .from('tenants')
      .update({
        gcal_access_token: tokens.access_token,
        gcal_refresh_token: tokens.refresh_token,
        is_calendar_connected: true
      })
      .eq('id', tenantId);

    if (dbError) {
      throw new Error(`Database error saving tokens: ${dbError.message}`);
    }

    console.log(`[Calendar OAuth] Google Calendar successfully connected for tenant ${tenantId}!`);
    return res.redirect('http://localhost:3000/settings?success=true');
  } catch (error) {
    console.error('[Calendar OAuth] Error during Google Callback flow:', error.message || error);
    return res.redirect('http://localhost:3000/settings?error=oauth_failed');
  }
}
