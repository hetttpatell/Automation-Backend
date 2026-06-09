import { env } from '../config/env.js';
import { supabase as supabaseAdmin } from '../config/supabase.js';
import axios from 'axios';

/**
 * Resolves WhatsApp credentials for a given tenant.
 * Falls back to environment variables if tenant credentials are missing or tenantId is null.
 * @param {string|null} tenantId - The tenant's ID.
 * @returns {Promise<{resolvedToken: string, resolvedPhoneId: string}>}
 */
async function resolveCredentials(identifier) {
  const { data: tenant, error } = await supabaseAdmin
    .from('tenants')
    .select('whatsapp_access_token, whatsapp_phone_number_id')
    .eq('id', identifier)
    .single();

  console.log("[SaaS Credential Fetch] DB Response:", { tenant, error });

  if (error) {
    throw new Error(`Supabase query failed: ${error.message}`);
  }

  if (!tenant || !tenant.whatsapp_access_token || !tenant.whatsapp_phone_number_id) {
    throw new Error("SaaS Error: Tenant found, but WhatsApp credentials (token/phone_id) are empty in the database. User needs to connect their WhatsApp account.");
  }

  return {
    accessToken: tenant.whatsapp_access_token,
    phoneNumberId: tenant.whatsapp_phone_number_id
  };
}

/**
 * Sends a basic text message to a customer's phone number via Meta's WhatsApp Cloud API.
 * @param {string|null} tenantId - The tenant's ID.
 * @param {string} toPhone - The recipient's phone number.
 * @param {string} messageText - The message body.
 */
export async function sendWhatsAppMessage(tenantId, toPhone, messageText, accessToken = null) {
  try {
    let resolvedToken = accessToken;
    let resolvedPhoneId = accessToken ? tenantId : null;

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId);
    if (!resolvedToken || isUuid) {
      const creds = await resolveCredentials(tenantId);
      resolvedToken = resolvedToken || creds.accessToken;
      resolvedPhoneId = creds.phoneNumberId;
    }
    const url = `https://graph.facebook.com/v20.0/${resolvedPhoneId}/messages`;
    
    const cleanPhone = String(toPhone).replace(/\D/g, '');
    console.log(`Sending WhatsApp message to ${cleanPhone} (original: ${toPhone}) using Phone Number ID: ${resolvedPhoneId}...`);

    let sanitizedText = messageText || '';
    if (typeof sanitizedText === 'string') {
      // Replace bullet points starting with * with •
      sanitizedText = sanitizedText.replace(/^\s*\*\s+/gm, '• ');
      // Replace double asterisks ** with single asterisks *
      sanitizedText = sanitizedText.replace(/\*\*/g, '*');
    }

    const response = await axios.post(url, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanPhone,
      type: 'text',
      text: {
        preview_url: false,
        body: sanitizedText
      }
    }, {
      headers: {
        'Authorization': `Bearer ${resolvedToken}`,
        'Content-Type': 'application/json'
      }
    });

    console.log(`Message successfully sent to ${cleanPhone}. Message ID: ${response.data.messages?.[0]?.id || 'unknown'}`);
    return true;
  } catch (err) {
    console.error(`Axios/Credential error in sendWhatsAppMessage for ${toPhone}:`, err.message || err);
    if (err.response) {
      console.error("Meta API Response Error Data:", JSON.stringify(err.response.data, null, 2));
      console.error("Meta API Response Status:", err.response.status);
      console.error("Meta API Response Headers:", err.response.headers);
    }
    throw err;
  }
}

/**
 * Sends an interactive buttons menu (quick replies) to a customer's phone number via Meta's WhatsApp Cloud API.
 * @param {string|null} tenantId - The tenant's ID.
 * @param {string} toPhone - The recipient's phone number.
 */
export async function sendWhatsAppInteractiveMenu(tenantId, toPhone) {
  try {
    const { accessToken, phoneNumberId } = await resolveCredentials(tenantId);
    const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;
    
    const cleanPhone = String(toPhone).replace(/\D/g, '');
    console.log(`Sending interactive services menu to ${cleanPhone} (original: ${toPhone}) using Phone Number ID: ${phoneNumberId}...`);

    const response = await axios.post(url, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanPhone,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: {
          text: 'Here are our top services. What would you like to explore?'
        },
        action: {
          buttons: [
            {
              type: 'reply',
              reply: {
                id: 'btn_exterior_wash',
                title: 'Exterior Wash'
              }
            },
            {
              type: 'reply',
              reply: {
                id: 'btn_ceramic_coating',
                title: 'Ceramic Coating'
              }
            },
            {
              type: 'reply',
              reply: {
                id: 'btn_speak_to_human',
                title: 'Speak to Human'
              }
            }
          ]
        }
      }
    }, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    console.log(`Interactive menu successfully sent to ${cleanPhone}. Message ID: ${response.data.messages?.[0]?.id || 'unknown'}`);
    return true;
  } catch (err) {
    console.error(`Axios/Credential error in sendWhatsAppInteractiveMenu for ${toPhone}:`, err.message || err);
    if (err.response) {
      console.error("Meta API Response Error Data:", JSON.stringify(err.response.data, null, 2));
      console.error("Meta API Response Status:", err.response.status);
      console.error("Meta API Response Headers:", err.response.headers);
    }
    throw err;
  }
}

/*
=========================================
FILE: src/services/whatsapp.service.js
=========================================
DESCRIPTION:
This module encapsulates outbound interactions targeting Meta's WhatsApp Cloud Graph API.
It centralizes the JSON construction and authentication headers required to safely 
transmit chat messages and button menus to users.

WORKFLOW:
1. Extracts credentials (WHATSAPP_PHONE_NUMBER_ID and META_ACCESS_TOKEN) from env.js config.
2. Construct the specific request body based on whether it is a text-type or interactive-type push.
3. Fires a standard HTTP POST request using fetch to the Facebook Graph API messages endpoint.
4. Audits response bodies or exceptions for monitoring logs.

CONNECTION TO OTHER FILES:
- Imports configurations from src/config/env.js.
- Exported functions are consumed inside src/services/ai.service.js to trigger customer feedback confirmations
  and interactive choices based on LLM outputs or FAQ matches.
=========================================
*/
