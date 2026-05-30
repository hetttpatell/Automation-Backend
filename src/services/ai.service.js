import { ai } from '../config/gemini.js';
import * as dbService from './db.service.js';
import * as whatsappService from './whatsapp.service.js';

// Static FAQ Cache representing Zero-Token Intercept for common customer inquiries.
// By routing these matches locally, we spend 0 API tokens and guarantee instantaneous responses.
const faqCache = {
  'where are you located': 'We are located at MG Road, Pune. Feel free to visit us anytime during business hours!',
  'what are your hours': 'We are open Monday to Saturday, 9:00 AM – 7:00 PM. Closed on Sundays.',
  'what are your timings': 'We are open Monday to Saturday, 9:00 AM – 7:00 PM. Closed on Sundays.',
  'how can i book': 'You can book an appointment right here on WhatsApp! Just tell me your car model and preferred date.',
  'do you do home service': 'Yes, we offer doorstep detailing services within Pune city limits. What car would you like serviced?'
};

/**
 * Strips all punctuation and collapses whitespace for reliable local FAQ key matching.
 * @param {string} input - Raw text prompt from user.
 * @returns {string} Cleaned, normalized input string.
 */
function normalizeFaqInput(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')   // remove all characters except letters, numbers, spaces
    .replace(/\s+/g, ' ')           // collapse multiple consecutive spaces
    .trim();
}

/**
 * Processes client incoming messages, queries necessary DB prompts, runs LLM tool extraction,
 * and responds to the WhatsApp user.
 * @param {string} phone - Customer mobile number.
 * @param {string} name - Customer profile name.
 * @param {string} text - Message text payload.
 */
