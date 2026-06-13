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

const getPhoneVariants = (value) => {
  const rawValue = String(value || '').trim();
  const digits = rawValue.replace(/\D/g, '').slice(-10);
  const variants = [rawValue];

  if (digits.length === 10) {
    variants.push(digits, `+91${digits}`, `91${digits}`);
  }

  return [...new Set(variants.filter(Boolean))];
};

// @desc    Register a new player user
// @route   POST /api/auth/signup
// @access  Public
const signup = async (req, res) => {
  try {
    const { name, phone, email, password, confirmPassword } = req.body;

    // Input validation
    if (!name || !email || !phone || !password) {
      return res.status(400).json({ message: 'Please provide name, email, phone number, and password' });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }

    if (confirmPassword && password !== confirmPassword) {
      return res.status(400).json({ message: 'Passwords do not match' });
    }

    const sanitizedEmail = email.trim().toLowerCase();
    const digits = String(phone).replace(/\D/g, '').slice(-10);
    if (digits.length !== 10) {
      return res.status(400).json({ message: 'Please provide a valid 10-digit phone number' });
    }
    const formattedPhone = `+91${digits}`;

    // Check if user exists
    const userExists = await User.findOne({
      $or: [
        { email: sanitizedEmail },
        { phone: { $in: getPhoneVariants(formattedPhone) } }
      ]
    });

    if (userExists) {
      return res.status(400).json({ message: 'Account already exists with this email or phone number' });
    }

    // Generate unique PlayNow ID
    const playNowId = await generatePlayNowId();

    // Create user — always as 'player' (owners/admins are created via admin portal)
    const user = await User.create({
      name: name.trim(),
      phone: formattedPhone,
      email: sanitizedEmail,
      password,
      playNowId,
      role: 'player'
    });

    if (user) {
      res.status(201).json({
        _id: user._id,
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
    if (error?.code === 11000) {
      return res.status(400).json({ message: 'Account already exists with this email or phone number' });
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
      const emailValue = normalizedIdentifier.toLowerCase();
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
      // Auto-create only player accounts via Firebase OTP.
      // Admins/Owners must be pre-created in the database by an administrator.
      isNewUser       = true;
      const playNowId = await generatePlayNowId();
      user = await User.create({
        name:         name ? name.trim() : `Player_${playNowId.split('-')[1]}`,
        phone:        phone_number,
        firebaseId:   uid,
        playNowId,
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
    if (!stored)                           return res.status(400).json({ message: 'OTP not found. Request a new one.' });
    if (Date.now() > stored.expiresAt)     { otpStore.delete(formattedPhone); return res.status(400).json({ message: 'OTP expired.' }); }
    if (stored.otp !== String(otp).trim()) return res.status(400).json({ message: 'Invalid OTP.' });
    otpStore.delete(formattedPhone);

    let user      = await User.findOne({ phone: formattedPhone });
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
      const playNowId = await generatePlayNowId();
      user = await User.create({
        name:         name.trim(),
        phone:        formattedPhone,
        playNowId,
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

    const digits = String(phone).replace(/\D/g, '').slice(-10);
    const formattedPhone = `+91${digits}`;

    const user = await User.findOne({ phone: formattedPhone });

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
    message: 'Password reset is not available yet. Please contact PlayNow support.'
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
