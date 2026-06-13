const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Please add a name']
  },
  phone: {
    type: String,
    required: [true, 'Please add a phone number'],
    unique: true
  },
  email: {
    type: String,
    unique: true,
    sparse: true, // Allow multiple null/undefined values
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
    sparse: true // Only owners/admins have this
  },
  role: {
    type: String,
    enum: ['player', 'owner', 'admin'],
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
