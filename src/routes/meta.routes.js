import { Router } from 'express';
import { exchangeToken } from '../controllers/meta.controller.js';

const router = Router();

// Route: POST /api/meta/exchange-token
// Exchanges client-side short-lived token for long-lived credentials and retrieves WABA info.
router.post('/api/meta/exchange-token', exchangeToken);

export default router;
