import { ai } from '../config/gemini.js';
import * as dbService from './db.service.js';
import * as whatsappService from './whatsapp.service.js';
import OpenAI from 'openai';
import { supabase } from '../config/supabase.js';
import { checkAvailability, bookAppointment } from './calendar.service.js';

// Initialize OpenAI client lazily to prevent crashes at startup when OPENAI_API_KEY is not defined.
let openai = null;
function getOpenAIClient() {
  if (!openai) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('Missing OPENAI_API_KEY environment variable.');
    }
    openai = new OpenAI({ apiKey });
  }
  return openai;
}

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
 * Helper to strip markdown code blocks and extract JSON object boundaries.
 */
function cleanJsonString(str) {
  let cleaned = str.trim();
  cleaned = cleaned
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  }
  return cleaned;
}

/**
 * Processes client incoming messages, queries necessary DB prompts, runs LLM tool extraction,
 * and responds to the WhatsApp user.
 * @param {string} phone - Customer mobile number.
 * @param {string} name - Customer profile name.
 * @param {string} text - Message text payload.
 */
export async function processAIResponse(phone, name, text, tenantId = null) {
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

    // Return the mocked JSON string matching the unified schema.
    return JSON.stringify({
      reply_message: cachedAnswer,
      lead_extraction: {
        has_booking_intent: false,
        customer_name: null,
        requested_service: null,
        urgency: null
      }
    });
  }

  // ── 2. Conversation Resolution & System Prompt Retrieval ──────────────────
  const conversationId = await dbService.resolveConversation(phone, name, tenantId);

  // Retrieve the tenant ID linked to this active chat
  const metadata = await dbService.getConversationMetadata(conversationId);
  const resolvedTenantId = metadata.tenant_id || tenantId;
  console.log(`[Supabase] Resolved tenant_id: "${resolvedTenantId}" for conversation: "${conversationId}"`);

  // Retrieve custom tenant prompt instructions & all business context fields
  const { data: tenantData } = await supabase
    .from('tenants')
    .select('business_name, ai_system_instruction, services_text, hours_text, rules_text, payment_methods_text, target_audience_text, ai_tone, bot_language')
    .eq('id', resolvedTenantId)
    .single();

  const businessName = tenantData?.business_name;
  const baseInstruction = tenantData?.ai_system_instruction || '';
  const servicesText = tenantData?.services_text || '';
  const hoursText = tenantData?.hours_text || '';
  const rulesText = tenantData?.rules_text || '';
  const paymentMethodsText = tenantData?.payment_methods_text || '';
  const targetAudienceText = tenantData?.target_audience_text || '';
  const aiTone = tenantData?.ai_tone || 'Professional';
  const botLanguage = tenantData?.bot_language || 'English';
  console.log(`[Supabase] Fetched base system instruction of length: ${baseInstruction.length} for business: ${businessName}`);

  const isConfigured = businessName && businessName.trim() !== '' && businessName.trim().toLowerCase() !== 'my business';
  const resolvedBusinessName = isConfigured ? businessName : 'Business Strategy & Consultancy';

  // Remove any legacy "LeadFlow" branding from the dynamic instructions as a fallback safety
  const baseInstructionClean = baseInstruction
    .replace(/LeadFlow AI Assistant/gi, `AI Assistant for ${resolvedBusinessName}`)
    .replace(/LeadFlow/gi, resolvedBusinessName);

  // Retrieve all FAQs associated with this tenant
  const faqRows = await dbService.getKnowledgeBaseFaqs(resolvedTenantId);
  console.log(`[Supabase] Fetched ${(faqRows || []).length} FAQ entries for tenant_id: ${resolvedTenantId}`);

  // --- Prompt Efficiency: Construct clean instruction while stripping redundant spaces/newlines ---
  let systemInstruction = `You are the AI Assistant for ${resolvedBusinessName}, an elite, hyper-efficient representative. You must respond to the user based on the provided Knowledge Base and instructions. 
When greeting the customer or starting the conversation, welcome them with: "Hello! Welcome to our ${resolvedBusinessName} assistant. How can we help you today?"
Your communication tone is: ${aiTone}. You must communicate primarily in ${botLanguage}.`;

  // --- Dynamic Business Context Injection ---
  if (servicesText) {
    systemInstruction += `\n\nOur Services & Pricing:\n${servicesText}`;
  }
  if (hoursText) {
    systemInstruction += `\n\nOperating Hours & Location:\n${hoursText}`;
  }
  if (paymentMethodsText) {
    systemInstruction += `\n\nPayment Methods Accepted:\n${paymentMethodsText}`;
  }
  if (targetAudienceText) {
    systemInstruction += `\n\nTarget Audience & Brand Positioning:\n${targetAudienceText}`;
  }
  if (rulesText) {
    systemInstruction += `\n\nBusiness Rules, Policies & FAQs:\n${rulesText}`;
  }

  systemInstruction += `\n\nCRITICAL: You must ALWAYS return your response in the following strict JSON format:
{
  "reply_message": "The actual text response you want to send to the WhatsApp user.",
  "lead_extraction": {
    "has_booking_intent": boolean (true ONLY if they are trying to book, buy, or get a quote),
    "customer_name": "Extracted name or null",
    "requested_service": "Extracted service or null",
    "urgency": "high, medium, low, or null"
  }
}

You have access to the business's live calendar. If a customer wants to book, ALWAYS check availability first using your tools, offer them 2-3 available time slots, and once they confirm, use your booking tool to schedule it.`;

  if (baseInstructionClean) {
    systemInstruction += `\n\nAdditional Custom Instructions:\n${baseInstructionClean}`;
  }

  if (faqRows && faqRows.length > 0) {
    const faqText = faqRows.map(row => `Q: ${row.question}\nA: ${row.answer}`).join('\n\n');
    systemInstruction += `\n\nUse the following knowledge base FAQs to answer customer questions when relevant:\n${faqText}`;
  }

  systemInstruction += `\n\nYou MUST return your final response as a valid, raw JSON object without markdown formatting. Do not wrap it in \`\`\`json blocks.`;

  // Strip excessive spaces, tabs, and double-newlines to make prompt delivery highly token-efficient
  systemInstruction = systemInstruction
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();

  // ── 3. Build context window from the last 4 messages in the DB (Context Pruning) ──
  // By requesting a max of the last 4 messages, we prevent long chats from bloating prompt length.
  // NOTE: The current user message was already inserted into the DB by the webhook controller,
  // so getRecentMessages will include it. We exclude it from history and pass it as the active turn.
  const recentMessages = await dbService.getRecentMessages(conversationId, 4);

  // Exclude the current incoming message (which is the last message in chronological order)
  const chatHistoryRaw = [...(recentMessages || [])];
  if (chatHistoryRaw.length > 0 && chatHistoryRaw[chatHistoryRaw.length - 1].sender === 'customer') {
    chatHistoryRaw.pop();
  }

  // Map database entries to role/parts formats required by Gemini structure
  let history = chatHistoryRaw.map(msg => {
    let role = msg.sender;
    if (role === 'customer') {
      role = 'user';
    } else if (role === 'ai' || role === 'human') {
      role = 'model';
    } else {
      role = 'user';
    }

    // For AI/model messages: the DB stores the full JSON response (e.g. {"reply_message":"...","lead_extraction":{...}}).
    // We must extract ONLY the reply_message text to prevent raw JSON from leaking into the conversation context,
    // which causes the model to repeat/append previous answers into new responses.
    let msgText = msg.message_text || '';
    if (role === 'model') {
      try {
        const parsed = JSON.parse(msgText);
        if (parsed.reply_message) {
          msgText = parsed.reply_message;
        }
      } catch (_) {
        // Not JSON — use as-is (e.g. human agent messages)
      }
    }

    // Strictly enforce length limits on historical items as well to prevent token leakage
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

  // ── 4. Gemini API Call with Hard Token Limits, Function Calling & Robust Retries ──
  const maxRetries = 3;
  let responseData = null;
  let lastError = null;
  let currentModel = 'gemini-2.5-flash';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Gemini AI] Attempting generation with model "${currentModel}" (Attempt ${attempt}/${maxRetries})...`);
      
      let loopCount = 0;
      const maxLoops = 5;
      // Start with history context and append the current user message as the active turn
      let currentContents = [
        ...history,
        { role: 'user', parts: [{ text: processedText }] }
      ];
      let finalResponse = null;

      while (loopCount < maxLoops) {
        const response = await ai.models.generateContent({
          model: currentModel,
          contents: currentContents,
          config: {
            systemInstruction: systemInstruction,
            tools: [{
              functionDeclarations: [
                {
                  name: "check_availability",
                  description: "Returns available time slots for a given date by querying the Google Calendar API for free/busy intervals during the tenant's business hours.",
                  parameters: {
                    type: "OBJECT",
                    properties: {
                      date: {
                        type: "STRING",
                        description: "The date to check in YYYY-MM-DD format."
                      }
                    },
                    required: ["date"]
                  }
                },
                {
                  name: "book_appointment",
                  description: "Creates a calendar event on the connected Google Calendar and returns a success confirmation.",
                  parameters: {
                    type: "OBJECT",
                    properties: {
                      customer_name: {
                        type: "STRING",
                        description: "The customer's name."
                      },
                      customer_phone: {
                        type: "STRING",
                        description: "The customer's phone number."
                      },
                      date: {
                        type: "STRING",
                        description: "The date of the appointment in YYYY-MM-DD format."
                      },
                      time: {
                        type: "STRING",
                        description: "The time of the appointment in HH:MM format (24-hour) or '10:00 AM' format."
                      },
                      service_requested: {
                        type: "STRING",
                        description: "The detailing/service requested by the customer."
                      }
                    },
                    required: ["customer_name", "customer_phone", "date", "time", "service_requested"]
                  }
                }
              ]
            }],
            maxOutputTokens: 800,
            temperature: 0.3
          }
        });

        console.log(`[Gemini AI] Raw response (loop ${loopCount}):`, JSON.stringify(response, null, 2));

        const functionCalls = response.functionCalls;
        if (!functionCalls || functionCalls.length === 0) {
          finalResponse = response;
          break;
        }

        // Add model's turn (which contains function calls) to conversation history
        currentContents.push({
          role: 'model',
          parts: response.candidates[0].content.parts
        });

        // Execute all function calls requested by Gemini
        const responseParts = [];
        for (const call of functionCalls) {
          const { name, args } = call;
          console.log(`[Gemini Tool] Executing "${name}" with arguments:`, args);

          let result;
          try {
            if (name === 'check_availability') {
              result = await checkAvailability(resolvedTenantId, args.date);
            } else if (name === 'book_appointment') {
              result = await bookAppointment(
                resolvedTenantId,
                args.customer_name,
                args.customer_phone,
                args.date,
                args.time,
                args.service_requested
              );
            } else {
              result = { error: `Function "${name}" is not implemented.` };
            }
          } catch (toolErr) {
            console.error(`[Gemini Tool Error] Failed running "${name}":`, toolErr);
            result = { error: toolErr.message || 'Execution failed.' };
          }

          responseParts.push({
            functionResponse: {
              name,
              response: result
            }
          });
        }

        // Add tool's responses back to the conversation history
        currentContents.push({
          role: 'tool',
          parts: responseParts
        });

        loopCount++;
      }

      if (finalResponse) {
        responseData = finalResponse;
        break;
      }
    } catch (err) {
      lastError = err;
      console.warn(`⚠️ Warning: Failed generating with model "${currentModel}" on attempt ${attempt}. Error: ${err.message || err}`);
      
      const isRateLimit = err.status === 429 || (err.message && err.message.includes('429'));
      const isServiceUnavailable = err.status === 503 || (err.message && (err.message.includes('503') || err.message.includes('UNAVAILABLE')));
      
      if (isRateLimit || isServiceUnavailable) {
        if (isServiceUnavailable) {
          console.warn("503 High Demand detected. Falling back to lite model.");
        } else {
          console.warn(`[Gemini AI] 🔄 Quota exhausted for ${currentModel}. Automatically falling back to "gemini-2.5-flash-lite".`);
        }
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
    const responseText = responseData.text || '';
    if (!responseText || responseText.trim() === '') {
      throw new Error("Empty response received from Gemini.");
    }
    return cleanJsonString(responseText);
  } else {
    console.error(`❌ Error: All attempts failed for ${name}. Last error:`, lastError);
    throw lastError || new Error(`Failed to generate response for ${name}.`);
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

/**
 * Generates an outbound AI response using OpenAI and sends it via Meta's WhatsApp Cloud API.
 * Saves the resulting AI message to the database.
 * @param {string} conversationId 
 * @param {string} customerPhone 
 * @param {string} incomingMessage 
 */
export async function generateAndSendAIResponse(conversationId, customerPhone, incomingMessage) {
  try {
    console.log(`[OpenAI Chat] Generating AI response for conversation ${conversationId}...`);

    // Step A (Fetch Context): Query Supabase for the active tenant's settings and knowledge base (FAQs)
    // 1. Resolve tenant_id from conversations table
    const { data: convData, error: convError } = await supabase
      .from('conversations')
      .select('tenant_id')
      .eq('id', conversationId)
      .single();

    if (convError || !convData) {
      throw new Error(`Failed to retrieve conversation metadata: ${convError?.message}`);
    }
    const tenantId = convData.tenant_id;

    // 2. Fetch the tenant settings (system prompt/tone) and all business context fields
    const { data: tenantData, error: tenantError } = await supabase
      .from('tenants')
      .select('ai_system_instruction, ai_tone, business_name, services_text, hours_text, rules_text, payment_methods_text, target_audience_text, bot_language')
      .eq('id', tenantId)
      .single();

    const baseInstruction = tenantData?.ai_system_instruction || '';
    const aiTone = tenantData?.ai_tone || 'professional';
    const businessNameRaw = tenantData?.business_name;
    const servicesText = tenantData?.services_text || '';
    const hoursText = tenantData?.hours_text || '';
    const rulesText = tenantData?.rules_text || '';
    const paymentMethodsText = tenantData?.payment_methods_text || '';
    const targetAudienceText = tenantData?.target_audience_text || '';
    const botLanguage = tenantData?.bot_language || 'English';

    const isConfigured = businessNameRaw && businessNameRaw.trim() !== '' && businessNameRaw.trim().toLowerCase() !== 'my business';
    const businessName = isConfigured ? businessNameRaw : 'Business Strategy & Consultancy';

    // Remove any legacy "LeadFlow" branding from the dynamic instructions as a fallback safety
    const baseInstructionClean = baseInstruction
      .replace(/LeadFlow AI Assistant/gi, `AI Assistant for ${businessName}`)
      .replace(/LeadFlow/gi, businessName);

    // 3. Fetch knowledge_base FAQs
    const { data: faqs, error: faqsError } = await supabase
      .from('knowledge_base')
      .select('question, answer')
      .eq('tenant_id', tenantId);

    // Step B (Prompt Construction): Construct system prompt with full business context
    let systemPrompt = `You are a helpful WhatsApp assistant for ${businessName}. Use the following knowledge base to answer the user. If the answer isn't in the knowledge base, politely say you don't know and offer to connect them to a human.\n`;
    systemPrompt += `AI Tone: ${aiTone}\n`;
    systemPrompt += `Primary Language: ${botLanguage}\n`;

    // Inject granular business context fields
    if (servicesText) {
      systemPrompt += `\nOur Services & Pricing:\n${servicesText}\n`;
    }
    if (hoursText) {
      systemPrompt += `\nOperating Hours & Location:\n${hoursText}\n`;
    }
    if (paymentMethodsText) {
      systemPrompt += `\nPayment Methods Accepted:\n${paymentMethodsText}\n`;
    }
    if (targetAudienceText) {
      systemPrompt += `\nTarget Audience & Brand Positioning:\n${targetAudienceText}\n`;
    }
    if (rulesText) {
      systemPrompt += `\nBusiness Rules, Policies & FAQs:\n${rulesText}\n`;
    }

    if (baseInstructionClean) {
      systemPrompt += `\nAdditional Custom Instructions:\n${baseInstructionClean}\n`;
    }

    if (faqs && faqs.length > 0) {
      const faqText = faqs.map(f => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n');
      systemPrompt += `\nKnowledge Base FAQs:\n${faqText}\n`;
    }

    // Step C (Fetch Chat History): Retrieve recent messages for conversational context
    const recentMessages = await dbService.getRecentMessages(conversationId, 4);

    // Exclude the current incoming message (already saved to DB and is the last element)
    const chatHistoryRaw = [...(recentMessages || [])];
    if (chatHistoryRaw.length > 0 && chatHistoryRaw[chatHistoryRaw.length - 1].sender === 'customer') {
      chatHistoryRaw.pop();
    }

    // Build chat history as distinct individual message objects.
    // CRITICAL: Do NOT concatenate previous messages into a single text block.
    // Each message must be its own {role, content} object in the messages array.
    const chatHistory = chatHistoryRaw.map(msg => {
      const isAssistant = msg.sender === 'ai' || msg.sender === 'human';
      let content = msg.message_text || '';

      // For AI messages: the DB may store the full JSON response (e.g. {"reply_message":"..."}).
      // Extract only the reply_message text to prevent raw JSON from leaking into context.
      if (isAssistant) {
        try {
          const parsed = JSON.parse(content);
          if (parsed.reply_message) {
            content = parsed.reply_message;
          }
        } catch (_) {
          // Not JSON — use as-is (e.g. human agent messages)
        }
      }

      return {
        sender: msg.sender === 'customer' ? 'user' : 'assistant',
        text: content
      };
    });

    console.log(`[OpenAI Chat] Constructing completions API call with prompt length: ${systemPrompt.length}, history entries: ${chatHistory.length}`);

    // Step D (Call AI): Call OpenAI Chat Completions API with properly structured messages
    const completion = await getOpenAIClient().chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        ...chatHistory.map(msg => ({
          role: msg.sender === 'user' ? 'user' : 'assistant',
          content: msg.text
        })),
        { role: 'user', content: incomingMessage }
      ],
      max_tokens: 300,
      temperature: 0.7
    });

    const aiMessageText = completion.choices[0]?.message?.content || "I'm sorry, I couldn't process your request. Would you like me to connect you to a human?";
    console.log(`[OpenAI Chat] Generated completion: "${aiMessageText}"`);

    // Step D: Send message via Meta WhatsApp API
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN;

    if (!phoneNumberId || !accessToken) {
      throw new Error('Missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN in environment variables.');
    }

    const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;
    console.log(`[Meta API] Sending message to ${customerPhone} via Meta Graph API v18.0...`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: customerPhone,
        type: "text",
        text: {
          body: aiMessageText
        }
      })
    });

    const responseData = await response.json();
    if (!response.ok) {
      throw new Error(`Meta Cloud API responded with error: ${JSON.stringify(responseData)}`);
    }
    console.log(`[Meta API] Outbound message successfully transmitted to ${customerPhone}`);

    // Step E: Save to Supabase
    const { error: insertMsgError } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversationId,
        tenant_id: tenantId,
        sender: 'ai',
        message_text: aiMessageText
      });

    if (insertMsgError) {
      throw new Error(`Failed to save AI response to Supabase: ${insertMsgError.message}`);
    }
    console.log(`[Supabase] Outbound AI response logged successfully in messages table`);

  } catch (error) {
    console.error('❌ Error in generateAndSendAIResponse:', error.message || error);
  }
}
