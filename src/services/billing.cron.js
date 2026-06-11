import cron from 'node-cron';
import { supabase } from '../config/supabase.js';

// ─── Constants ──────────────────────────────────────────────────────
const GRACE_PERIOD_DAYS = 3;
const FREE_TIER_CREDITS = 50;

/**
 * Checks all non-free tenants whose billing cycle has expired.
 *
 * Two-phase enforcement:
 *   Phase 1 — billing_cycle_end has passed, but no grace period started yet.
 *             Sets billing_grace_period_end = NOW + 3 days. This gives Razorpay's
 *             automatic retry window time to land a successful subscription.charged.
 *
 *   Phase 2 — billing_grace_period_end has also passed (3 days of grace exhausted).
 *             Hard-downgrades the tenant to the free plan, resets tokens/credits,
 *             and clears all billing cycle fields.
 */
export async function checkBillingCycleExpiry() {
  const now = new Date().toISOString();

  console.log(`[Billing Cron] 🕒 Running billing cycle expiry check at ${now}`);

  // ── Query all non-free tenants whose billing_cycle_end has passed ──
  const { data: expiredTenants, error } = await supabase
    .from('tenants')
    .select('id, owner_email, subscription_tier, billing_cycle_end, billing_grace_period_end')
    .neq('subscription_tier', 'free')
    .not('billing_cycle_end', 'is', null)
    .lt('billing_cycle_end', now);

  if (error) {
    console.error('[Billing Cron] ❌ Error querying expired tenants:', error.message);
    return;
  }

  if (!expiredTenants || expiredTenants.length === 0) {
    console.log('[Billing Cron] ✅ No expired billing cycles found. All clear.');
    return;
  }

  console.log(`[Billing Cron] ⚠️ Found ${expiredTenants.length} tenant(s) with expired billing cycles.`);

  for (const tenant of expiredTenants) {
    try {
      // ── Phase 1: Start grace period ───────────────────────────────
      if (!tenant.billing_grace_period_end) {
        const graceEnd = new Date();
        graceEnd.setDate(graceEnd.getDate() + GRACE_PERIOD_DAYS);

        console.log(
          `[Billing Cron] ⏳ Tenant ${tenant.id} (${tenant.owner_email}) — billing cycle expired. ` +
          `Starting ${GRACE_PERIOD_DAYS}-day grace period until ${graceEnd.toISOString()}.`
        );

        const { error: graceError } = await supabase
          .from('tenants')
          .update({ billing_grace_period_end: graceEnd.toISOString() })
          .eq('id', tenant.id);

        if (graceError) {
          console.error(`[Billing Cron] ❌ Failed to set grace period for tenant ${tenant.id}:`, graceError.message);
        }

        continue; // Don't downgrade yet — grace period just started
      }

      // ── Phase 2: Grace period expired → hard downgrade ────────────
      const graceDeadline = new Date(tenant.billing_grace_period_end);

      if (new Date() <= graceDeadline) {
        console.log(
          `[Billing Cron] ⏳ Tenant ${tenant.id} (${tenant.owner_email}) — still within grace period ` +
          `(expires ${graceDeadline.toISOString()}). Skipping downgrade.`
        );
        continue;
      }

      console.log(
        `[Billing Cron] 🔻 Tenant ${tenant.id} (${tenant.owner_email}) — grace period expired. ` +
        `Downgrading from '${tenant.subscription_tier}' to 'free'.`
      );

      const { error: downgradeError } = await supabase
        .from('tenants')
        .update({
          // Tier & status
          subscription_tier: 'free',
          plan_type: 'free',
          planType: 'free',
          subscription_status: 'expired',

          // Reset tokens/credits to free-tier defaults
          tokens: FREE_TIER_CREDITS,
          ai_credits_balance: FREE_TIER_CREDITS,
          ai_credits_limit: FREE_TIER_CREDITS,

          // Clear billing cycle fields
          billing_cycle_start: null,
          billingCycleStart: null,
          billing_cycle_end: null,
          billingCycleEnd: null,
          billing_grace_period_end: null,
        })
        .eq('id', tenant.id);

      if (downgradeError) {
        console.error(`[Billing Cron] ❌ Failed to downgrade tenant ${tenant.id}:`, downgradeError.message);
      } else {
        console.log(`[Billing Cron] ✅ Tenant ${tenant.id} successfully downgraded to free plan.`);
      }
    } catch (err) {
      console.error(`[Billing Cron] ❌ Unexpected error processing tenant ${tenant.id}:`, err.message || err);
    }
  }
}

/**
 * Initializes the daily billing cycle enforcement cron.
 * Runs at 2:00 AM server time every day.
 */
export function initBillingCron() {
  console.log('[Billing Cron] 🚀 Daily billing cycle enforcement cron initialized!');

  // Schedule: every day at 2:00 AM
  cron.schedule('0 2 * * *', async () => {
    console.log('[Billing Cron] 🕒 Running scheduled daily billing cycle check...');
    try {
      await checkBillingCycleExpiry();
    } catch (err) {
      console.error('[Billing Cron] ❌ Error during scheduled billing cycle check:', err);
    }
  });

  // Run an initial check 10 seconds after server startup for immediate enforcement
  setTimeout(async () => {
    console.log('[Billing Cron] 🔎 Running initial startup billing cycle check...');
    try {
      await checkBillingCycleExpiry();
    } catch (err) {
      console.error('[Billing Cron] ❌ Startup billing cycle check failed:', err);
    }
  }, 10000);
}
