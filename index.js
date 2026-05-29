import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';

// Load environment variables from .env file
dotenv.config();

// Initialize the GoogleGenAI client using environment variable
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });


const app = express();
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN;

// Enable CORS for frontend cross-origin requests
app.use(cors());

// Parse incoming JSON payloads (critical for parsing WhatsApp webhook payloads)
app.use(express.json());

// Global JSON error-handling middleware to prevent silent crashes from malformed JSON
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('❌ Malformed JSON payload received:', err.message);
    return res.status(400).send({ error: 'Malformed JSON payload' });
  }
  next();
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

/**
 * GET /webhook/whatsapp
 * Handles Meta's webhook verification challenge.
 * Meta sends a GET request with query params: hub.mode, hub.verify_token, hub.challenge
 */
app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('--- WhatsApp Webhook Verification Request ---');
  console.log(`Mode: ${mode}`);
  console.log(`Received Token: ${token}`);
  console.log(`Challenge: ${challenge}`);

  // Check if mode and token are sent
  if (mode && token) {
    // Check if mode is 'subscribe' and token matches our local secret token
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('Webhook successfully verified!');
      // Respond with the challenge token as a raw string with 200 OK
      // Cast to String to ensure Express sends it as plain text and not as a status number
      return res.status(200).send(String(challenge));
    } else {
      console.error('Webhook verification failed: Token mismatch or invalid mode.');
      return res.sendStatus(403);
    }
  }

  console.error('Webhook verification failed: Missing parameters.');
  return res.sendStatus(400);
});

/**
 * POST /webhook/whatsapp
 * Receives incoming WhatsApp message notifications (messages, status updates, etc.).
 * To avoid timeout issues from Meta, we acknowledge receipt immediately with a 200 OK.
 */
app.post('/webhook/whatsapp', (req, res) => {
  console.log("📥 RAW INCOMING POST PAYLOAD:", JSON.stringify(req.body, null, 2));

  if (!req.body || Object.keys(req.body).length === 0) {
    console.warn('⚠️ Warning: req.body is empty or unparsed.');
  }

  const value = req.body?.entry?.[0]?.changes?.[0]?.value;
  const status = value?.statuses?.[0];
  const message = value?.messages?.[0];

  if (status) {
    console.log(`ℹ️ Status/Receipt Event Detected: ${status.status}`);
  } else if (message) {
    const sender = message.from || 'Unknown';
    if (message.type === 'text') {
      const messageText = message.text?.body || '';
      console.log(`💬 Text Message Received from ${sender}: ${messageText}`);
    }

    const customerPhone = message.from;
    const customerName = req.body?.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name || 'Unknown';
    const messageText = message.text?.body;

    console.log('\n┌────────────────────────────────────────────────────────┐');
    console.log('│             📬 NEW WHATSAPP MESSAGE RECEIVED            │');
    console.log('├────────────────────────────────────────────────────────┤');
    console.log(`│ 👤 Name:   ${customerName.padEnd(43)} │`);
    console.log(`│ 📞 Phone:  ${customerPhone.padEnd(43)} │`);
    console.log(`│ 💬 Text:   ${(messageText || '[Non-text or media]').substring(0, 43).padEnd(43)} │`);
    console.log('└────────────────────────────────────────────────────────┘\n');

    if (messageText) {
      processAIResponse(customerPhone, customerName, messageText).catch((err) => {
        console.error('Error in processAIResponse:', err);
      });
    }
  }

  res.status(200).send('EVENT_RECEIVED');
});

/**
 * Processes messages and generates AI responses using Gemini, then sends them back to the user.
 */
async function processAIResponse(phone, name, text) {
  console.log(`[Gemini AI] Generating response for ${name} (${phone}) with prompt: "${text}"`);

  // Hardcoded temporary system instruction for testing
  const systemInstruction = 'You are Saarthi AI, a brilliant assistant for a premium car detailing shop. Keep responses short and under 2 sentences.';

  const models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  const maxRetries = 3;
  let aiReplyText = null;
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    for (const model of models) {
      try {
        console.log(`[Gemini AI] Attempting generation with model "${model}" (Attempt ${attempt}/${maxRetries})...`);
        const response = await ai.models.generateContent({
          model: model,
          contents: text,
          config: { systemInstruction: systemInstruction }
        });

        if (response && response.text) {
          aiReplyText = response.text;
          break;
        }
      } catch (err) {
        lastError = err;
        console.warn(`⚠️ Warning: Failed generating with model "${model}" on attempt ${attempt}. Error: ${err.message || err}`);
      }
    }

    if (aiReplyText) {
      break;
    }

    if (attempt < maxRetries) {
      const delay = attempt * 1500;
      console.log(`[Gemini AI] All models failed on attempt ${attempt}. Waiting ${delay}ms before next retry...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  if (aiReplyText) {
    console.log(`[Gemini AI] Generated reply for ${name}: "${aiReplyText}"`);
    // Route the reply back to the customer's mobile device via Meta's Cloud API
    await sendWhatsAppMessage(phone, aiReplyText);
  } else {
    console.error(`❌ Error: All attempts and model fallbacks failed for ${name}. Last error:`, lastError);
    // Optionally notify the user or send a generic fallback message so the webhook doesn't hang or ignore them completely
    await sendWhatsAppMessage(phone, "Sorry, I am experiencing a temporary connection issue. Please try again in a moment.");
  }
}

/**
 * Helper function to send messages back to the customer via Meta's WhatsApp Cloud API
 */
async function sendWhatsAppMessage(toPhone, messageText) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.META_ACCESS_TOKEN;

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
    } else {
      console.error(`Meta API Error sending message to ${toPhone}:`, JSON.stringify(responseData));
    }
  } catch (err) {
    console.error(`Fetch error in sendWhatsAppMessage for ${toPhone}:`, err);
  }
}


// Start the server
app.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(`🚀 WhatsApp Cloud API Webhook Server is running!`);
  console.log(`📡 Port: ${PORT}`);
  console.log(`🔗 Webhook GET/POST URL: http://localhost:${PORT}/webhook/whatsapp`);
  console.log(`🔒 Verify Token Configured: ${VERIFY_TOKEN ? 'YES (Secure)' : 'NO (Action Required: Set META_WEBHOOK_VERIFY_TOKEN in .env)'}`);
  console.log(`===================================================`);
});
