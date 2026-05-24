const User = require('../models/User');
const jwt = require('jsonwebtoken');
const generatePlayNowId = require('../utils/generatePlayNowId');
const bcrypt = require('bcryptjs');
const admin = require('../config/firebaseAdmin');

// ── Mock OTP store (development fallback) ────────────────────────────────────
/** In-memory OTP store: Map<phone, { otp, expiresAt }> */
const otpStore = new Map();
const DEV_OTP       = '123456';
const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

// Generate JWT
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: '30d',
  });
};

// @desc    Register a new user
// @route   POST /api/auth/signup
// @access  Public
const signup = async (req, res) => {
  try {
    const { name, phone, email, password, role } = req.body;

    // Input validation
    if (!name || !password || (!email && !phone)) {
      return res.status(400).json({ message: 'Please provide name, password and either email or phone' });
    }

    const sanitizedEmail = email ? email.trim().toLowerCase() : undefined;
    const sanitizedPhone = phone ? phone.trim() : undefined;

    // Check if user exists
    const userExists = await User.findOne({ 
      $or: [
        ...(sanitizedEmail ? [{ email: sanitizedEmail }] : []),
        ...(sanitizedPhone ? [{ phone: sanitizedPhone }] : [])
      ] 
    });
    
    if (userExists) {
      return res.status(400).json({ message: 'User already exists with this email or phone' });
    }

    // Generate unique PlayNow ID
    const playNowId = await generatePlayNowId();

    // Create user
    const user = await User.create({
      name: name.trim(),
      phone: sanitizedPhone,
      email: sanitizedEmail,
      password,
      playNowId,
      role: role || 'player'
    });

    if (user) {
      res.status(201).json({
        _id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        playNowId: user.playNowId,
        role: user.role,
        token: generateToken(user._id),
      });
    } else {
      res.status(400).json({ message: 'Invalid user data' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Authenticate a user
// @route   POST /api/auth/login
// @access  Public
const login = async (req, res) => {
  try {
    const { email, phone, ownerId, password } = req.body;

    if (!password || (!email && !phone && !ownerId)) {
      return res.status(400).json({ message: 'Please provide credentials and password' });
    }

    // Check for user by email, phone, or ownerId
    let query = {};
    if (ownerId) {
      query = { ownerId: ownerId.trim() };
    } else if (email) {
      query = { email: email.trim().toLowerCase() };
    } else if (phone) {
      query = { phone: phone.trim() };
    }

    const user = await User.findOne(query).select('+password');

    if (user && (await user.matchPassword(password))) {
      res.json({
        _id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        playNowId: user.playNowId,
        ownerId: user.ownerId,
        role: user.role, // Use role instead of roles if model uses singular
        token: generateToken(user._id),
      });
    } else {
      res.status(401).json({ message: 'Invalid credentials' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Authenticate via Firebase Phone OTP (primary flow)
// @route   POST /api/auth/phone-auth
// @access  Public
const phoneAuth = async (req, res) => {
  try {
    const { idToken, name, profilePhoto } = req.body;

    if (!idToken) {
      return res.status(400).json({ message: 'Firebase ID Token is required' });
    }

    // Verify the Firebase ID Token using Admin SDK
    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(idToken);
    } catch (err) {
      console.error('Firebase token verification failed:', err.message);
      return res.status(401).json({ message: 'Invalid or expired Firebase token. Please request a new OTP.' });
    }

    const { phone_number, uid } = decodedToken;

    if (!phone_number) {
      return res.status(400).json({ message: 'Phone number not found in Firebase token.' });
    }

    // Find existing user or create a new one
    let user      = await User.findOne({ $or: [{ phone: phone_number }, { firebaseId: uid }] });
    let isNewUser = false;

    if (!user) {
      isNewUser       = true;
      const playNowId = await generatePlayNowId();
      user = await User.create({
        name:         name ? name.trim() : `Player_${playNowId.split('-')[1]}`,
        phone:        phone_number,
        firebaseId:   uid,
        playNowId,
        profilePhoto: profilePhoto || 'default.jpg',
        role:         'player',
      });
    } else {
      // Sync firebaseId if this is the first OTP login for an existing user
      if (!user.firebaseId) {
        user.firebaseId = uid;
        await user.save();
      }
    }

    res.json({
      _id:       user.id,
      name:      user.name,
      phone:     user.phone,
      playNowId: user.playNowId,
      role:      user.role,
      isNewUser,
      token:     generateToken(user._id),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Mock OTP endpoints (development fallback) ─────────────────────────────────

// @desc    Send mock OTP — DEV fallback only
// @route   POST /api/auth/send-otp
const sendMockOtp = async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || String(phone).replace(/\D/g, '').length < 10) {
      return res.status(400).json({ message: 'Please provide a valid 10-digit phone number' });
    }
    const digits         = String(phone).replace(/\D/g, '').slice(-10);
    const formattedPhone = `+91${digits}`;
    otpStore.set(formattedPhone, { otp: DEV_OTP, expiresAt: Date.now() + OTP_EXPIRY_MS });
    console.log(`[DEV FALLBACK] OTP for ${formattedPhone}: ${DEV_OTP}`);
    res.json({
      success: true,
      message: 'Mock OTP sent (dev fallback)',
      devOtp:  process.env.NODE_ENV !== 'production' ? DEV_OTP : undefined,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Verify mock OTP — DEV fallback only
// @route   POST /api/auth/verify-otp
const verifyMockOtp = async (req, res) => {
  try {
    const { phone, otp, name } = req.body;
    if (!phone || !otp) return res.status(400).json({ message: 'Phone and OTP are required' });
    const digits         = String(phone).replace(/\D/g, '').slice(-10);
    const formattedPhone = `+91${digits}`;
    const stored         = otpStore.get(formattedPhone);
    if (!stored)                        return res.status(400).json({ message: 'OTP not found. Request a new one.' });
    if (Date.now() > stored.expiresAt)  { otpStore.delete(formattedPhone); return res.status(400).json({ message: 'OTP expired.' }); }
    if (stored.otp !== String(otp).trim()) return res.status(400).json({ message: 'Invalid OTP.' });
    otpStore.delete(formattedPhone);
    let user      = await User.findOne({ phone: formattedPhone });
    let isNewUser = false;
    if (!user) {
      isNewUser       = true;
      const playNowId = await generatePlayNowId();
      user = await User.create({ name: name ? name.trim() : `Player_${playNowId.split('-')[1]}`, phone: formattedPhone, playNowId, profilePhoto: 'default.jpg', role: 'player' });
    }
    res.json({ _id: user.id, name: user.name, phone: user.phone, playNowId: user.playNowId, role: user.role, isNewUser, token: generateToken(user._id) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get user data
// @route   GET /api/auth/me
// @access  Private
const getMe = async (req, res) => {
  try {
    // req.user is set in authMiddleware
    res.json(req.user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update user profile
// @route   PUT /api/auth/profile
// @access  Private
const updateProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.name = req.body.name || user.name;

    const updatedUser = await user.save();

    res.json({
      _id: updatedUser._id,
      name: updatedUser.name,
      phone: updatedUser.phone,
      playNowId: updatedUser.playNowId,
      role: updatedUser.role,
      token: generateToken(updatedUser._id),
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
module.exports = {
  signup,
  login,
  phoneAuth,
  sendMockOtp,
  verifyMockOtp,
  getMe,
  updateProfile,
};
