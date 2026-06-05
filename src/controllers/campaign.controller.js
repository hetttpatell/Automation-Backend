import { createClient } from '@supabase/supabase-js';
import * as whatsappService from '../services/whatsapp.service.js';

// ─── Supabase Admin Client ──────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

// ─── Phone Number Sanitizer ─────────────────────────────────────────
// Strips +, spaces, dashes, parens to produce a clean E.164 numeric string
function sanitizePhone(phone) {
  return phone.replace(/[\s\-\+\(\)]/g, '');
}

// ─── Meta Error Code Classifier ─────────────────────────────────────
function parseMetaError(responseData) {
  const err = responseData?.error || {};
  const code = err.code || 0;
  const message = err.message || JSON.stringify(responseData);

  // Meta error codes that indicate a template is required:
  // 131047 — Re-engagement message (24h window expired)
  // 131026 — Message undeliverable (often session-related)
  // 131053 — Media/message outside session
  const sessionCodes = [131047, 131026, 131053];
  const isSessionExpired = sessionCodes.includes(code);

  return { code, message, isSessionExpired };
}

// ─── Meta WhatsApp Cloud API — Send Text Message ────────────────────
async function sendTextMessage(toPhone, messageText, phoneNumberId, activeToken) {
  const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${activeToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toPhone,
        type: 'text',
        text: { preview_url: false, body: messageText },
      }),
    });

    const data = await response.json();

    if (response.ok) {
      return { success: true, messageId: data.messages?.[0]?.id || 'unknown' };
    }

    const parsed = parseMetaError(data);
    return { success: false, error: parsed.message, errorCode: parsed.code };
  } catch (err) {
    return { success: false, error: err?.message || 'Network error', errorCode: 0 };
  }
}

// ─── Meta WhatsApp Cloud API — Send Template Message ────────────────
async function sendTemplateMessage(toPhone, templateName, languageCode, bodyText, phoneNumberId, activeToken) {
  const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${activeToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toPhone,
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
          components: [
            {
              type: 'body',
              parameters: [{ type: 'text', text: bodyText }],
            },
          ],
        },
      }),
    });

    const data = await response.json();

    if (response.ok) {
      return { success: true, messageId: data.messages?.[0]?.id || 'unknown' };
    }

    const parsed = parseMetaError(data);
    return { success: false, error: parsed.message, errorCode: parsed.code };
  } catch (err) {
    return { success: false, error: err?.message || 'Network error', errorCode: 0 };
  }
}

// ─── Orchestrated Campaign Message Sender ───────────────────────────
async function sendCampaignMessage(toPhone, personalizedText, phoneNumberId, activeToken, templateName, templateLang) {
  const cleanPhone = sanitizePhone(toPhone);

  // ── Template mode (preferred for campaigns) ──
  if (templateName) {
    const lang = templateLang || 'en';
    console.log(`[Campaign] 📨 Sending template "${templateName}" to ${cleanPhone}`);
    return sendTemplateMessage(cleanPhone, templateName, lang, personalizedText, phoneNumberId, activeToken);
  }

  // ── Text mode (fallback — only works within 24h session window) ──
  console.log(`[Campaign] 📨 Sending text message to ${cleanPhone}`);
  const textResult = await sendTextMessage(cleanPhone, personalizedText, phoneNumberId, activeToken);

  // If text failed due to session expiry, append actionable guidance
  if (!textResult.success) {
    const parsed = parseMetaError({ error: { code: textResult.errorCode, message: textResult.error } });
    if (parsed.isSessionExpired) {
      return {
        ...textResult,
        error: `Session expired (${textResult.errorCode}): This lead hasn't messaged in 24h. ` +
          `Set WHATSAPP_CAMPAIGN_TEMPLATE_NAME in .env to use template-based sending.`,
      };
    }
  }

  return textResult;
}

// ─── Small delay to stay within Meta throughput limits ───────────────
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Helper: Extract & verify Supabase user from Bearer token ───────
async function authenticateRequest(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { user: null, error: 'Missing or invalid Authorization header' };
  }

  const token = authHeader.split(' ')[1];
  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) {
    return { user: null, error: error?.message || 'Invalid token' };
  }

  return { user, error: null };
}

