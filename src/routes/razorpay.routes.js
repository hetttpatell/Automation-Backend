import { Router } from 'express';
import express from 'express';
import {
  handleRazorpayWebhook,
  createOrder,
  createSubscription
} from '../controllers/razorpay.controller.js';

const router = Router();

// Route: POST /api/razorpay/webhook
// Razorpay sends webhook events here. No auth — signature-verified by the controller.
// Uses raw body parser for accurate HMAC signature verification.
router.post(
  '/api/razorpay/webhook',
  express.raw({ type: 'application/json' }),
  (req, res, next) => {
    // Convert raw Buffer to string for signature verification
    if (Buffer.isBuffer(req.body)) {
      req.rawBody = req.body.toString('utf8');
      req.body = JSON.parse(req.rawBody);
    }
    next();
  },
  handleRazorpayWebhook
);

// Route: POST /api/razorpay/create-order
// Creates a Razorpay order for one-time credit top-up purchases. Requires Bearer token auth.
router.post('/api/razorpay/create-order', createOrder);

// Route: POST /api/razorpay/create-subscription (and alias /api/payments/create-subscription)
// Creates a Razorpay subscription for monthly plan upgrades. Requires Bearer token auth.
router.post('/api/razorpay/create-subscription', createSubscription);
router.post('/api/payments/create-subscription', createSubscription);

export default router;
