import { env } from '../config/env.js';
import * as aiService from '../services/ai.service.js';
import * as whatsappService from '../services/whatsapp.service.js';
import { createClient } from '@supabase/supabase-js';

// Initialize Supabase admin client using process.env.SUPABASE_URL and process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

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
    const businessPhoneNumberId = value?.metadata?.phone_number_id;

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

    // Process database operations and downstream AI processing asynchronously in the background.
    (async () => {
      let isAiActive = true;
      let tenantId = null;
      let resolvedTenantId = null;
      let conversationId = null;
      try {
        console.log(`[Supabase] 🔄 Persisting incoming message from ${customerPhone}...`);

        // 1. Resolve tenant_id first to satisfy foreign key constraints.
        let resolvedTenant = null;
        if (businessPhoneNumberId) {
          console.log(`[Supabase] 🔍 Resolving tenant by whatsapp_phone_number_id: ${businessPhoneNumberId}`);
          const { data, error } = await supabase
            .from('tenants')
            .select('id, whatsapp_phone_number_id, whatsapp_access_token')
            .eq('whatsapp_phone_number_id', businessPhoneNumberId)
            .limit(1)
            .maybeSingle();

          if (error) {
            console.error(`[Supabase] Error matching tenant phone number:`, error.message);
          } else if (data) {
            resolvedTenant = data;
            console.log(`[Supabase] Tenant successfully matched: ${resolvedTenant.id}`);
          }
        }

        // Fallback to default admin tenant if not found
        if (!resolvedTenant) {
          console.log(`[Supabase] Tenant not found by phone number. Falling back to default admin tenant...`);
          const { data, error } = await supabase
            .from('tenants')
            .select('id, whatsapp_phone_number_id, whatsapp_access_token')
            .eq('owner_email', 'admin@detailing.com')
            .limit(1)
            .maybeSingle();

          if (data) {
            resolvedTenant = data;
          }
        }

        if (resolvedTenant) {
          tenantId = resolvedTenant.id;
        } else {
          // If the default tenant does not exist at all, create it.
          console.log(`[Supabase] Default tenant not found. Provisioning...`);
          const { data: insertedTenant, error: insertTenantError } = await supabase
            .from('tenants')
            .insert({
              business_name: 'Premium Car Detailing Shop',
              owner_email: 'admin@detailing.com',
              whatsapp_phone_number_id: businessPhoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID,
              whatsapp_access_token: process.env.META_ACCESS_TOKEN
            })
            .select('id')
            .single();

          if (insertTenantError) {
            throw new Error(`Failed to create default tenant: ${insertTenantError.message}`);
          }
          tenantId = insertedTenant.id;
          console.log(`[Supabase] Successfully provisioned default tenant: ${tenantId}`);
        }

        resolvedTenantId = tenantId;
        if (!resolvedTenantId) {
          throw new Error("Webhook rejected: Tenant mapping failed.");
        }

        // Step A: Find or Create Conversation
        const { data: existingConversation, error: convSelectError } = await supabase
          .from('conversations')
          .select('id, is_ai_active')
          .eq('tenant_id', resolvedTenantId)
          .eq('customer_phone', customerPhone)
          .limit(1)
          .single();

        if (existingConversation) {
          conversationId = existingConversation.id;
          isAiActive = existingConversation.is_ai_active;
          console.log(`[Supabase] Found existing conversation: ${conversationId}, is_ai_active: ${isAiActive}`);
        } else {
          // Create a new conversation if it doesn't exist
          const { data: newConversation, error: convInsertError } = await supabase
            .from('conversations')
            .insert({
              tenant_id: resolvedTenantId,
              customer_phone: customerPhone,
              customer_name: customerName,
              is_ai_active: true
            })
            .select('id, is_ai_active')
            .single();

          if (convInsertError) {
            throw new Error(`Failed to create conversation: ${convInsertError.message}`);
          }
          conversationId = newConversation.id;
          isAiActive = newConversation.is_ai_active;
          console.log(`[Supabase] Created new conversation: ${conversationId}, is_ai_active: ${isAiActive}`);
        }

        // Step B: Save Message
        const { error: msgInsertError } = await supabase
          .from('messages')
          .insert({
            conversation_id: conversationId,
            tenant_id: resolvedTenantId,
            sender: 'customer',
            message_text: messageText || ''
          });

        if (msgInsertError) {
          throw new Error(`Failed to save message: ${msgInsertError.message}`);
        }
        console.log(`[Supabase] Successfully saved customer message for conversation ${conversationId}`);

        // Step C: Update Timestamp
        const { error: convUpdateError } = await supabase
          .from('conversations')
          .update({ updated_at: new Date().toISOString() })
          .eq('id', conversationId);

        if (convUpdateError) {
          console.error(`[Supabase] ⚠️ Warning: Failed to update conversation timestamp: ${convUpdateError.message}`);
        } else {
          console.log(`[Supabase] Updated conversation updated_at timestamp`);
        }

      } catch (dbError) {
        console.error('❌ Database operation failed inside webhook POST handler:', dbError.message || dbError);
      }

      // Trigger the outbound AI response loop using Gemini and the Meta Graph API in the background.
      if (messageText) {
        try {
          if (isAiActive) {
            console.log(`[Webhook Background] Initiating primary AI pipeline for conversation: ${conversationId}`);

            // Pre-flight Interception: Query incoming sender tenant's ai_credits_balance
            const { data: tenantCredits, error: creditsError } = await supabase
              .from('tenants')
              .select('ai_credits_balance, whatsapp_phone_number_id, whatsapp_access_token')
              .eq('id', resolvedTenantId)
              .single();

            if (creditsError) {
              console.error(`[Webhook Background] Error checking credits for tenant ${resolvedTenantId}:`, creditsError.message);
            }

            const currentBalance = tenantCredits?.ai_credits_balance ?? 0;

            if (currentBalance <= 0) {
              console.log(`[Webhook Background] Hard Abort: Tenant ${resolvedTenantId} has ${currentBalance} credits.`);
              const tenantPhoneId = tenantCredits?.whatsapp_phone_number_id || env.WHATSAPP_PHONE_NUMBER_ID;
              const tenantToken = tenantCredits?.whatsapp_access_token || env.META_ACCESS_TOKEN;
              const fallbackMsg = "Our AI assistant is temporarily resting. A human teammate will step in shortly.";

              // Dispatch default, non-AI fallback string via the Meta API
              await whatsappService.sendWhatsAppMessage(customerPhone, fallbackMsg, tenantPhoneId, tenantToken);

              // Log AI message to Supabase messages table
              await supabase
                .from('messages')
                .insert({
                  conversation_id: conversationId,
                  tenant_id: resolvedTenantId,
                  sender: 'ai',
                  message_text: fallbackMsg
                });
              return; // Stop execution
            }

            // Call the consolidated AI process function to get unified JSON response text
            const responseText = await aiService.processAIResponse(customerPhone, customerName, messageText, resolvedTenantId);
            console.log(`[Webhook Background] Unified JSON response text:`, responseText);

            // Parse response JSON with robust stripping of markdown formatting
            let cleanedResponseText = responseText.trim();
            cleanedResponseText = cleanedResponseText
              .replace(/^```(?:json)?\s*/i, '')
              .replace(/```$/, '')
              .trim();

            const firstBrace = cleanedResponseText.indexOf('{');
            const lastBrace = cleanedResponseText.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
              cleanedResponseText = cleanedResponseText.substring(firstBrace, lastBrace + 1);
            }

            const aiResponse = JSON.parse(cleanedResponseText);
            console.log(`[Webhook Background] Parsed AI Response:`, aiResponse);

            // Extract reply_message and lead_extraction objects
            const aiReplyText = aiResponse.reply_message || '';
            const leadExtraction = aiResponse.lead_extraction || {};

            // Determine if the reply contains a menu quick reply key
            const hasMenu = aiReplyText.includes('[SHOW_MENU]');
            const dbText = hasMenu
              ? '[I showed the user the services menu]'
              : aiReplyText;

            // Log AI message to Supabase messages table
            const { error: insertMsgError } = await supabase
              .from('messages')
              .insert({
                conversation_id: conversationId,
                tenant_id: resolvedTenantId,
                sender: 'ai',
                message_text: dbText
              });

            if (insertMsgError) {
              console.error(`[Webhook Background] ⚠️ Failed to save AI response to DB:`, insertMsgError.message);
            }

            // Step A: Send reply_message via the WhatsApp API immediately
            const tenantPhoneId = tenantCredits?.whatsapp_phone_number_id || resolvedTenantId?.whatsapp_phone_number_id || env.WHATSAPP_PHONE_NUMBER_ID;
            const tenantToken = tenantCredits?.whatsapp_access_token || resolvedTenantId?.whatsapp_access_token || env.META_ACCESS_TOKEN;

            let messageSentSuccessfully = false;

            if (hasMenu) {
              const cleanedReply = aiReplyText.replace('[SHOW_MENU]', '').trim();
              let textSent = true;
              if (cleanedReply) {
                textSent = await whatsappService.sendWhatsAppMessage(customerPhone, cleanedReply, tenantPhoneId, tenantToken);
              }
              const menuSent = await whatsappService.sendWhatsAppInteractiveMenu(customerPhone, tenantPhoneId, tenantToken);
              messageSentSuccessfully = textSent || menuSent;
            } else {
              messageSentSuccessfully = await whatsappService.sendWhatsAppMessage(customerPhone, aiReplyText, tenantPhoneId, tenantToken);
            }

            // Decrement: Upon an HTTP 200 message receipt confirmation from Meta, decrement the corresponding tenant's credits by exactly 1
            if (messageSentSuccessfully) {
              console.log(`[Webhook Background] Message successfully sent. Decrementing credits for tenant ${resolvedTenantId}`);
              const { data: newBalance, error: decError } = await supabase.rpc('decrement_tenant_credits', {
                tenant_id: resolvedTenantId
              });

              if (decError) {
                console.error(`[Webhook Background] Error decrementing credits via RPC:`, decError.message);
                // Fallback direct update
                await supabase
                  .from('tenants')
                  .update({ ai_credits_balance: Math.max(0, currentBalance - 1) })
                  .eq('id', resolvedTenantId);
              } else {
                console.log(`[Webhook Background] Credit decremented. New balance: ${newBalance}`);
              }
            }

            // Step B: Check booking intent and perform upsert logic if true
            if (leadExtraction.has_booking_intent === true) {
              console.log(`[Webhook Background] Booking intent detected! Upserting lead details:`, leadExtraction);

              // Perform an UPSERT against the 'leads' table matching on customer_phone
              const { data: existingLead, error: leadError } = await supabase
                .from('leads')
                .select('id')
                .eq('customer_phone', customerPhone)
                .limit(1)
                .maybeSingle();

              if (leadError) {
                console.error(`[Webhook Background] Error searching for existing lead:`, leadError.message);
              }

              const leadData = {
                customer_name: leadExtraction.customer_name || customerName || 'Unknown',
                customer_phone: customerPhone,
                service_requested: leadExtraction.requested_service || null,
                urgency: leadExtraction.urgency || 'medium',
                kanban_stage: 'new'
              };

              if (existingLead) {
                console.log(`[Webhook Background] Lead exists. Updating lead with ID: ${existingLead.id}`);
                const { error: updateError } = await supabase
                  .from('leads')
                  .update({
                    tenant_id: resolvedTenantId,
                    conversation_id: conversationId,
                    ...leadData
                  })
                  .eq('id', existingLead.id);

                if (updateError) {
                  console.error(`[Webhook Background] Error updating lead:`, updateError.message);
                }
              } else {
                console.log(`[Webhook Background] Lead does not exist. Creating new lead.`);
                const { error: insertError } = await supabase
                  .from('leads')
                  .insert({
                    tenant_id: resolvedTenantId,
                    conversation_id: conversationId,
                    ...leadData
                  });

                if (insertError) {
                  console.error(`[Webhook Background] Error inserting lead:`, insertError.message);
                }
              }

              console.log(`[Webhook Background] ✅ Structured lead successfully saved/updated for ${customerPhone}`);
            } else {
              console.log(`[Webhook Background] No booking/service intent found for conversation ${conversationId}`);
            }

          } else {
            console.log("AI Disabled by Human Operator for this session");
          }
        } catch (err) {
          console.error('Error in consolidated AI background worker:', err);

          // Inform user of connection failure
          try {
            await whatsappService.sendWhatsAppMessage(customerPhone, "Sorry, I am experiencing a temporary connection issue. Please try again in a moment.");
          } catch (sendErr) {
            console.error('[Webhook Background] Failed to send error notification via WhatsApp:', sendErr.message || sendErr);
          }
        }
      }
    })();
    return;
  }

  // --- Immediate 200 OK acknowledgment for all other events ---
  return res.status(200).send('EVENT_RECEIVED');
}

