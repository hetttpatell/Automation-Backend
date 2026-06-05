import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import webhookRouter from './routes/webhook.routes.js';
import calendarRouter from './routes/calendar.routes.js';
import razorpayRouter from './routes/razorpay.routes.js';

// Instantiate Express application
const app = express();

// Enable Cross-Origin Resource Sharing (CORS) globally to allow frontend connections
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));

// Parse incoming payloads containing JSON format, essential for Meta's POST notifications
app.use(express.json());

// Global error handling middleware to gracefully intercept malformed JSON inputs and prevent crashes
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('❌ Malformed JSON payload received:', err.message);
    return res.status(400).send({ error: 'Malformed JSON payload' });
  }
  next();
});

/**
 * Health check endpoint to verify web service availability and operational state.
 */
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Bind routers containing our GET and POST pathways
app.use(webhookRouter);
app.use(calendarRouter);
app.use(razorpayRouter);

// Initialize the Auto-Review Reputation Engine cron worker
import { initReputationCron } from './services/reputation.service.js';
initReputationCron();

// Start listening for inbound connections on the configured HTTP Port
app.listen(env.PORT, () => {
  console.log(`===================================================`);
  console.log(`🚀 WhatsApp Cloud API Webhook Server is running!`);
  console.log(`📡 Port: ${env.PORT}`);
  console.log(`🔗 Webhook GET/POST URL: http://localhost:${env.PORT}/webhook/whatsapp`);
  console.log(`🔒 Verify Token Configured: ${env.META_WEBHOOK_VERIFY_TOKEN ? 'YES (Secure)' : 'NO (Action Required: Set META_WEBHOOK_VERIFY_TOKEN in .env)'}`);
  console.log(`===================================================`);
});

/*
=========================================
FILE: src/server.js
=========================================
DESCRIPTION:
This file serves as the main entry point and bootstrap script for our production Express application.
It sets up global HTTP servers, configures vital body parsers, CORS filters, health-check pathways, 
binds our modular webhook routes, and handles runtime listener configurations.

WORKFLOW:
1. Imports Express framework, CORS, env variables, and webhook router middleware.
2. Registers global middleware: CORS controls, JSON parsers, and custom safety error handlers.
3. Defines a public `/health` endpoint to monitor operational statuses.
4. Mounts the webhook routes mapped from 'webhook.routes.js'.
5. Starts the HTTP server binding on the validated port, logging availability details.

CONNECTION TO OTHER FILES:
- Imports configuration settings from src/config/env.js.
- Imports and registers src/routes/webhook.routes.js to expose WhatsApp communication channels.
- Configured as the main entrypoint file in package.json.
=========================================
*/
