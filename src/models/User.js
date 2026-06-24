const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const normalizeEmail = (email) => {
  const normalized = String(email || '').trim().toLowerCase();
  return normalized || undefined;
};
const normalizePhone = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  const mobileDigits = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
  return mobileDigits.length === 10 ? `+91${mobileDigits}` : String(phone || '').trim();
};
const normalizeUsername = (username) => {
  const normalized = String(username || '').trim().toLowerCase();
  return normalized || undefined;
};

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Please add a name']
  },
  phone: {
    type: String,
    required: [true, 'Please add a phone number'],
    unique: true,
    set: normalizePhone
  },
  email: {
    type: String,
    unique: true,
    sparse: true, // Allow multiple null/undefined values
    set: normalizeEmail,
    match: [
      /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/,
      'Please add a valid email'
    ]
  },
  password: {
    type: String,
    minlength: 6,
    select: false // Do not return password by default
  },
  firebaseId: {
    type: String,
    unique: true,
    sparse: true
  },
  profilePhoto: {
    type: String,
    default: 'default.jpg'
  },
  playNowId: {
    type: String,
    unique: true,
    required: true
  },
  ownerId: {
    type: String,
    unique: true,
    sparse: true // Only owners have this
  },
  username: {
    type: String,
    unique: true,
    sparse: true,
    lowercase: true,
    trim: true,
    set: normalizeUsername,
    minlength: [3, 'Username must be at least 3 characters'],
    maxlength: [20, 'Username cannot be more than 20 characters'],
    match: [/^[a-z0-9_.]+$/, 'Username can only contain lowercase letters, numbers, underscore, and dot']
  },
  role: {
    type: String,
    enum: ['player', 'owner', 'manager', 'admin'],
    default: 'player'
  },
    accountStatus: {
      type: String,
      enum: ['active', 'suspended', 'pending'],
      default: 'active'
    },
    notificationPreferences: {
      booking: { type: Boolean, default: true },
      match: { type: Boolean, default: true },
      review: { type: Boolean, default: true },
      system: { type: Boolean, default: true }
    },
    bio: {
      type: String,
      maxlength: [300, 'Bio cannot be more than 300 characters'],
      default: ''
    },
    preferredSports: {
      type: [String],
      default: []
    },
    city: {
      type: String,
      trim: true,
      default: ''
    },
    area: {
      type: String,
      trim: true,
      default: ''
    },
    location: {
      type: String,
      trim: true,
      default: ''
    },
    resetPasswordToken: String,
    resetPasswordExpire: Date
  }, {
    timestamps: true
  });

// Encrypt password using bcrypt before saving
// NOTE: async pre-save hooks in Mongoose 7+ do NOT receive `next` as a callback.
// Simply return early or throw — Mongoose awaits the returned Promise.
userSchema.pre('save', async function () {
  // Skip if password hasn't changed, or if this is an OTP-only user (no password)
  if (!this.isModified('password') || !this.password) return;

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Match user entered password to hashed password in database
userSchema.methods.matchPassword = async function (enteredPassword) {
  if (!this.password) return false; // OTP-only accounts have no password
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
