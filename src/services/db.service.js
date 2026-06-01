import { supabase } from '../config/supabase.js';
import { env } from '../config/env.js';

// Module-level cache to hold the default tenant UUID once resolved, minimizing redundant database select operations
let defaultTenantId = null;

/**
 * Ensures a default tenant exists in the database.
 * Fetches the tenant with email 'admin@detailing.com' or creates it if not found.
 * @returns {Promise<string>} The default tenant ID.
 */
export async function ensureDefaultTenant() {
  if (defaultTenantId) return defaultTenantId;

  try {
    // 1. Try to find the default tenant by email
    const { data: existing, error: selectError } = await supabase
      .from('tenants')
      .select('id')
      .eq('owner_email', 'admin@detailing.com')
      .limit(1)
      .single();

    if (existing) {
      defaultTenantId = existing.id;
      return defaultTenantId;
    }

    // 2. If not found, create a new default tenant
    const { data: inserted, error: insertError } = await supabase
      .from('tenants')
      .insert({
        business_name: 'Premium Car Detailing Shop',
        owner_email: 'admin@detailing.com',
        whatsapp_phone_number_id: env.WHATSAPP_PHONE_NUMBER_ID,
        whatsapp_access_token: env.META_ACCESS_TOKEN
      })
      .select('id')
      .single();

    if (insertError) {
      console.error('[Supabase] ❌ Error creating default tenant:', insertError.message);
      throw insertError;
    }

    defaultTenantId = inserted.id;
    console.log(`[Supabase] 🆕 Created default tenant: ${defaultTenantId}`);
    return defaultTenantId;
  } catch (err) {
    console.error('[Supabase] ❌ Failed to ensure default tenant:', err.message || err);
    throw err;
  }
}

/**
 * Resolves or creates a conversation for a phone number.
 * @param {string} phone - Customer phone number.
 * @param {string} name - Customer name.
 * @returns {Promise<string>} The conversation ID.
 */
export async function resolveConversation(phone, name, tenantId = null) {
  const resolvedTenantId = tenantId || await ensureDefaultTenant();

  // 1. Try to find an existing active conversation for this phone number
  const { data: existing, error: selectError } = await supabase
    .from('conversations')
    .select('id')
    .eq('tenant_id', resolvedTenantId)
    .eq('customer_phone', phone)
    .limit(1)
    .single();

  if (existing) {
    return existing.id;
  }

  if (selectError && selectError.code !== 'PGRST116') {
    // PGRST116 is PostgreSQL's row-not-found code, which is standard when starting a new chat
    console.error('[Supabase] ❌ Error looking up conversation:', selectError.message);
  }

  // 2. If no conversation exists, insert a new one
  const { data: inserted, error: insertError } = await supabase
    .from('conversations')
    .insert({ tenant_id: resolvedTenantId, customer_phone: phone, customer_name: name })
    .select('id')
    .single();

  if (insertError) {
    console.error('[Supabase] ❌ Error creating conversation:', insertError.message);
    throw insertError;
  }

  console.log(`[Supabase] 🆕 Created new conversation ${inserted.id} for ${phone}`);
  return inserted.id;
}

/**
 * Retrieves conversation metadata (specifically tenant_id) by conversation ID.
 * @param {string} conversationId 
 * @returns {Promise<object>} The conversation data.
 */
export async function getConversationMetadata(conversationId) {
  const { data, error } = await supabase
    .from('conversations')
    .select('tenant_id')
    .eq('id', conversationId)
    .single();

  if (error) {
    throw new Error(`Failed to retrieve conversation metadata: ${error.message}`);
  }
  return data;
}

/**
 * Retrieves the base system prompt instructions for a given tenant.
 * @param {string} tenantId 
 * @returns {Promise<string>} The base system instruction string.
 */
export async function getTenantInstruction(tenantId) {
  const { data, error } = await supabase
    .from('tenants')
    .select('ai_system_instruction')
    .eq('id', tenantId)
    .single();

  if (error) {
    console.error(`[Supabase] ❌ Error fetching tenant instruction for tenant ${tenantId}:`, error.message);
    return '';
  }
  return data?.ai_system_instruction || '';
}

