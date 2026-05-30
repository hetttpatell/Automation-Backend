import { env } from '../config/env.js';
import * as aiService from '../services/ai.service.js';

// In-memory cache to hold processed message IDs.
const processedMessages = new Set();

/**
 * Handles Meta's webhook verification GET challenge.
 * Meta sends query parameters hub.mode, hub.verify_token, and hub.challenge to verify URL ownership.
 */
export function verifyWebhook(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('--- WhatsApp Webhook Verification Request ---');
  console.log(`Mode: ${mode}`);
  console.log(`Received Token: ${token}`);
  console.log(`Challenge: ${challenge}`);

  // Verify the subscribe event mode and matching verification token
  if (mode && token) {
    if (mode === 'subscribe' && token === env.META_WEBHOOK_VERIFY_TOKEN) {
      console.log('Webhook successfully verified!');
      // Return the challenge back as plain text to complete validation
      return res.status(200).send(String(challenge));
    } else {
      console.error('Webhook verification failed: Token mismatch or invalid mode.');
      return res.sendStatus(403);
    }
  }

  console.error('Webhook verification failed: Missing parameters.');
  return res.sendStatus(400);
}

/**
 * Handles incoming WhatsApp webhook events via POST (messages, status updates, buttons, etc.).
 */
export async function handleWebhookEvent(req, res) {
  console.log("📥 RAW INCOMING POST PAYLOAD:", JSON.stringify(req.body, null, 2));

  if (!req.body || Object.keys(req.body).length === 0) {
    console.warn('⚠️ Warning: req.body is empty or unparsed.');
  }

  const value = req.body?.entry?.[0]?.changes?.[0]?.value;
  const status = value?.statuses?.[0];
  const message = value?.messages?.[0];

  // Route status events (delivered, read, sent, etc.) to console logs
  if (status) {
    console.log(`ℹ️ Status/Receipt Event Detected: ${status.status}`);
    return res.status(200).send('EVENT_RECEIVED');
  } 
  
  if (message) {
    const messageId = message?.id;

    if (messageId && processedMessages.has(messageId)) {
        console.log(`♻️ Duplicate webhook detected for message ID: ${messageId}. Dropping to prevent loops.`);
        return res.status(200).send('EVENT_RECEIVED'); 
    }
    if (messageId) {
        processedMessages.add(messageId);
        // Optional: Set a timeout to delete the ID from the set after 10 minutes to prevent memory leaks
        setTimeout(() => {
          processedMessages.delete(messageId);
        }, 10 * 60 * 1000);
    }

    const sender = message.from || 'Unknown';
    let messageText = '';

    // Standard Text messaging parsing
    if (message.type === 'text') {
      messageText = message.text?.body || '';
      console.log(`💬 Text Message Received from ${sender}: ${messageText}`);
    } 
    // Interactive Quick-Reply Button payload parsing
    else if (message.type === 'interactive') {
      const buttonReply = message.interactive?.button_reply;
      messageText = buttonReply?.title || '';
      console.log(`🔘 Button Reply Received from ${sender}: ${messageText} (ID: ${buttonReply?.id})`);
    }

    const customerPhone = message.from;
    const customerName = req.body?.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name || 'Unknown';

    console.log('\n┌────────────────────────────────────────────────────────┐');
    console.log('│             📬 NEW WHATSAPP MESSAGE RECEIVED            │');
    console.log('├────────────────────────────────────────────────────────┤');
    console.log(`│ 👤 Name:   ${customerName.padEnd(43)} │`);
    console.log(`│ 📞 Phone:  ${customerPhone.padEnd(43)} │`);
    console.log(`│ 💬 Text:   ${(messageText || `[Type: ${message.type}]`).substring(0, 43).padEnd(43)} │`);
    console.log('└────────────────────────────────────────────────────────┘\n');

    // --- Immediate 200 OK acknowledgment ---
    // Meta requires an acknowledgment within 3 seconds, or it will trigger a retry.
    res.status(200).send('EVENT_RECEIVED');

    // Await the AI processing after sending the response to Meta to prevent timeout loops.
    if (messageText) {
      try {
        await aiService.processAIResponse(customerPhone, customerName, messageText);
      } catch (err) {
        console.error('Error in processAIResponse background worker:', err);
      }
    }
    return;
  }

  // --- Immediate 200 OK acknowledgment for all other events ---
  return res.status(200).send('EVENT_RECEIVED');
}

/*
=========================================
FILE: src/controllers/webhook.controller.js
=========================================
DESCRIPTION:
This controller file manages endpoints communicating with Meta's webhook integration.
It coordinates verification challenges and intercepts incoming user messages or updates.

WORKFLOW:
1. 'verifyWebhook' parses Meta GET validation parameters and compares the token configuration.
2. 'handleWebhookEvent' intercepts incoming POST payloads.
3. Retrieves the specific 'message.id' inside the webhook and performs an idempotency lookup in our Set.
4. If found in the set, logs the duplication warning and returns 200 OK immediately without triggering AI.
5. If new, populates the set and schedules deletion after 10 minutes to prevent memory leaks.
6. Maps the incoming payload (text or interactive button) and immediately sends 200 OK acknowledgment to Meta.
7. Awaits or fires the AI response processing asynchronously after acknowledging the webhook.

CONNECTION TO OTHER FILES:
- Imports META_WEBHOOK_VERIFY_TOKEN configuration from src/config/env.js.
- Imports 'processAIResponse' from src/services/ai.service.js to trigger model generation.
- Exposed methods are bound to router endpoints in src/routes/webhook.routes.js.
=========================================
*/
