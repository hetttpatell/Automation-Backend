import cron from 'node-cron';
import { supabase } from '../config/supabase.js';
import { env } from '../config/env.js';

/**
 * Sends a pre-approved template message to a phone number using Meta's WhatsApp API.
 */
async function sendTemplateMessage(toPhone, templateName, languageCode, bodyText, phoneNumberId, accessToken) {
  const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;
  const cleanPhone = toPhone.replace(/[\s\-\+\(\)]/g, "");

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: cleanPhone,
        type: "template",
        template: {
          name: templateName,
          language: { code: languageCode },
          components: [
            {
              type: "body",
              parameters: [{ type: "text", text: bodyText }],
            },
          ],
        },
      }),
    });

    const data = await response.json();
    if (response.ok) {
      return { success: true, messageId: data.messages?.[0]?.id || "unknown" };
    } else {
      return { success: false, error: data.error?.message || JSON.stringify(data) };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Checks for completed leads older than 24 hours and sends review requests.
 */
export async function checkAndSendReviewRequests() {
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Query leads in 'completed' stage that have not had a review request sent
  // and were last updated at least 24 hours ago
  const { data: leads, error } = await supabase
    .from('leads')
    .select('*, tenants(business_name, whatsapp_phone_number_id, whatsapp_access_token, google_review_link)')
    .eq('kanban_stage', 'completed')
    .eq('review_request_sent', false)
    .lt('updated_at', twentyFourHoursAgo);

  if (error) {
    console.error('[Reputation Engine] ❌ Error querying completed leads:', error.message);
    return;
  }

  if (!leads || leads.length === 0) {
    console.log('[Reputation Engine] 💤 No matching completed leads older than 24h found.');
    return;
  }

  console.log(`[Reputation Engine] 📣 Found ${leads.length} leads qualifying for review request blast.`);

  for (const lead of leads) {
    try {
      // Safely resolve tenant information from join or fallback query
      let tenant = lead.tenants || lead.tenant;
      if (!tenant) {
        const { data: fallbackTenant } = await supabase
          .from('tenants')
          .select('business_name, whatsapp_phone_number_id, whatsapp_access_token, google_review_link')
          .eq('id', lead.tenant_id)
          .single();
        tenant = fallbackTenant;
      }

      if (!tenant) {
        console.error(`[Reputation Engine] ❌ Could not resolve tenant configuration for lead ${lead.id}. Skipping.`);
        // Mark as sent to prevent infinite retries of unresolved records
        await supabase
          .from('leads')
          .update({ review_request_sent: true })
          .eq('id', lead.id);
        continue;
      }

      const googleReviewLink = tenant.google_review_link;
      if (!googleReviewLink) {
        console.log(`[Reputation Engine] ℹ️ Lead ${lead.id} is completed but tenant has no google_review_link set. Marking as processed.`);
        await supabase
          .from('leads')
          .update({ review_request_sent: true })
          .eq('id', lead.id);
        continue;
      }

      const phoneNumberId = tenant.whatsapp_phone_number_id || env.WHATSAPP_PHONE_NUMBER_ID;
      const accessToken = tenant.whatsapp_access_token || env.META_ACCESS_TOKEN;

      const customerName = lead.customer_name || 'Customer';
      const businessName = tenant.business_name || 'Our Business';
      const messageBody = `Hi ${customerName}, thank you for choosing ${businessName}! We would love to hear about your experience. Please take a moment to leave us a Google review: ${googleReviewLink}`;

      const templateName = process.env.WHATSAPP_REVIEW_TEMPLATE_NAME || 'review_request';
      const templateLang = process.env.WHATSAPP_REVIEW_TEMPLATE_LANG || 'en';

      console.log(`[Reputation Engine] 📨 Dispatching review request template "${templateName}" to ${lead.customer_phone}...`);

      const result = await sendTemplateMessage(
        lead.customer_phone,
        templateName,
        templateLang,
        messageBody,
        phoneNumberId,
        accessToken
      );

      if (result.success) {
        console.log(`[Reputation Engine] ✅ Review request successfully sent to ${lead.customer_phone}. MID: ${result.messageId}`);

        // Update lead status
        await supabase
          .from('leads')
          .update({ review_request_sent: true })
          .eq('id', lead.id);

        // Resolve or create conversation trace for UI rendering
        let conversationId = lead.conversation_id;
        if (!conversationId) {
          const { data: existingConv } = await supabase
            .from("conversations")
            .select("id")
            .eq("tenant_id", lead.tenant_id)
            .eq("customer_phone", lead.customer_phone)
            .limit(1)
            .maybeSingle();

          if (existingConv) {
            conversationId = existingConv.id;
          } else {
            const { data: newConv, error: convErr } = await supabase
              .from("conversations")
              .insert({
                tenant_id: lead.tenant_id,
                customer_phone: lead.customer_phone,
                customer_name: customerName,
                is_ai_active: true,
              })
              .select("id")
              .single();

            if (!convErr && newConv) {
              conversationId = newConv.id;
            }
          }
        }

        // Insert message trace row so it displays inside client portal chat history
        if (conversationId) {
          await supabase.from("messages").insert({
            conversation_id: conversationId,
            tenant_id: lead.tenant_id,
            sender: "human",
            message_text: `[Auto-Review Request] ${messageBody}`,
          });

          await supabase
            .from("conversations")
            .update({ updated_at: new Date().toISOString() })
            .eq("id", conversationId);
        }
      } else {
        console.error(`[Reputation Engine] ❌ Meta API Error sending review template to ${lead.customer_phone}: ${result.error}`);
        // Even on failure, update the status to prevent message storms unless it's a network retry case.
        // We mark it as true to ensure database stability.
        await supabase
          .from('leads')
          .update({ review_request_sent: true })
          .eq('id', lead.id);
      }
    } catch (err) {
      console.error(`[Reputation Engine] ❌ Failed to process lead ${lead.id}:`, err.message || err);
    }
  }
}

/**
 * Initializes the node-cron reputation engine worker.
 */
export function initReputationCron() {
  console.log('[Reputation Engine] 🚀 Auto-Review Reputation cron worker initialized!');

  // Run every hour: '0 * * * *'
  cron.schedule('0 * * * *', async () => {
    console.log('[Reputation Engine] 🕒 Running hourly review request blast check...');
    try {
      await checkAndSendReviewRequests();
    } catch (err) {
      console.error('[Reputation Engine] ❌ Error running checkAndSendReviewRequests:', err);
    }
  });

  // Run an initial checks trace in the background 5 seconds after startup to help verify integration
  setTimeout(async () => {
    console.log('[Reputation Engine] 🔎 Running initial startup check...');
    try {
      await checkAndSendReviewRequests();
    } catch (err) {
      console.error('[Reputation Engine] ❌ Startup check failed:', err);
    }
  }, 5000);
}
