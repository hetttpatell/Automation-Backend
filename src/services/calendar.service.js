import { google } from 'googleapis';
import { env } from '../config/env.js';
import { createClient } from '@supabase/supabase-js';

// Initialize a supabase client locally for updating tokens when they refresh
const supabase = createClient(
  env.SUPABASE_URL || '',
  env.SUPABASE_SERVICE_ROLE_KEY || ''
);

/**
 * Returns a configured Google OAuth2 client.
 */
export function getOAuth2Client() {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  const redirectUri = env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/api/calendar/callback';

  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth Client ID or Secret is not configured in the environment variables.');
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/**
 * Builds an authenticated Google Calendar API client for a given tenant.
 * Sets up token refresh event listeners to automatically persist updated credentials.
 * @param {string} tenantId 
 */
export async function getClientForTenant(tenantId) {
  const { data: tenant, error } = await supabase
    .from('tenants')
    .select('gcal_access_token, gcal_refresh_token, gcal_calendar_id, is_calendar_connected')
    .eq('id', tenantId)
    .single();

  if (error || !tenant) {
    throw new Error(`Failed to retrieve calendar credentials for tenant: ${error?.message || 'Tenant not found'}`);
  }

  if (!tenant.is_calendar_connected || !tenant.gcal_refresh_token) {
    throw new Error('Google Calendar is not connected for this business/tenant.');
  }

  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({
    access_token: tenant.gcal_access_token,
    refresh_token: tenant.gcal_refresh_token,
  });

  // Listen to tokens event to persist newly refreshed access tokens
  oauth2Client.on('tokens', async (tokens) => {
    console.log(`[Google OAuth2] Tokens refreshed for tenant ${tenantId}:`, tokens);
    const updates = {};
    if (tokens.access_token) updates.gcal_access_token = tokens.access_token;
    if (tokens.refresh_token) updates.gcal_refresh_token = tokens.refresh_token;

    if (Object.keys(updates).length > 0) {
      const { error: updateError } = await supabase
        .from('tenants')
        .update(updates)
        .eq('id', tenantId);

      if (updateError) {
        console.error(`[Google OAuth2] Failed to save refreshed tokens in Supabase:`, updateError.message);
      } else {
        console.log(`[Google OAuth2] Refreshed tokens successfully saved to Supabase.`);
      }
    }
  });

  const calendarId = tenant.gcal_calendar_id || 'primary';
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  return { oauth2Client, calendar, calendarId };
}

/**
 * Utility to format Date object into Asia/Kolkata (+05:30) offset string.
 */
function formatKolkataISO(dateObj) {
  const pad = (n) => String(n).padStart(2, '0');
  const utcTime = dateObj.getTime();
  // +5.5 hours in ms
  const kolkataTime = new Date(utcTime + (5.5 * 60 * 60 * 1000));
  const yyyy = kolkataTime.getUTCFullYear();
  const mm = pad(kolkataTime.getUTCMonth() + 1);
  const dd = pad(kolkataTime.getUTCDate());
  const hh = pad(kolkataTime.getUTCHours());
  const min = pad(kolkataTime.getUTCMinutes());
  const ss = pad(kolkataTime.getUTCSeconds());
  return `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}+05:30`;
}

/**
 * Checks the tenant's calendar availability for a given date.
 * Business hours are assumed to be 9:00 AM - 6:00 PM.
 * Returns an array of available hourly slots.
 * @param {string} tenantId 
 * @param {string} date - Date string in YYYY-MM-DD format
 */
export async function checkAvailability(tenantId, date) {
  try {
    console.log(`[Calendar Service] Checking availability for tenant: ${tenantId} on date: ${date}`);
    const { calendar, calendarId } = await getClientForTenant(tenantId);

    // Business hours bounds (9 AM to 6 PM Asia/Kolkata time)
    const timeMin = `${date}T09:00:00+05:30`;
    const timeMax = `${date}T18:00:00+05:30`;

    const freebusyRes = await calendar.freebusy.query({
      requestBody: {
        timeMin,
        timeMax,
        timeZone: 'Asia/Kolkata',
        items: [{ id: calendarId }]
      }
    });

    const busyIntervals = freebusyRes.data.calendars[calendarId]?.busy || [];
    console.log(`[Calendar Service] Busy intervals found:`, busyIntervals);

    // Define business slots hourly from 9 AM to 6 PM
    const slots = [
      { start: '09:00', end: '10:00', label: '09:00 AM - 10:00 AM' },
      { start: '10:00', end: '11:00', label: '10:00 AM - 11:00 AM' },
      { start: '11:00', end: '12:00', label: '11:00 AM - 12:00 PM' },
      { start: '12:00', end: '13:00', label: '12:00 PM - 01:00 PM' },
      { start: '13:00', end: '14:00', label: '01:00 PM - 02:00 PM' },
      { start: '14:00', end: '15:00', label: '02:00 PM - 03:00 PM' },
      { start: '15:00', end: '16:00', label: '03:00 PM - 04:00 PM' },
      { start: '16:00', end: '17:00', label: '04:00 PM - 05:00 PM' },
      { start: '17:00', end: '18:00', label: '05:00 PM - 06:00 PM' }
    ];

    const availableSlots = [];

    for (const slot of slots) {
      const slotStart = new Date(`${date}T${slot.start}:00+05:30`).getTime();
      const slotEnd = new Date(`${date}T${slot.end}:00+05:30`).getTime();

      let isOverlap = false;
      for (const busy of busyIntervals) {
        const busyStart = new Date(busy.start).getTime();
        const busyEnd = new Date(busy.end).getTime();

        // Overlap logic: slot start is before busy end AND slot end is after busy start
        if (slotStart < busyEnd && slotEnd > busyStart) {
          isOverlap = true;
          break;
        }
      }

      if (!isOverlap) {
        availableSlots.push(slot.label);
      }
    }

    console.log(`[Calendar Service] Available slots:`, availableSlots);
    return {
      date,
      available_slots: availableSlots
    };
  } catch (error) {
    console.error(`[Calendar Service] Error in checkAvailability:`, error.message);
    throw error;
  }
}

/**
 * Books an appointment by creating a Google Calendar event.
 * @param {string} tenantId 
 * @param {string} customerName 
 * @param {string} customerPhone 
 * @param {string} date - Date in YYYY-MM-DD
 * @param {string} time - Time in HH:MM format (24h) or similar
 * @param {string} serviceRequested 
 */
export async function bookAppointment(tenantId, customerName, customerPhone, date, time, serviceRequested) {
  try {
    console.log(`[Calendar Service] Booking appointment for tenant: ${tenantId}, customer: ${customerName}, date: ${date}, time: ${time}`);
    const { calendar, calendarId } = await getClientForTenant(tenantId);

    // Parse time
    const timeRegex = /(\d{1,2}):(\d{2})\s*(AM|PM)?/i;
    const match = time.match(timeRegex);
    let hours = 9;
    let minutes = 0;

    if (match) {
      hours = parseInt(match[1], 10);
      minutes = parseInt(match[2], 10);
      const ampm = match[3];
      if (ampm) {
        if (ampm.toUpperCase() === 'PM' && hours < 12) {
          hours += 12;
        } else if (ampm.toUpperCase() === 'AM' && hours === 12) {
          hours = 0;
        }
      }
    }

    const pad = (n) => String(n).padStart(2, '0');
    const startDateTime = new Date(`${date}T${pad(hours)}:${pad(minutes)}:00+05:30`);
    const endDateTime = new Date(startDateTime.getTime() + 60 * 60 * 1000); // 1 hour duration default

    const startISO = formatKolkataISO(startDateTime);
    const endISO = formatKolkataISO(endDateTime);

    const event = {
      summary: `${serviceRequested || 'Service'} Booking - ${customerName}`,
      description: `Customer Phone: ${customerPhone}\nService Requested: ${serviceRequested || 'Not Specified'}\nBooked automatically by AI Assistant.`,
      start: {
        dateTime: startISO,
        timeZone: 'Asia/Kolkata'
      },
      end: {
        dateTime: endISO,
        timeZone: 'Asia/Kolkata'
      }
    };

    const insertRes = await calendar.events.insert({
      calendarId,
      requestBody: event
    });

    console.log(`[Calendar Service] Event created successfully:`, insertRes.data.id);
    return {
      success: true,
      event_id: insertRes.data.id,
      html_link: insertRes.data.htmlLink,
      summary: event.summary,
      time_slot: `${pad(hours)}:${pad(minutes)} (Asia/Kolkata)`
    };
  } catch (error) {
    console.error(`[Calendar Service] Error in bookAppointment:`, error.message);
    throw error;
  }
}
