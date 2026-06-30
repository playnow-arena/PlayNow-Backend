const User = require('../models/User');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
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

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizePhone = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  const mobileDigits = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
  return /^[6-9]\d{9}$/.test(mobileDigits) ? `+91${mobileDigits}` : '';
};

const getPhoneVariants = (value) => {
  const rawValue = String(value || '').trim();
  const normalizedPhone = normalizePhone(rawValue);
  const digits = normalizedPhone.replace(/\D/g, '').slice(-10);
  const variants = [rawValue];

  if (digits.length === 10) {
    variants.push(digits, `+91${digits}`, `91${digits}`);
  }

  return [...new Set(variants.filter(Boolean))];
};

const duplicateMessageForError = (error) => {
  const duplicateField = Object.keys(error?.keyPattern || {})[0];
  if (duplicateField === 'username') return 'Username already taken';
  if (duplicateField === 'phone') return 'Phone number already registered';
  if (duplicateField === 'email') return 'Email already registered';
  if (duplicateField === 'playNowId') return 'Unable to generate a unique PlayNow ID. Please try again.';
  return 'An account already exists with these details. Please login.';
};

const normalizeUsername = (username) => String(username || '').trim().toLowerCase();
const isValidUsername = (username) => /^[a-z0-9._]{3,20}$/.test(username);
const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || '').trim().toLowerCase());

const findExistingByEmailOrPhone = async (email, phone) => {
  const clauses = [];
  if (email) clauses.push({ email: { $regex: `^${escapeRegex(email)}$`, $options: 'i' } });
  if (phone) clauses.push({ phone: { $in: getPhoneVariants(phone) } });
  if (!clauses.length) return null;
  return User.findOne({ $or: clauses });
};

const createUserWithGeneratedPlayNowId = async (userData, attempts = 3) => {
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await User.create({
        ...userData,
        playNowId: await generatePlayNowId()
      });
    } catch (error) {
      lastError = error;
      if (!(error?.code === 11000 && error?.keyPattern?.playNowId)) {
        throw error;
      }
    }
  }

  throw lastError;
};

// @desc    Register a new player user
// @route   POST /api/auth/signup
// @access  Public
const signup = async (req, res) => {
  try {
    const { name, username, phone, email, password, confirmPassword } = req.body;

    // Input validation
    if (!name || !username || !email || !phone || !password) {
      return res.status(400).json({ message: 'Please provide name, username, email, phone number, and password' });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }

    if (confirmPassword && password !== confirmPassword) {
      return res.status(400).json({ message: 'Passwords do not match' });
    }

    const sanitizedEmail = normalizeEmail(email);
    if (!isValidEmail(sanitizedEmail)) {
      return res.status(400).json({ message: 'Enter a valid email address' });
    }

    const sanitizedUsername = normalizeUsername(username);
    if (!isValidUsername(sanitizedUsername)) {
      return res.status(400).json({ message: 'Username can use lowercase letters, numbers, dot and underscore only' });
    }

    const usernameExists = await User.findOne({ username: sanitizedUsername });
    if (usernameExists) {
      return res.status(400).json({ message: 'Username already taken' });
    }

    const formattedPhone = normalizePhone(phone);
    if (!formattedPhone) {
      return res.status(400).json({ message: 'Enter a valid Indian mobile number' });
    }

    // Check if user exists
    const userExists = await findExistingByEmailOrPhone(sanitizedEmail, formattedPhone);

    if (userExists) {
      if (normalizeEmail(userExists.email) === sanitizedEmail) {
        return res.status(400).json({ message: 'Email already registered' });
      }
      return res.status(400).json({ message: 'Phone number already registered' });
    }

    // Create user — always as 'player' (owners/admins are created via admin portal)
    const user = await createUserWithGeneratedPlayNowId({
      name: name.trim(),
      username: sanitizedUsername,
      phone: formattedPhone,
      email: sanitizedEmail,
      password,
      role: 'player'
    });

    if (user) {
      res.status(201).json({
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        username: user.username,
        playNowId: user.playNowId,
        role: user.role,
        token: generateToken(user._id),
      });
    } else {
      res.status(400).json({ message: 'Invalid user data' });
    }
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(400).json({ message: duplicateMessageForError(error) });
    }
    res.status(500).json({ message: error.message });
  }
};

