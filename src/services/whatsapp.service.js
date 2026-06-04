import { env } from '../config/env.js';

/**
 * Sends a basic text message to a customer's phone number via Meta's WhatsApp Cloud API.
 * @param {string} toPhone - The recipient's phone number.
 * @param {string} messageText - The message body.
 */
export async function sendWhatsAppMessage(toPhone, messageText, phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID, accessToken = env.META_ACCESS_TOKEN) {
  if (!phoneNumberId || !accessToken) {
    console.error('Error in sendWhatsAppMessage: Missing META_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID in environment variables.');
    return;
  }

  const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;
  console.log(`Sending WhatsApp message to ${toPhone}...`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toPhone,
        type: 'text',
        text: {
          preview_url: false,
          body: messageText
        }
      })
    });

    const responseData = await response.json();

    if (response.ok) {
      console.log(`Message successfully sent to ${toPhone}. Message ID: ${responseData.messages?.[0]?.id || 'unknown'}`);
      return true;
    } else {
      console.error(`Meta API Error sending message to ${toPhone}:`, JSON.stringify(responseData));
      return false;
    }
  } catch (err) {
    console.error(`Fetch error in sendWhatsAppMessage for ${toPhone}:`, err);
    return false;
  }
}

/**
 * Sends an interactive buttons menu (quick replies) to a customer's phone number via Meta's WhatsApp Cloud API.
 * @param {string} toPhone - The recipient's phone number.
 */
export async function sendWhatsAppInteractiveMenu(toPhone, phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID, accessToken = env.META_ACCESS_TOKEN) {
  if (!phoneNumberId || !accessToken) {
    console.error('Error in sendWhatsAppInteractiveMenu: Missing META_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID in environment variables.');
    return;
  }

  const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;
  console.log(`Sending interactive services menu to ${toPhone}...`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toPhone,
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
      })
    });

    const responseData = await response.json();

    if (response.ok) {
      console.log(`Interactive menu successfully sent to ${toPhone}. Message ID: ${responseData.messages?.[0]?.id || 'unknown'}`);
      return true;
    } else {
      console.error(`Meta API Error sending interactive menu to ${toPhone}:`, JSON.stringify(responseData));
      return false;
    }
  } catch (err) {
    console.error(`Fetch error in sendWhatsAppInteractiveMenu for ${toPhone}:`, err);
    return false;
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