export async function processAIResponse(phone, name, text) {
  // --- Token Optimization: Enforce a strict length limit on incoming user message ---
  const MAX_CHAR_LIMIT = 500;
  let processedText = text;
  if (text.length > MAX_CHAR_LIMIT) {
    console.warn(`⚠️ Warning: Incoming message from ${phone} exceeded character limit (${text.length} chars). Truncating to ${MAX_CHAR_LIMIT}.`);
    processedText = text.substring(0, MAX_CHAR_LIMIT) + '... (truncated)';
  }

  console.log(`[Gemini AI] Generating response for ${name} (${phone}) with prompt: "${processedText}"`);

  // ── 1. FAQ Cache: Zero-Token Intercept ────────────────────────────────────
  const normalizedInput = normalizeFaqInput(processedText);
  const cachedAnswer = faqCache[normalizedInput];

  if (cachedAnswer) {
    console.log(`[FAQ Cache] ✅ Cache HIT for "${normalizedInput}" — skipping Gemini API call entirely.`);

    // Persist the transaction in the database for consistency and audits
    const conversationId = await dbService.resolveConversation(phone, name);
    await dbService.insertMessage(conversationId, 'user', processedText);
    await dbService.insertMessage(conversationId, 'model', cachedAnswer);

    await whatsappService.sendWhatsAppMessage(phone, cachedAnswer);
    return; // Stop execution to save Gemini API costs
  }

  // ── 2. Conversation Resolution & System Prompt Retrieval ──────────────────
  const conversationId = await dbService.resolveConversation(phone, name);

  // Retrieve the tenant ID linked to this active chat
  const metadata = await dbService.getConversationMetadata(conversationId);
  const tenantId = metadata.tenant_id;
  console.log(`[Supabase] Resolved tenant_id: "${tenantId}" for conversation: "${conversationId}"`);

  // Retrieve custom tenant prompt instructions
  const baseInstruction = await dbService.getTenantInstruction(tenantId);
  console.log(`[Supabase] Fetched base system instruction of length: ${baseInstruction.length}`);

  // Retrieve all FAQs associated with this tenant
  const faqRows = await dbService.getKnowledgeBaseFaqs(tenantId);
  console.log(`[Supabase] Fetched ${(faqRows || []).length} FAQ entries for tenant_id: ${tenantId}`);

  // --- Prompt Efficiency: Construct clean instruction while stripping redundant spaces/newlines ---
  let systemInstruction = baseInstruction;
  if (faqRows && faqRows.length > 0) {
    const faqText = faqRows.map(row => `Q: ${row.question}\nA: ${row.answer}`).join('\n\n');
    systemInstruction += `\n\nUse the following knowledge base FAQs to answer customer questions when relevant:\n${faqText}`;
  }

  systemInstruction += "\n\nCRITICAL DIRECTIVE: If the user indicates they want to book, schedule, or request a service, YOU MUST NOT REPLY WITH TEXT. You MUST strictly invoke the 'extract_lead' function with their details.";

  // Strip excessive spaces, tabs, and double-newlines to make prompt delivery highly token-efficient
  systemInstruction = systemInstruction
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();

  // ── 3. Save incoming user message to DB before hitting Gemini ────────────
  await dbService.insertMessage(conversationId, 'user', processedText);

  // ── 4. Build context window from the last 4 messages in the DB (Context Pruning) ──
  // By requesting a max of the last 4 messages, we prevent long chats from bloating prompt length.
  const recentMessages = await dbService.getRecentMessages(conversationId, 4);

  // Map database entries to role/parts formats required by Gemini structure
  let history = (recentMessages || []).map(msg => {
    let role = msg.sender;
    if (role === 'customer') role = 'user';
    else if (role === 'ai') role = 'model';

    // Strictly enforce length limits on historical items as well to prevent token leakage
    let msgText = msg.message_text || '';
    if (msgText.length > MAX_CHAR_LIMIT) {
      msgText = msgText.substring(0, MAX_CHAR_LIMIT) + '...';
    }

    return {
      role: role,
      parts: [{ text: msgText }]
    };
  });

  // Safety: ensure context dialog always begins with a 'user' turn (not model response)
  while (history.length > 0 && history[0].role === 'model') {
    history.shift();
  }

  // ── 5. Gemini Tool Definition ─────────────────────────────────────────────
  // Core definition for Lead Extraction, preserved exactly from working code.
  const tools = [
    {
      functionDeclarations: [
        {
          name: 'extract_lead',
          description: 'CRITICAL: Call this function IMMEDIATELY when a customer explicitly asks to book a service, requests a schedule, or indicates an emergency need for a specific service.',
          parameters: {
            type: 'OBJECT',
            properties: {
              service_requested: {
                type: 'STRING',
                description: 'The specific detailing service or package the customer is requesting (e.g. Ceramic Coating, Exterior Wash, etc.).'
              },
              urgency: {
                type: 'STRING',
                enum: ['low', 'medium', 'high'],
                description: 'The urgency level of the request.'
              }
            },
            required: ['service_requested', 'urgency']
          }
        }
      ]
    }
  ];

  // ── 6. Gemini API Call with Hard Token Limits & Robust Retries ───────────
  const maxRetries = 3;
  let responseData = null;
  let lastError = null;
  let currentModel = 'gemini-2.5-flash';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Gemini AI] Attempting generation with model "${currentModel}" (Attempt ${attempt}/${maxRetries})...`);
      const response = await ai.models.generateContent({
        model: currentModel,
        contents: history,
        config: {
          systemInstruction: systemInstruction,
          tools: tools,
          toolConfig: {
            functionCallingConfig: {
              mode: "AUTO"
            }
          },
          maxOutputTokens: 250,
          temperature: 0.3
        }
      });

      console.log("RAW GEMINI RESPONSE:", JSON.stringify(response, null, 2));

      if (response) {
        responseData = response;
        break;
      }
    } catch (err) {
      lastError = err;
      console.warn(`⚠️ Warning: Failed generating with model "${currentModel}" on attempt ${attempt}. Error: ${err.message || err}`);
      if (err.status === 429 || (err.message && err.message.includes('429'))) {
        console.warn(`[Gemini AI] 🔄 Quota exhausted for ${currentModel}. Automatically falling back to "gemini-2.5-flash-lite".`);
        currentModel = 'gemini-2.5-flash-lite';
      }
    }

    if (attempt < maxRetries) {
      const delay = attempt * 1500;
      console.log(`[Gemini AI] Call failed on attempt ${attempt}. Waiting ${delay}ms before next retry...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  if (responseData) {
    const parts = responseData.candidates?.[0]?.content?.parts || [];
    const functionCallPart = parts.find(p => p.functionCall);
    const functionCall = functionCallPart ? functionCallPart.functionCall : null;

    if (functionCall && functionCall.name === 'extract_lead') {
      const { service_requested, urgency } = functionCall.args;
      console.log(`[Gemini AI] 🎯 Tool extract_lead invoked! Service: "${service_requested}", Urgency: "${urgency}"`);

      // Log the lead record securely in Supabase RLS bypass
      await dbService.insertLead({
        tenant_id: tenantId,
        conversation_id: conversationId,
        customer_name: name,
        customer_phone: phone,
        service_requested: service_requested,
        urgency: urgency
      });

      console.log(`[Supabase] ✅ Lead successfully logged in the database for ${name} (${phone})`);

      // Inform user of successful capture
      const confirmationMsg = `I've logged your request for ${service_requested}! Our team will contact you shortly.`;
      console.log(`[WhatsApp] Sending lead logged confirmation to ${phone}: "${confirmationMsg}"`);
      await whatsappService.sendWhatsAppMessage(phone, confirmationMsg);

      // Audit model response in history
      await dbService.insertMessage(conversationId, 'model', confirmationMsg);

    } else {
      // Normal Chat Flow
      let aiReplyText = responseData.text || '';
      if (!aiReplyText || aiReplyText.trim() === '') {
        aiReplyText = "I'm sorry, I didn't quite catch that. What kind of service are you looking to book?";
      }
      console.log(`[Gemini AI] Generated normal reply for ${name}: "${aiReplyText}"`);

      // ── 7. Menu Pruning: lightweight DB logs but full text delivery to users ──
      const hasMenu = aiReplyText.includes('[SHOW_MENU]');
      const dbText = hasMenu
        ? '[I showed the user the services menu]'
        : aiReplyText;

      await dbService.insertMessage(conversationId, 'model', dbText);

      // Send output replies back to Meta Cloud API
      if (hasMenu) {
        const cleanedReply = aiReplyText.replace('[SHOW_MENU]', '').trim();
        if (cleanedReply) {
          await whatsappService.sendWhatsAppMessage(phone, cleanedReply);
        }
        await whatsappService.sendWhatsAppInteractiveMenu(phone);
      } else {
        await whatsappService.sendWhatsAppMessage(phone, aiReplyText);
      }
    }
  } else {
    console.error(`❌ Error: All attempts failed for ${name}. Last error:`, lastError);

    // Rollback the unanswered user message so it does not clutter future context windows
    await dbService.deleteLastCustomerMessage(conversationId, processedText);

    // Inform user of connection failure
    await whatsappService.sendWhatsAppMessage(phone, "Sorry, I am experiencing a temporary connection issue. Please try again in a moment.");
  }
}

