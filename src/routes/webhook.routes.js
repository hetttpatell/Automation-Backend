import { Router } from 'express';
import { verifyWebhook, handleWebhookEvent, sendMessageFromHuman, getWhatsAppTemplates } from '../controllers/webhook.controller.js';
import { sendCampaign, uploadCampaignPdf } from '../controllers/campaign.controller.js';
import { parsePdfDocument } from '../controllers/document.controller.js';

// Instantiate Express Router instance
const router = Router();

// Route: GET /webhook/whatsapp
// Triggers validation logic for Meta Developer Portal webhooks verification challenge.
router.get('/webhook/whatsapp', verifyWebhook);

// Route: POST /webhook/whatsapp
// Triggers the processing of new inbound customer chat notifications.
router.post('/webhook/whatsapp', handleWebhookEvent);

// Route: POST /api/send-message
// Triggers manually sent human agent responses.
router.post('/api/send-message', sendMessageFromHuman);

// Route: GET /api/whatsapp/templates
// Fetches pre-approved WhatsApp message templates for a tenant.
router.get('/api/whatsapp/templates', getWhatsAppTemplates);

// Route: POST /api/campaigns/send
// Triggers outbound campaign blast messages to targeted lead segments.
router.post('/api/campaigns/send', sendCampaign);

// Route: POST /api/campaigns/upload-pdf
// Uploads PDF campaign document to Supabase storage.
router.post('/api/campaigns/upload-pdf', uploadCampaignPdf);

// Route: POST /api/parse-pdf
// Parses uploaded PDF documents, extracts tabular contacts and detects Name & Phone columns.
router.post('/api/parse-pdf', parsePdfDocument);

// Export router instance for application binding
export default router;

/*
=========================================
FILE: src/routes/webhook.routes.js
=========================================
DESCRIPTION:
This module declares and configures HTTP routes for Meta webhook endpoints,
mapping GET/POST requests on '/webhook/whatsapp' directly to controller methods.

WORKFLOW:
1. Instantiates a standard Express Router class.
2. Registers GET and POST pathways targeting '/webhook/whatsapp'.
3. Assigns 'verifyWebhook' as the callback handler for GET requests.
4. Assigns 'handleWebhookEvent' as the callback handler for POST requests.
5. Exports the router module.

CONNECTION TO OTHER FILES:
- Imports handlers from src/controllers/webhook.controller.js.
- Exported default router is imported and registered globally in src/server.js.
=========================================
*/