/**
 * Handles manually sent human agent responses, triggers the WhatsApp message send,
 * and logs the new message trace in the database.
 */
export async function sendMessageFromHuman(req, res) {
  const { conversationId, customerPhone, messageText, tenantId } = req.body;

  if (!conversationId || !customerPhone || !messageText || !tenantId) {
    return res.status(400).json({ error: 'Missing required parameters.' });
  }

  try {
    // Fetch tenant credentials from database to support custom phone and token
    const { data: tenant } = await supabase
      .from('tenants')
      .select('whatsapp_phone_number_id, whatsapp_access_token')
      .eq('id', tenantId)
      .single();

    const tenantPhoneId = tenant?.whatsapp_phone_number_id || env.WHATSAPP_PHONE_NUMBER_ID;
    const tenantToken = tenant?.whatsapp_access_token || env.META_ACCESS_TOKEN;

    console.log(`[Human Message] Forwarding message to WhatsApp: "${messageText}" for phone ${customerPhone}...`);
    // 1. Send manual message via WhatsApp Cloud API
    await whatsappService.sendWhatsAppMessage(customerPhone, messageText, tenantPhoneId, tenantToken);

    console.log(`[Supabase] Saving human message for conversation ${conversationId}...`);
    // 2. Persist the human's response in the Supabase messages table
    const { data, error } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversationId,
        tenant_id: tenantId,
        sender: 'human',
        message_text: messageText
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to save human message to Supabase: ${error.message}`);
    }

    // 3. Update the conversation's updated_at timestamp
    const { error: convUpdateError } = await supabase
      .from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversationId);

    if (convUpdateError) {
      console.error(`[Supabase] ⚠️ Warning: Failed to update conversation timestamp: ${convUpdateError.message}`);
    }

    return res.status(200).json({ success: true, message: data });
  } catch (error) {
    console.error('❌ Error sending manual human message:', error.message || error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
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