// ═════════════════════════════════════════════════════════════════════
// POST /api/campaigns/send
// Full campaign blast sender — ported from Next.js frontend
// ═════════════════════════════════════════════════════════════════════
export async function sendCampaign(req, res) {
  try {
    // ── 1. Authenticate ──
    const { user, error: authError } = await authenticateRequest(req);
    if (authError || !user) {
      console.error('[Campaign] Auth Error:', authError || 'No session');
      return res.status(401).json({ success: false, message: 'Unauthorized — please log in again.' });
    }

    const tenantId = user.id;

    // ── 2. Validate inputs ──
    const { campaign_name, custom_message_body, target_stage, template_name, template_lang } = req.body;

    if (!campaign_name || !custom_message_body || !target_stage) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: campaign_name, custom_message_body, target_stage',
      });
    }

    // ── 3. Resolve tenant business_name and credentials ──
    const { data: tenant, error: tenantError } = await supabase
      .from('tenants')
      .select('business_name, whatsapp_phone_number_id, whatsapp_access_token')
      .eq('id', tenantId)
      .single();

    if (tenantError || !tenant) {
      console.error('[Campaign] Tenant lookup failed:', tenantError?.message);
      return res.status(500).json({
        success: false,
        message: 'Could not resolve your business profile. Please try again.',
      });
    }

    // ── 4. Validate Meta credentials (use tenant database values first, fallback to env) ──
    const phoneNumberId = tenant.whatsapp_phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID;
    const activeToken = tenant.whatsapp_access_token || process.env.META_ACCESS_TOKEN;

    if (!activeToken) {
      return res.status(500).json({
        success: false,
        message: 'Campaign Failed: Business has no WhatsApp Access Token configured.',
      });
    }

    if (!phoneNumberId) {
      console.error('[Campaign] Missing Meta API credentials.');
      return res.status(500).json({
        success: false,
        message: 'Server configuration error: WhatsApp API credentials not found.',
      });
    }

    // Template configuration
    const resolvedTemplateName = template_name !== undefined
      ? (template_name || '')
      : (process.env.WHATSAPP_CAMPAIGN_TEMPLATE_NAME || '');
    const resolvedTemplateLang = template_lang !== undefined
      ? (template_lang || 'en')
      : (process.env.WHATSAPP_CAMPAIGN_TEMPLATE_LANG || 'en');

    const businessName = tenant.business_name || 'Our Business';

    // ── 5. Query all leads matching target_stage ──
    const { data: leads, error: leadsError } = await supabase
      .from('leads')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('kanban_stage', target_stage);

    if (leadsError) {
      console.error('[Campaign] Leads query error:', leadsError.message);
      return res.status(500).json({
        success: false,
        message: `Failed to fetch target leads: ${leadsError.message}`,
      });
    }

    if (!leads || leads.length === 0) {
      return res.status(400).json({
        success: false,
        message: `No leads found in the '${target_stage}' stage. Nothing to send.`,
      });
    }

    console.log(
      `\n┌─────────────────────────────────────────────────────────┐` +
      `\n│           📣 CAMPAIGN BLAST STARTING                    │` +
      `\n├─────────────────────────────────────────────────────────┤` +
      `\n│ Campaign:  ${campaign_name.substring(0, 42).padEnd(42)}│` +
      `\n│ Stage:     ${target_stage.padEnd(42)}│` +
      `\n│ Leads:     ${String(leads.length).padEnd(42)}│` +
      `\n│ Mode:      ${(resolvedTemplateName ? `Template [${resolvedTemplateName}]` : 'Text (session)').padEnd(42)}│` +
      `\n└─────────────────────────────────────────────────────────┘`
    );

    // ── 6. Create campaign record ──
    const { data: campaign, error: campaignInsertError } = await supabase
      .from('campaigns')
      .insert({
        tenant_id: tenantId,
        campaign_name,
        custom_message_body,
        target_stage,
        total_messages_sent: 0,
      })
      .select()
      .single();

    if (campaignInsertError || !campaign) {
      console.error('[Campaign] Insert error:', campaignInsertError?.message);
      return res.status(500).json({
        success: false,
        message: `Database error creating campaign: ${campaignInsertError?.message}`,
      });
    }

    const campaignId = campaign.id;

    console.log(`[Campaign] 🔑 Using token source: ${tenant.whatsapp_access_token ? 'Database Tenant Record' : '.env Fallback Overrides'}`);

    // ── 7. BLAST LOOP ──
    let successCount = 0;
    const failures = [];

    for (let i = 0; i < leads.length; i++) {
      const lead = leads[i];
      const customerPhone = lead.customer_phone;
      const customerName = lead.customer_name || 'Valued Customer';
      const leadIndex = `[${i + 1}/${leads.length}]`;

      // Variable placeholder substitution
      const personalizedMessage = custom_message_body
        .replace(/\{customer_name\}/g, customerName)
        .replace(/\{business_name\}/g, businessName);

      // Dispatch via Meta WhatsApp Cloud API
      const result = await sendCampaignMessage(
        customerPhone,
        personalizedMessage,
        phoneNumberId,
        activeToken,
        resolvedTemplateName || undefined,
        resolvedTemplateLang
      );

      if (result.success) {
        successCount++;
        console.log(`[Campaign] ${leadIndex} ✅ ${customerName} (${customerPhone}) — MID: ${result.messageId}`);

        // Resolve or create conversation for message trace
        let conversationId = lead.conversation_id;

        if (!conversationId) {
          const { data: existingConv } = await supabase
            .from('conversations')
            .select('id')
            .eq('tenant_id', tenantId)
            .eq('customer_phone', customerPhone)
            .limit(1)
            .maybeSingle();

          if (existingConv) {
            conversationId = existingConv.id;
          } else {
            const { data: newConv, error: convErr } = await supabase
              .from('conversations')
              .insert({
                tenant_id: tenantId,
                customer_phone: customerPhone,
                customer_name: customerName,
                is_ai_active: true,
              })
              .select('id')
              .single();

            if (!convErr && newConv) {
              conversationId = newConv.id;
            }
          }
        }

        // Insert message trace row so it shows in Inbox
        if (conversationId) {
          await supabase.from('messages').insert({
            conversation_id: conversationId,
            tenant_id: tenantId,
            sender: 'human',
            message_text: `[Campaign: ${campaign_name}] ${personalizedMessage}`,
          });

          // Bump conversation timestamp so it surfaces in Inbox
          await supabase
            .from('conversations')
            .update({ updated_at: new Date().toISOString() })
            .eq('id', conversationId);
        }
      } else {
        console.error(`[Campaign] ${leadIndex} ❌ ${customerName} (${customerPhone}) — ${result.error}`);
        failures.push({
          phone: customerPhone,
          name: customerName,
          reason: result.error || 'Unknown error',
        });
      }

      // Throttle between sends (Meta allows ~80 msgs/sec standard tier)
      if (i < leads.length - 1) {
        await delay(100);
      }
    }

    // ── 8. Update campaign with actual sent count ──
    await supabase
      .from('campaigns')
      .update({ total_messages_sent: successCount })
      .eq('id', campaignId);

    // ── 9. Build response ──
    const allSent = successCount === leads.length;
    const noneSent = successCount === 0;

    console.log(
      `[Campaign] 🏁 Blast finished — ${successCount}/${leads.length} delivered` +
      (failures.length > 0 ? ` | ${failures.length} failed` : '')
    );

    return res.status(200).json({
      success: !noneSent,
      message: allSent
        ? `🚀 Campaign sent to all ${successCount} recipients!`
        : noneSent
        ? `❌ Campaign failed — 0/${leads.length} messages delivered. ${failures[0]?.reason || 'Check your WhatsApp API configuration.'}`
        : `⚠️ Partial delivery: ${successCount}/${leads.length} sent, ${failures.length} failed.`,
      campaign_id: campaignId,
      total_targeted: leads.length,
      total_sent: successCount,
      total_failed: failures.length,
      ...(failures.length > 0 && {
        failed_details: failures.slice(0, 5),
      }),
    });
  } catch (err) {
    console.error('[Campaign] Unexpected Error:', err?.message, err?.stack);
    return res.status(500).json({
      success: false,
      message: err?.message || 'Internal server error',
    });
  }
}
