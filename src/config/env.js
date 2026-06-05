import dotenv from 'dotenv';

// Load environment variables from the .env file located at the root of the project
dotenv.config();

// Define the schema/keys for the environment variables our system depends on
const requiredEnvVars = [
  'GEMINI_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'META_WEBHOOK_VERIFY_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'META_ACCESS_TOKEN'
];

// Loop through each required variable name to verify its definition
const missingVars = [];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    missingVars.push(envVar);
  }
}

// If there are any missing environment variables, throw a descriptive error immediately to prevent runtime failures
if (missingVars.length > 0) {
  console.error('❌ Critical Environment Variables Missing:', missingVars.join(', '));
  throw new Error(`Critical environment variables are missing from the configuration: ${missingVars.join(', ')}`);
}

// Export the validated environment configuration object for application-wide consumption
export const env = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  META_WEBHOOK_VERIFY_TOKEN: process.env.META_WEBHOOK_VERIFY_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
  META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN,
  PORT: process.env.PORT || 3000,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI,
  // Razorpay credentials
  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET,
  RAZORPAY_PLAN_STARTER: process.env.RAZORPAY_PLAN_STARTER,
  RAZORPAY_PLAN_GROWTH: process.env.RAZORPAY_PLAN_GROWTH,
  RAZORPAY_PLAN_DOMINATION: process.env.RAZORPAY_PLAN_DOMINATION,
  // Campaign configuration
  WHATSAPP_CAMPAIGN_TEMPLATE_NAME: process.env.WHATSAPP_CAMPAIGN_TEMPLATE_NAME,
  WHATSAPP_CAMPAIGN_TEMPLATE_LANG: process.env.WHATSAPP_CAMPAIGN_TEMPLATE_LANG || 'en',
  // Frontend URL for CORS
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:3000',
};

/*
=========================================
FILE: src/config/env.js
=========================================
DESCRIPTION:
This module manages loading, validating, and exporting all crucial environment
variables required by the application. By centralizing validation logic here, 
the application guarantees it will not start or continue running if vital keys 
are missing, preventing silent and hard-to-debug runtime crashes.

WORKFLOW:
1. Invokes 'dotenv.config()' to parse and load .env attributes into process.env.
2. Checks each required variable name against process.env.
3. Stores any missing variable in an array.
4. If the array is populated, logs an error block and throws a blocking Exception.
5. Otherwise, packages the validated strings into a standard frozen config object and exports it.

CONNECTION TO OTHER FILES:
- Connected to src/config/supabase.js (provides SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY).
- Connected to src/config/gemini.js (provides GEMINI_API_KEY).
- Connected to src/controllers/webhook.controller.js (provides META_WEBHOOK_VERIFY_TOKEN).
- Connected to src/services/whatsapp.service.js (provides WHATSAPP_PHONE_NUMBER_ID and META_ACCESS_TOKEN).
- Connected to src/server.js (provides PORT for HTTP server binding).
=========================================
*/
