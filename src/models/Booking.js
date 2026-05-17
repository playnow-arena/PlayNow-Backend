const mongoose = require('mongoose');

const bookingSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true
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
  totalAmount: {
    type: Number,
    required: true
  },
  paymentType: {
    type: String,
    enum: ['full', 'advance'],
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
  bookingStatus: {
    type: String,
    enum: ['confirmed', 'cancelled', 'completed'],
    default: 'confirmed'
  },
  paymentStatus: {
    type: String,
    enum: ['pending', 'completed', 'refunded'],
    default: 'completed' // MVP mock payment
  },
  cancellationFee: {
    type: Number,
    default: 0
  },
  refundAmount: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Booking', bookingSchema);
