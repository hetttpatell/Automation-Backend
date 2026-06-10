import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import { env } from '../config/env.js';

// ─── Supabase Admin Client ──────────────────────────────────────────
const supabase = createClient(
  env.SUPABASE_URL || '',
  env.SUPABASE_SERVICE_ROLE_KEY || ''
);

// ─── Razorpay SDK Instance ──────────────────────────────────────────
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ─── Pack definitions for credit top-ups ────────────────────────────
const PACKS = {
  mini: { amount: 49900, credits: 500 },     // ₹499 = 49900 Paisa
  pro: { amount: 89900, credits: 1000 },      // ₹899 = 89900 Paisa
  mega: { amount: 199900, credits: 2500 },    // ₹1,999 = 199900 Paisa
};

// ─── Plan ID mapping for subscriptions ──────────────────────────────
const PLAN_MAPPING = {
  starter: process.env.RAZORPAY_PLAN_STARTER,
  growth: process.env.RAZORPAY_PLAN_GROWTH,
  domination: process.env.RAZORPAY_PLAN_DOMINATION,
};

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
// POST /api/razorpay/webhook
// Handles incoming Razorpay webhook events (signature-verified, no auth)
// ═════════════════════════════════════════════════════════════════════
export async function handleRazorpayWebhook(req, res) {
  const signature = req.headers['x-razorpay-signature'] || '';
  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const secret = env.RAZORPAY_WEBHOOK_SECRET || '';

  try {
    if (!signature) {
      console.error('[Razorpay Webhook] Missing x-razorpay-signature header.');
      return res.status(400).json({ error: 'Missing signature' });
    }

    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');
    const isValid = signature === expectedSignature;

    if (!isValid) {
      console.error('[Razorpay Webhook] Signature verification failed.');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const event = payload.event;
    console.log(`[Razorpay Webhook] Signature valid. Processing event: ${event}`);

    // ── subscription.charged ─────────────────────────────────────────
    if (event === 'subscription.charged') {
      const subscription = payload.payload.subscription.entity;
      const notes = subscription.notes || {};
      const tenantId = notes.tenant_id;
      const notesTier = notes.subscription_tier || '';

      if (!tenantId) {
        console.error('[Razorpay Webhook] tenant_id missing from subscription notes.');
        return res.status(400).json({ error: 'Missing tenant_id in notes' });
      }

      // Map tier to credits balance and limit allocations
      let tier = 'free';
      let baseCredits = 50;

      if (notesTier === 'starter') {
        tier = 'starter';
        baseCredits = 500;
      } else if (notesTier === 'growth' || notesTier === 'pro') {
        tier = 'growth';
        baseCredits = 2500;
      } else if (notesTier === 'domination') {
        tier = 'domination';
        baseCredits = 10000;
      } else {
        // Fallback mapping based on Razorpay plan ID
        const planId = subscription.plan_id;
        if (planId?.includes('starter')) {
          tier = 'starter';
          baseCredits = 500;
        } else if (planId?.includes('growth') || planId?.includes('pro') || planId === process.env.RAZORPAY_PLAN_GROWTH) {
          tier = 'growth';
          baseCredits = 2500;
        } else if (planId?.includes('domination')) {
          tier = 'domination';
          baseCredits = 10000;
        }
      }

      console.log(`[Razorpay Webhook] Refilling credits for tenant: ${tenantId}. Tier: ${tier}, Credits: ${baseCredits}`);

      const { error: updateError } = await supabase
        .from('tenants')
        .update({
          subscription_tier: tier,
          subscription_status: 'active',
          ai_credits_balance: baseCredits,
          ai_credits_limit: baseCredits,
          razorpay_subscription_id: subscription.id,
        })
        .eq('id', tenantId);

      if (updateError) {
        console.error(`[Razorpay Webhook] Supabase update failed:`, updateError.message);
        return res.status(500).json({ error: 'Database update failed' });
      }
    }
    // ── order.paid / payment.captured ────────────────────────────────
    else if (event === 'order.paid' || event === 'payment.captured') {
      let entity = null;
      if (event === 'order.paid') {
        entity = payload.payload.order.entity;
      } else {
        entity = payload.payload.payment.entity;
      }

      if (!entity) {
        return res.status(400).json({ error: 'Missing entity payload' });
      }

      const notes = entity.notes || {};
      const tenantId = notes.tenant_id;
      const purchaseType = notes.purchase_type;
      const creditAmount = parseInt(notes.credit_amount || '0', 10);

      if (purchaseType === 'top_up' && tenantId && creditAmount > 0) {
        console.log(`[Razorpay Webhook] Incrementing credits for tenant ${tenantId} by ${creditAmount}`);

        // Execute atomic increment in PostgreSQL
        const { data: newBalance, error: rpcError } = await supabase.rpc('increment_tenant_credits', {
          tenant_id: tenantId,
          amount: creditAmount,
        });

        if (rpcError) {
          console.error('[Razorpay Webhook] RPC credits increment failed. Attempting fallback direct update.', rpcError.message);

          // Fallback direct mathematical increment
          const { data: tenant } = await supabase
            .from('tenants')
            .select('ai_credits_balance, ai_credits_limit')
            .eq('id', tenantId)
            .single();

          if (tenant) {
            const currentBalance = tenant.ai_credits_balance || 0;
            const currentLimit = tenant.ai_credits_limit || 0;
            await supabase
              .from('tenants')
              .update({
                ai_credits_balance: currentBalance + creditAmount,
                ai_credits_limit: currentLimit + creditAmount,
              })
              .eq('id', tenantId);
          }
        } else {
          console.log(`[Razorpay Webhook] Atomic increment completed successfully. New balance: ${newBalance}`);
        }
      }
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[Razorpay Webhook Error]:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

// ═════════════════════════════════════════════════════════════════════
// POST /api/razorpay/create-order
// Creates a Razorpay order for credit top-up purchases (authenticated)
// ═════════════════════════════════════════════════════════════════════
export async function createOrder(req, res) {
  try {
    // Authenticate via Bearer token
    const { user, error: authError } = await authenticateRequest(req);
    if (authError || !user || !user.email) {
      return res.status(401).json({ error: 'Unauthorized user session.' });
    }

    const { packId } = req.body;
    if (!packId || !PACKS[packId]) {
      return res.status(400).json({ error: 'Invalid packId provided.' });
    }

    const pack = PACKS[packId];

    // Fetch user's tenant
    const { data: tenant, error: tenantError } = await supabase
      .from('tenants')
      .select('id')
      .eq('owner_email', user.email)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: 'Tenant not found.' });
    }

    console.log(`Creating Razorpay Order for top-up pack: ${packId} (${pack.credits} credits)`);

    // Create Order in Razorpay
    const order = await razorpay.orders.create({
      amount: pack.amount,
      currency: 'INR',
      notes: {
        tenant_id: tenant.id,
        purchase_type: 'top_up',
        credit_amount: String(pack.credits),
      },
    });

    return res.status(200).json({
      orderId: order.id,
      amount: pack.amount,
      credits: pack.credits,
    });
  } catch (error) {
    console.error('Order create error:', error);
    return res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
}

// ═════════════════════════════════════════════════════════════════════
// POST /api/razorpay/create-subscription
// Creates a Razorpay subscription for plan upgrades (authenticated)
// ═════════════════════════════════════════════════════════════════════
export async function createSubscription(req, res) {
  try {
    // Authenticate via Bearer token
    const { user, error: authError } = await authenticateRequest(req);
    if (authError || !user || !user.email) {
      return res.status(401).json({ error: 'Unauthorized user session.' });
    }

    const planType = req.body.planType || req.body.tier || req.body.planId;
    
    let planId;
    const normalizedPlanType = planType ? planType.toLowerCase() : '';
    
    switch (normalizedPlanType) {
        case 'starter':
            planId = process.env.RAZORPAY_PLAN_STARTER;
            break;
        case 'pro':
        case 'growth':
            planId = process.env.RAZORPAY_PLAN_GROWTH;
            break;
        case 'domination':
            planId = process.env.RAZORPAY_PLAN_DOMINATION;
            break;
        default:
            return res.status(400).json({ error: "Invalid plan type specified: " + planType });
    }

    if (!planId) {
        return res.status(500).json({ error: `Razorpay Plan ID for ${planType} is not configured on the server.` });
    }

    // Fetch user's tenant
    const { data: tenant, error: tenantError } = await supabase
      .from('tenants')
      .select('id, business_name, owner_email, razorpay_customer_id')
      .eq('owner_email', user.email)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: 'Tenant not found.' });
    }

    let customerId = tenant.razorpay_customer_id;

    // Create Razorpay Customer if it doesn't exist yet
    if (!customerId) {
      const customerName = tenant.business_name || tenant.owner_email || user.email || 'Business Owner';
      const customerEmail = tenant.owner_email || user.email || '';
      console.log(`Creating Razorpay Customer for business name: ${customerName}`);
      try {
        // Attempt to create a new customer
        const newCustomer = await razorpay.customers.create({
          name: customerName,
          email: customerEmail,
        });
        customerId = newCustomer.id;
        console.log(`[Razorpay] Created new customer: ${customerId}`);

        // Save Customer ID in Supabase
        await supabase
          .from('tenants')
          .update({ razorpay_customer_id: customerId })
          .eq('id', tenant.id);
      } catch (err) {
        // Check if the error is specifically because the customer already exists
        if (err.error && err.error.description === 'Customer already exists for the merchant') {
          console.log("[Razorpay] Customer already exists. Fetching existing customer profile...");
          
          // Fetch the existing customer using their email
          const existingCustomers = await razorpay.customers.all({ email: customerEmail });
          
          if (existingCustomers && existingCustomers.items && existingCustomers.items.length > 0) {
            customerId = existingCustomers.items[0].id;
            console.log(`[Razorpay] Successfully retrieved existing customer: ${customerId}`);

            // Save Customer ID in Supabase
            await supabase
              .from('tenants')
              .update({ razorpay_customer_id: customerId })
              .eq('id', tenant.id);
          } else {
            console.error("[Razorpay FATAL] Customer exists but could not be fetched by email.");
            return res.status(500).json({ error: "Failed to retrieve existing payment profile." });
          }
        } else {
          // If it's a different Razorpay error, log it and fail
          console.error("[Razorpay ERROR] Failed to create customer:", JSON.stringify(err, null, 2));
          return res.status(500).json({ error: 'Failed to create payment customer context.' });
        }
      }
    }

    // Create Subscription in Razorpay
    console.log(`Creating Razorpay Subscription for plan: ${planType} (${planId})`);

    const subscription = await razorpay.subscriptions.create({
      plan_id: planId,
      total_count: 12,
      customer_notify: 1,
      notes: {
        tenant_id: tenant.id,
        subscription_tier: (normalizedPlanType === 'pro' || normalizedPlanType === 'growth') ? 'growth' : normalizedPlanType,
      },
    });

    return res.status(200).json(subscription);
  } catch (error) {
    console.error('Subscription create error:', error);
    return res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
}