/*
=========================================
FILE: src/services/ai.service.js
=========================================
DESCRIPTION:
This service orchestrates the core smart-agent capabilities of our system. It handles local FAQ cache
queries, system prompt configuration, history context window pruning, token leakage limits,
and interfaces the Gemini API.

WORKFLOW:
1. Implements strict input length limitation to prevent large payloads (Token Optimization).
2. Performs normalization and does a zero-cost local lookup on the 'faqCache' (Zero-Token Intercept).
3. If missed, queries the Supabase DB to retrieve conversation metadata, custom instruction configurations,
   tenant FAQs, and chronological chat history.
4. Cleanses and compresses the dynamic prompt layout to eliminate unnecessary whitespaces.
5. Employs the Google Gen AI client library to request model 'gemini-2.5-flash' completion, enforcing
   rigid 'extract_lead' tools configuration.
6. Parses tool calls to save generated leads in Supabase, or handles standard text dialog and menu flows.
7. Executes database rollbacks on catastrophic API failures.

CONNECTION TO OTHER FILES:
- Imports 'ai' instance from src/config/gemini.js to run content generation.
- Consumes src/services/db.service.js to perform all database transactions.
- Consumes src/services/whatsapp.service.js to push text messages and interactive quick-reply menus.
- Exposed 'processAIResponse' is triggered asynchronously inside src/controllers/webhook.controller.js.
=========================================
*/