// @desc    Authenticate a user
// @route   POST /api/auth/login
// @access  Public
const login = async (req, res) => {
  try {
    const { loginId, email, phone, ownerId, password } = req.body;
    const identifier = loginId || email || phone || ownerId;

    if (!password || !identifier) {
      return res.status(400).json({ message: 'Please provide credentials and password' });
    }

    let query;
    if (ownerId) {
      query = { ownerId: ownerId.trim() };
    } else {
      const normalizedIdentifier = String(identifier).trim();
      const emailValue = normalizeEmail(normalizedIdentifier);
      query = {
        $or: [
          { email: emailValue },
          { phone: { $in: getPhoneVariants(normalizedIdentifier) } }
        ]
      };
    }

    const user = await User.findOne(query).select('+password');

    if (user && (await user.matchPassword(password))) {
      res.json({
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        username: user.username,
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
    const formattedPhone = normalizePhone(phone_number);
    if (!formattedPhone) {
      return res.status(400).json({ message: 'Phone number not found in Firebase token.' });
    }
    let user      = await User.findOne({ $or: [{ phone: { $in: getPhoneVariants(formattedPhone) } }, { firebaseId: uid }] });
    let isNewUser = false;

    if (!user) {
      // Auto-create only player accounts via Firebase OTP.
      // Admins/Owners must be pre-created in the database by an administrator.
      isNewUser       = true;
      user = await createUserWithGeneratedPlayNowId({
        name:         name ? name.trim() : 'Player',
        phone:        formattedPhone,
        firebaseId:   uid,
        profilePhoto: profilePhoto || 'default.jpg',
        role:         'player',   // Only players are auto-created via Firebase OTP
      });
    } else {
      // Sync firebaseId if this is the first OTP login for an existing user.
      // IMPORTANT: Never overwrite the existing role — preserve admin/owner roles.
      if (!user.firebaseId) {
        user.firebaseId = uid;
        await user.save();
      }
    }

    res.json({
  _id: user._id,
  name: user.name,
  phone: user.phone,
  playNowId: user.playNowId,
  role: user.role,
  isNewUser,
  token: generateToken(user._id),
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
    const formattedPhone = normalizePhone(phone);
    if (!formattedPhone) {
      return res.status(400).json({ message: 'Please provide a valid 10-digit phone number' });
    }
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
    const formattedPhone = normalizePhone(phone);
    if (!formattedPhone) {
      return res.status(400).json({ message: 'Please provide a valid 10-digit phone number' });
    }
    const stored         = otpStore.get(formattedPhone);
    if (!stored)                           return res.status(400).json({ message: 'OTP not found. Request a new one.' });
    if (Date.now() > stored.expiresAt)     { otpStore.delete(formattedPhone); return res.status(400).json({ message: 'OTP expired.' }); }
    if (stored.otp !== String(otp).trim()) return res.status(400).json({ message: 'Invalid OTP.' });
    otpStore.delete(formattedPhone);

    let user      = await User.findOne({ phone: { $in: getPhoneVariants(formattedPhone) } });
    let isNewUser = false;

    if (!user) {
      // Only auto-create accounts for players, NOT for admin/owner portals.
      // Admins and Owners must be pre-created in the database.
      // If name is not provided, this is likely an admin/owner login attempt — reject it.
      if (!name) {
        return res.status(404).json({
          message: 'No account found with this mobile number. Please contact the administrator to create your account.',
        });
      }
      isNewUser       = true;
      user = await createUserWithGeneratedPlayNowId({
        name:         name.trim(),
        phone:        formattedPhone,
        profilePhoto: 'default.jpg',
        role:         'player',   // Only players are auto-created via OTP
      });
    }
    // IMPORTANT: Always return the role from the database — never override it.
    res.json({ _id: user._id, name: user.name, phone: user.phone, playNowId: user.playNowId, role: user.role, isNewUser, token: generateToken(user._id) });
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
   const user = await User.findOne({ playNowId: req.user.playNowId });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.name = req.body.name || user.name;
    user.username = req.body.username || user.username;
    user.bio = req.body.bio || user.bio;
    user.favoriteSport = req.body.favoriteSport || user.favoriteSport;
    user.location = req.body.location || user.location;
    if (req.body.notificationPreferences) {
      user.notificationPreferences = {
        ...user.notificationPreferences,
        ...req.body.notificationPreferences
      };
    }

    const updatedUser = await user.save();

   res.json({
  _id: updatedUser._id,
  name: updatedUser.name,
  phone: updatedUser.phone,
  playNowId: updatedUser.playNowId,
  role: updatedUser.role,
  token: generateToken(updatedUser._id),
  username: updatedUser.username,
  bio: updatedUser.bio,
  favoriteSport: updatedUser.favoriteSport,
  location: updatedUser.location,
  notificationPreferences: updatedUser.notificationPreferences,
});

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateProfileByPhone = async (req, res) => {
  try {
   const { phone, name, username, bio, favoriteSport, location } = req.body;

    if (!phone || !name) {
      return res.status(400).json({ message: 'Phone and name are required' });
    }

    const formattedPhone = normalizePhone(phone);
    if (!formattedPhone) {
      return res.status(400).json({ message: 'Please provide a valid 10-digit phone number' });
    }

    const user = await User.findOne({ phone: { $in: getPhoneVariants(formattedPhone) } });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.name = name.trim();
    user.username = username || user.username;
user.bio = bio || user.bio;
user.favoriteSport = favoriteSport || user.favoriteSport;
user.location = location || user.location;
    const updatedUser = await user.save();

    res.json({
      _id: updatedUser._id,
      name: updatedUser.name,
      phone: updatedUser.phone,
      playNowId: updatedUser.playNowId,
      role: updatedUser.role,
      token: generateToken(updatedUser._id),
      username: updatedUser.username,
bio: updatedUser.bio,
favoriteSport: updatedUser.favoriteSport,
location: updatedUser.location,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
// @desc    Request password reset email
// @route   POST /api/auth/forgot-password
// @access  Public
const forgotPassword = async (req, res) => {
  return res.status(501).json({
    message: 'Password reset is not automated yet. Contact PlayNow support to reset your account.'
  });
};

// @desc    Reset password using token
// @route   POST /api/auth/reset-password
// @access  Public
const resetPassword = async (req, res) => {
  try {
    const { token, password, confirmPassword } = req.body;

    if (!token || !password) {
      return res.status(400).json({ message: 'Token and new password are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }

    if (confirmPassword && password !== confirmPassword) {
      return res.status(400).json({ message: 'Passwords do not match' });
    }

    // Hash the token from the URL to compare with DB
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpire: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({ message: 'Invalid or expired reset token. Please request a new password reset.' });
    }

    // Set new password (pre-save hook will hash it)
    user.password = password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;
    await user.save();

    // Auto-login: return JWT so user is immediately authenticated
    res.json({
      _id: user._id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      playNowId: user.playNowId,
      role: user.role,
      token: generateToken(user._id),
      message: 'Password reset successful',
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
  updateProfileByPhone,
  forgotPassword,
  resetPassword,
};
