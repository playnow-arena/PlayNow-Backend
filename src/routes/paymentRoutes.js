const express = require('express');
const router = express.Router();
const {
  createRazorpayOrder,
  verifyRazorpayPayment
} = require('../controllers/paymentController');
const { protect } = require('../middleware/authMiddleware');

// FIX 3 (B1): Require authentication for creating orders and verifying payments
router.route('/create-order')
  .post(protect, createRazorpayOrder);

router.route('/verify-payment')
  .post(protect, verifyRazorpayPayment);

module.exports = router;
