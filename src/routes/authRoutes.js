const express = require('express');
const router  = express.Router();

const {
  signup,
  login,
  phoneAuth,
  sendMockOtp,
  verifyMockOtp,
  getMe,
  updateProfile,
  updateProfileByPhone,
  forgotPassword,
  resetPassword,
} = require('../controllers/authController');

const { protect } = require('../middleware/authMiddleware');

// Standard credential routes
router.post('/signup', signup);
router.post('/login',  login);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);

// ── Firebase Phone OTP (primary) ─────────────────────────────────────────────
// Frontend: signInWithPhoneNumber → confirmationResult.confirm(otp) → idToken
// This endpoint verifies the idToken with Firebase Admin and returns a JWT.
router.post('/phone-auth', phoneAuth);

// ── Mock OTP routes (development fallback) ───────────────────────────────────
// Use when Firebase Admin credentials are not yet configured.
// Remove or disable these in production.
router.post('/send-otp',   sendMockOtp);
router.post('/verify-otp', verifyMockOtp);
// ─────────────────────────────────────────────────────────────────────────────

router.get('/me', protect, getMe);

router.put('/profile', protect, updateProfile);
router.put('/profile-by-phone', updateProfileByPhone);
module.exports = router;
