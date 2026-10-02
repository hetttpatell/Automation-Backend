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
  let message = err.message || JSON.stringify(responseData);

  // Meta error codes:
  // 131030 — Recipient phone number not in allowed list (Test/Sandbox account restriction)
  // 131047 — Re-engagement message (24h window expired)
  // 131026 — Message undeliverable (often session-related)
  // 131053 — Media/message outside session
  const sessionCodes = [131047, 131026, 131053];
  const isSessionExpired = sessionCodes.includes(code);
  const isNotInAllowedList = code === 131030;

  if (isNotInAllowedList) {
    message = `Recipient not in Meta test allowed list (#131030). Add this phone number in Meta Developer Portal (WhatsApp > API Setup > 'To' phone numbers), or switch to a Live WhatsApp Business Account.`;
  } else if (isSessionExpired) {
    message = `WhatsApp 24-hour service window expired (#${code}). Use a pre-approved template message to reach this customer.`;
  }

  return { code, message, isSessionExpired, isNotInAllowedList };
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

// ─── Meta WhatsApp Cloud API — Send Document Message ────────────────
async function sendDocumentMessage(toPhone, pdfUrl, filename, captionText, phoneNumberId, activeToken) {
  const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;

  const documentPayload = {
    link: pdfUrl,
    filename: filename || 'Document.pdf',
  };
  if (captionText && captionText.trim()) {
    let sanitized = captionText.replace(/^\s*\*\s+/gm, '• ').replace(/\*\*/g, '*');
    documentPayload.caption = sanitized.substring(0, 1024);
  }

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
        type: 'document',
        document: documentPayload,
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
async function sendTemplateMessage(toPhone, templateName, languageCode, bodyText, phoneNumberId, activeToken, mediaHeader = null) {
  const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;

  const components = [];
  if (mediaHeader && mediaHeader.link) {
    components.push({
      type: 'header',
      parameters: [
        {
          type: mediaHeader.type || 'document',
          document: {
            link: mediaHeader.link,
            filename: mediaHeader.filename || 'Document.pdf',
          },
        },
      ],
    });
  }

  if (bodyText && bodyText.trim()) {
    components.push({
      type: 'body',
      parameters: [{ type: 'text', text: bodyText }],
    });
  }

  const postTemplate = async (comps) => {
    const templatePayload = {
      name: templateName,
      language: { code: languageCode || 'en' },
    };
    if (comps && comps.length > 0) {
      templatePayload.components = comps;
    }
    return fetch(url, {
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
        template: templatePayload,
      }),
    });
  };

  try {
    let response = await postTemplate(components);
    let data = await response.json();

    // If Meta rejected with param mismatch (#132000), try fallback variations
    if (!response.ok && data?.error?.code === 132000) {
      console.warn(`[Campaign Template] Parameter mismatch for "${templateName}" (Error 132000). Retrying without body parameters...`);
      const headerOnly = components.filter(c => c.type === 'header');
      response = await postTemplate(headerOnly);
      data = await response.json();

      if (!response.ok && data?.error?.code === 132000 && headerOnly.length > 0) {
        console.warn(`[Campaign Template] Retrying "${templateName}" with plain template (no components)...`);
        response = await postTemplate([]);
        data = await response.json();
      }
    }

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
async function sendCampaignMessage(toPhone, personalizedText, phoneNumberId, activeToken, templateName, templateLang, media = null) {
  const cleanPhone = sanitizePhone(toPhone);

  // ── Template mode (preferred for campaigns) ──
  if (templateName) {
    const lang = templateLang || 'en';
    console.log(`[Campaign] 📨 Sending template "${templateName}" to ${cleanPhone}${media?.link ? ' with PDF' : ''}`);
    return sendTemplateMessage(cleanPhone, templateName, lang, personalizedText, phoneNumberId, activeToken, media);
  }

  // ── Document mode (when PDF is attached) ──
  if (media && media.link) {
    console.log(`[Campaign] 📎 Sending PDF document to ${cleanPhone} (filename: ${media.filename || 'Document.pdf'})`);
    // If personalized text fits in caption (<= 1024 chars), send with caption
    if (personalizedText && personalizedText.length <= 1024) {
      return sendDocumentMessage(cleanPhone, media.link, media.filename, personalizedText, phoneNumberId, activeToken);
    } else {
      // If caption is longer than 1024 chars, send text first, then document
      const textResult = await sendTextMessage(cleanPhone, personalizedText, phoneNumberId, activeToken);
      if (!textResult.success) return textResult;
      await delay(200);
      return sendDocumentMessage(cleanPhone, media.link, media.filename, null, phoneNumberId, activeToken);
    }
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
    const { campaign_name, custom_message_body, target_stage, template_name, template_lang, recipients, pdf_url, pdf_filename } = req.body;

    const hasRecipients = Array.isArray(recipients) && recipients.length > 0;

    if (!campaign_name || !custom_message_body || (!target_stage && !hasRecipients)) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: campaign_name, custom_message_body, and either target_stage or recipients list',
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

    // ── 5. Resolve target recipients (Imported file or CRM leads) ──
    let leads = [];
    const resolvedTargetStage = hasRecipients ? (target_stage || 'custom_import') : target_stage;

    if (hasRecipients) {
      leads = recipients
        .filter(r => r && (r.customer_phone || r.phone))
        .map(r => {
          const rawPhone = String(r.customer_phone || r.phone || '');
          let clean = sanitizePhone(rawPhone);
          // If 10 digits starting with 6-9, prefix 91 for India
          if (/^[6-9]\d{9}$/.test(clean)) {
            clean = '91' + clean;
          }
          return {
            customer_name: (r.customer_name || r.name || '').trim() || 'Valued Customer',
            customer_phone: clean,
            is_imported: true,
          };
        })
        .filter(r => r.customer_phone.length >= 7);

      if (leads.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'No valid phone numbers found in the uploaded list. Please check your file formatting.',
        });
      }
    } else {
      const { data: dbLeads, error: leadsError } = await supabase
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

      if (!dbLeads || dbLeads.length === 0) {
        return res.status(400).json({
          success: false,
          message: `No leads found in the '${target_stage}' stage. Nothing to send.`,
        });
      }
      leads = dbLeads;
    }

    console.log(
      `\n┌─────────────────────────────────────────────────────────┐` +
      `\n│           📣 CAMPAIGN BLAST STARTING                    │` +
      `\n├─────────────────────────────────────────────────────────┤` +
      `\n│ Campaign:  ${campaign_name.substring(0, 42).padEnd(42)}│` +
      `\n│ Target:    ${(hasRecipients ? 'Custom File Import' : `Stage: ${target_stage}`).padEnd(42)}│` +
      `\n│ Contacts:  ${String(leads.length).padEnd(42)}│` +
      `\n│ Mode:      ${(resolvedTemplateName ? `Template [${resolvedTemplateName}]` : 'Text (session)').padEnd(42)}│` +
      `\n│ Media:     ${(pdf_filename ? `PDF: ${pdf_filename.substring(0, 37)}` : 'None (Text Only)').padEnd(42)}│` +
      `\n└─────────────────────────────────────────────────────────┘`
    );

    // ── 6. Create campaign record ──
    const { data: campaign, error: campaignInsertError } = await supabase
      .from('campaigns')
      .insert({
        tenant_id: tenantId,
        campaign_name,
        custom_message_body,
        target_stage: resolvedTargetStage,
        total_messages_sent: 0,
        media_url: pdf_url || null,
        media_filename: pdf_filename || null,
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

    const mediaAttachment = pdf_url ? { link: pdf_url, filename: pdf_filename || 'Document.pdf', type: 'document' } : null;

    for (let i = 0; i < leads.length; i++) {
      const lead = leads[i];
      const customerPhone = lead.customer_phone;
      const customerName = lead.customer_name || 'Valued Customer';
      const leadIndex = `[${i + 1}/${leads.length}]`;

      // Variable placeholder substitution
      const personalizedMessage = custom_message_body
        .replace(/\{customer_name\}/g, customerName)
        .replace(/\{name\}/g, customerName)
        .replace(/\{business_name\}/g, businessName);

      // Dispatch via Meta WhatsApp Cloud API
      const result = await sendCampaignMessage(
        customerPhone,
        personalizedMessage,
        phoneNumberId,
        activeToken,
        resolvedTemplateName || undefined,
        resolvedTemplateLang,
        mediaAttachment
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
            message_text: pdf_filename
              ? `[Campaign: ${campaign_name}] 📄 ${pdf_filename}\n${personalizedMessage}`
              : `[Campaign: ${campaign_name}] ${personalizedMessage}`,
            media_url: pdf_url || null,
            media_type: pdf_url ? 'document' : null,
            media_filename: pdf_filename || null,
            whatsapp_message_id: result.messageId || null,
            status: 'sent',
          });

          // Bump conversation timestamp so it surfaces in Inbox
          await supabase
            .from('conversations')
            .update({ updated_at: new Date().toISOString() })
            .eq('id', conversationId);
        }

        // If imported contact, ensure they exist in CRM leads table
        if (lead.is_imported) {
          try {
            const { data: existingLead } = await supabase
              .from('leads')
              .select('id')
              .eq('tenant_id', tenantId)
              .eq('customer_phone', customerPhone)
              .limit(1)
              .maybeSingle();

            if (!existingLead) {
              await supabase.from('leads').insert({
                tenant_id: tenantId,
                customer_name: customerName,
                customer_phone: customerPhone,
                conversation_id: conversationId,
                kanban_stage: 'contacted',
                intent_category: 'GENERAL',
                summary_of_needs: `Imported via campaign: ${campaign_name}`,
              });
            }
          } catch (leadSyncErr) {
            console.warn('[Campaign] Non-blocking lead sync warning:', leadSyncErr?.message);
          }
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

    const primaryFailureReason = failures[0]?.reason || 'Check your WhatsApp API configuration.';
    const isAllowedListFailure = failures.some(f => f.reason?.includes('131030') || f.reason?.includes('allowed list'));

    let summaryMessage = '';
    if (allSent) {
      summaryMessage = `🚀 Campaign sent to all ${successCount} recipients!`;
    } else if (noneSent) {
      summaryMessage = `❌ Campaign failed (0/${leads.length} delivered): ${primaryFailureReason}`;
    } else if (isAllowedListFailure) {
      summaryMessage = `⚠️ Partial delivery: ${successCount}/${leads.length} sent. ${failures.length} failed because their numbers are not in your Meta Developer allowed list (Test Account restriction).`;
    } else {
      summaryMessage = `⚠️ Partial delivery: ${successCount}/${leads.length} sent, ${failures.length} failed. ${primaryFailureReason}`;
    }

    return res.status(200).json({
      success: !noneSent,
      message: summaryMessage,
      campaign_id: campaignId,
      total_targeted: leads.length,
      total_sent: successCount,
      total_failed: failures.length,
      failed_details: failures.slice(0, 5),
    });
  } catch (err) {
    console.error('[Campaign] Unexpected Error:', err?.message, err?.stack);
    return res.status(500).json({
      success: false,
      message: err?.message || 'Internal server error',
    });
  }
}

// ═════════════════════════════════════════════════════════════════════
// POST /api/campaigns/upload-pdf
// Uploads a campaign PDF document to Supabase Storage and returns public URL
// ═════════════════════════════════════════════════════════════════════
export async function uploadCampaignPdf(req, res) {
  try {
    const { user, error: authError } = await authenticateRequest(req);
    if (authError || !user) {
      return res.status(401).json({ success: false, message: 'Unauthorized — please log in again.' });
    }

    const { base64, fileName } = req.body;
    if (!base64) {
      return res.status(400).json({ success: false, message: 'No file content provided' });
    }

    const tenantId = user.id;
    const cleanFileName = (fileName || 'campaign_document.pdf')
      .replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${tenantId}/${Date.now()}_${cleanFileName}`;
    const fileBuffer = Buffer.from(base64, 'base64');

    const { data, error } = await supabase.storage
      .from('campaign-assets')
      .upload(storagePath, fileBuffer, {
        contentType: 'application/pdf',
        upsert: true,
      });

    if (error) {
      console.error('[Campaign PDF Upload] Storage error:', error);
      return res.status(500).json({ success: false, message: error.message });
    }

    const { data: publicUrlData } = supabase.storage
      .from('campaign-assets')
      .getPublicUrl(storagePath);

    return res.status(200).json({
      success: true,
      url: publicUrlData.publicUrl,
      fileName: cleanFileName,
    });
  } catch (err) {
    console.error('[Campaign PDF Upload] Exception:', err);
    return res.status(500).json({ success: false, message: err?.message || 'Server error' });
  }
}

