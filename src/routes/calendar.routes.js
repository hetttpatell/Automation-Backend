import { Router } from 'express';
import { redirectToAuth, calendarCallback } from '../controllers/calendar.controller.js';

const router = Router();

// Route: GET /api/calendar/auth
// Triggers the Google OAuth2.0 authentication consent flow.
router.get('/api/calendar/auth', redirectToAuth);

// Route: GET /api/calendar/callback
// Handles Google OAuth callback redirect, exchanges code for tokens, and redirects user.
router.get('/api/calendar/callback', calendarCallback);

export default router;