// ═════════════════════════════════════════════════════════════════════
// POST /api/razorpay/verify
// Cryptographically verifies payment signature & fulfills DB record in Supabase
// ═════════════════════════════════════════════════════════════════════
export async function verifyPayment(req, res) {
  try {
    const {
      razorpay_payment_id,
      razorpay_signature,
      razorpay_subscription_id,
      razorpay_order_id,
      planType,
      userId
    } = req.body;

    // 1. Signature Verification
    const secret = process.env.RAZORPAY_KEY_SECRET;
    let bodyToSign = "";

    if (razorpay_subscription_id) {
      bodyToSign = razorpay_payment_id + '|' + razorpay_subscription_id;
    } else if (razorpay_order_id) {
      bodyToSign = razorpay_order_id + '|' + razorpay_payment_id;
    } else {
      return res.status(400).json({ error: "Missing subscription or order ID" });
    }

    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(bodyToSign)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      console.error('[Razorpay Verification] Cryptographic verification failed.');
      return res.status(400).json({ error: "Cryptographic verification failed. Invalid signature." });
    }

    console.log('[Razorpay Verification] Signature verified successfully.');

    // 2. Resolve Tenant ID
    let tenantId = userId;
    let ownerEmail = null;

    // Try to authenticate via Bearer token first
    const { user, error: authError } = await authenticateRequest(req);
    if (!authError && user && user.email) {
      ownerEmail = user.email;
    }

    let tenant = null;
    if (ownerEmail) {
      const { data, error } = await supabase
        .from('tenants')
        .select('id, subscription_tier, ai_credits_balance, ai_credits_limit')
        .eq('owner_email', ownerEmail)
        .single();
      if (!error && data) {
        tenant = data;
        tenantId = data.id;
      }
    } else if (tenantId) {
      const { data, error } = await supabase
        .from('tenants')
        .select('id, subscription_tier, ai_credits_balance, ai_credits_limit')
        .eq('id', tenantId)
        .single();
      if (!error && data) {
        tenant = data;
      }
    }

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant record not found.' });
    }

    // 3. Fulfill purchase dynamically
    if (razorpay_subscription_id) {
      // Monthly Subscription upgrade
      const normalizedPlanType = planType ? planType.toLowerCase() : '';
      let tier = 'free';
      let baseCredits = 50;

      if (normalizedPlanType === 'starter') {
        tier = 'starter';
        baseCredits = 500;
      } else if (normalizedPlanType === 'growth' || normalizedPlanType === 'pro') {
        tier = 'growth';
        baseCredits = 2500;
      } else if (normalizedPlanType === 'domination') {
        tier = 'domination';
        baseCredits = 10000;
      } else {
        // Retrieve subscription details from Razorpay if planType is unspecified
        try {
          const subscription = await razorpay.subscriptions.fetch(razorpay_subscription_id);
          const planId = subscription.plan_id;
          if (planId?.includes('starter')) {
            tier = 'starter';
            baseCredits = 500;
          } else if (planId?.includes('growth') || planId?.includes('pro') || planId === process.env.RAZORPAY_PLAN_GROWTH) {
            tier = 'growth';
            baseCredits = 2500;
          } else if (planId?.includes('domination')) {
            tier = 'domination';
            baseCredits = 10000;
          }
        } catch (fetchErr) {
          console.error('[Razorpay Verification] Failed to fetch subscription details from Razorpay:', fetchErr);
        }
      }

      console.log(`[Razorpay Verification] Updating tenant ${tenantId} to Subscription Tier: ${tier}, Credits: ${baseCredits}`);

      const { error: updateError } = await supabase
        .from('tenants')
        .update({
          subscription_tier: tier,
          subscription_status: 'active',
          ai_credits_balance: baseCredits,
          ai_credits_limit: baseCredits,
          razorpay_subscription_id: razorpay_subscription_id,
        })
        .eq('id', tenantId);

      if (updateError) {
        console.error(`[Razorpay Verification] Supabase update failed:`, updateError.message);
        return res.status(500).json({ error: 'Database update failed' });
      }

      return res.status(200).json({
        success: true,
        message: `Subscription successfully verified and upgraded to ${tier}.`,
        subscription_tier: tier,
        ai_credits_balance: baseCredits,
      });

    } else if (razorpay_order_id) {
      // One-Time Credit Top-Up
      let creditAmount = 0;
      try {
        const orderDetails = await razorpay.orders.fetch(razorpay_order_id);
        const notes = orderDetails.notes || {};
        creditAmount = parseInt(notes.credit_amount || '0', 10);
      } catch (fetchErr) {
        console.warn('[Razorpay Verification] Failed to fetch order details from Razorpay, falling back to body params.', fetchErr);
      }

      // Fallback to packId / planType mapping
      if (creditAmount === 0) {
        const packId = planType; // Frontend passes packId
        if (packId && PACKS[packId]) {
          creditAmount = PACKS[packId].credits;
        }
      }

      if (creditAmount <= 0) {
        return res.status(400).json({ error: 'Could not determine credit amount for top-up.' });
      }

      console.log(`[Razorpay Verification] Incrementing credits for tenant ${tenantId} by ${creditAmount}`);

      const { data: newBalance, error: rpcError } = await supabase.rpc('increment_tenant_credits', {
        tenant_id: tenantId,
        amount: creditAmount,
      });

      let finalBalance = newBalance;

      if (rpcError) {
        console.warn('[Razorpay Verification] RPC increment failed, falling back to direct update.', rpcError.message);
        
        // Direct mathematical update fallback
        const { data: tenantData } = await supabase
          .from('tenants')
          .select('ai_credits_balance, ai_credits_limit')
          .eq('id', tenantId)
          .single();

        if (tenantData) {
          const currentBalance = tenantData.ai_credits_balance || 0;
          const currentLimit = tenantData.ai_credits_limit || 0;
          finalBalance = currentBalance + creditAmount;

          const { error: fallbackError } = await supabase
            .from('tenants')
            .update({
              ai_credits_balance: finalBalance,
              ai_credits_limit: currentLimit + creditAmount,
            })
            .eq('id', tenantId);

          if (fallbackError) {
            console.error('[Razorpay Verification] Fallback update failed:', fallbackError.message);
            return res.status(500).json({ error: 'Database update failed' });
          }
        } else {
          return res.status(404).json({ error: 'Tenant record not found for update' });
        }
      }

      return res.status(200).json({
        success: true,
        message: `Credits successfully verified and topped up by ${creditAmount}.`,
        ai_credits_balance: finalBalance,
      });
    }

  } catch (error) {
    console.error('[Razorpay Verification Error]:', error);
    return res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
}
