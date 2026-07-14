const mongoose = require('mongoose');

const paymentIntentSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  venueId: {
    type: mongoose.Schema.ObjectId,
    ref: 'Venue',
    required: true
  },
  slotIds: [{
    type: mongoose.Schema.ObjectId,
    ref: 'Slot',
    required: true
  }],
  paymentType: {
    type: String,
    enum: ['full', 'advance'],
    required: true
  },
  totalAmount: {
    type: Number,
    required: true
  },
  paidAmount: {
    type: Number,
    required: true
  },
  remainingAmount: {
    type: Number,
    required: true
  },
  razorpayOrderId: {
    type: String,
    required: true,
    unique: true
  },
  razorpayPaymentId: {
    type: String,
    unique: true,
    sparse: true
  },
  bookingId: {
    type: mongoose.Schema.ObjectId,
    ref: 'Booking'
  },
  status: {
    type: String,
    enum: ['created', 'processing', 'completed', 'failed'],
    default: 'created',
    index: true
  },
  paymentCode: {
    type: String,
    unique: true
  },
  expiresAt: {
    type: Date,
    required: true,
    index: true
  }
}, {
  timestamps: true
});

paymentIntentSchema.index({ userId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('PaymentIntent', paymentIntentSchema);