/**
 * Retrieves the knowledge base FAQs for a given tenant.
 * @param {string} tenantId 
 * @returns {Promise<Array>} List of FAQs containing question and answer properties.
 */
export async function getKnowledgeBaseFaqs(tenantId) {
  const { data, error } = await supabase
    .from('knowledge_base')
    .select('question, answer')
    .eq('tenant_id', tenantId);

  if (error) {
    console.error(`[Supabase] ❌ Error fetching knowledge base FAQs for tenant ${tenantId}:`, error.message);
    return [];
  }
  return data || [];
}

/**
 * Inserts a single message row into the messages table.
 * @param {string} conversationId 
 * @param {string} sender - 'user' or 'model'
 * @param {string} text - Message body content
 */
export async function insertMessage(conversationId, sender, text, tenantId = null) {
  const resolvedTenantId = tenantId || await ensureDefaultTenant();

  // Normalize sender naming between Gemini terminology ('user' / 'model') and Supabase schema ('customer' / 'ai')
  let dbSender = sender;
  if (sender === 'user') dbSender = 'customer';
  else if (sender === 'model') dbSender = 'ai';

  const { error } = await supabase
    .from('messages')
    .insert({
      conversation_id: conversationId,
      tenant_id: resolvedTenantId,
      sender: dbSender,
      message_text: text
    });

  if (error) {
    console.error(`[Supabase] ❌ Error inserting ${sender} message:`, error.message);
  }
}

/**
 * Fetches recent chronologically sorted messages for a conversation.
 * Fixed to sort by created_at descending to get the actual *latest* messages,
 * and then reverses the array to return them in chronological (ascending) order.
 * @param {string} conversationId 
 * @param {number} limit 
 * @returns {Promise<Array>} Chronological recent message objects.
 */
export async function getRecentMessages(conversationId, limit = 4) {
  const { data, error } = await supabase
    .from('messages')
    .select('sender, message_text')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[Supabase] ❌ Error fetching message history:', error.message);
    return [];
  }

  // Reverse the array to put it back in ascending order (chronological order)
  return (data || []).reverse();
}

/**
 * Inserts a captured customer lead into the database.
 * @param {object} leadData - Lead details
 */
export async function insertLead(leadData) {
  const { error } = await supabase
    .from('leads')
    .insert(leadData);

  if (error) {
    console.error('[Supabase] ❌ Error inserting lead into database:', error.message);
    throw error;
  }
}

/**
 * Deletes the last customer message for a conversation, serving as a database rollback
 * in case a downstream service (like the LLM call) fails completely.
 * @param {string} conversationId 
 * @param {string} text 
 */
export async function deleteLastCustomerMessage(conversationId, text) {
  const { error } = await supabase
    .from('messages')
    .delete()
    .eq('conversation_id', conversationId)
    .eq('sender', 'customer')
    .eq('message_text', text)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    console.error('[Supabase] ❌ Error deleting message during rollback:', error.message);
  }
}

/*
=========================================
FILE: src/services/db.service.js
=========================================
DESCRIPTION:
This service file contains all persistent operations interacting with Supabase.
By centralizing queries and data modification calls here, we decouple database-specific
schema definitions and SQL-like execution from routing controllers and business logic.

WORKFLOW:
1. Imports the configured Supabase client from 'src/config/supabase.js'.
2. Exposes methods for tenant extraction, conversation resolution, message audits,
   chronological history recovery, and lead persistence.
3. Automatically maps external service roles ('user'/'model') to database representations
   ('customer'/'ai') during message inserts to guarantee data integrity.
4. Correctly implements latest-message context fetching: sorts by created_at descending
   to grab the actual last N messages, then reverses them chronologically for the LLM.

CONNECTION TO OTHER FILES:
- Imports configurations and clients from src/config/supabase.js and src/config/env.js.
- Exported functions are consumed by src/services/ai.service.js to fetch system prompts,
  FAQs, message histories, and to insert model results or log new leads.
- Consumption also occurs in src/controllers/webhook.controller.js for setting up
  conversations and auditing text events.
=========================================
*/
