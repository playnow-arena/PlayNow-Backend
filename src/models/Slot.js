const mongoose = require('mongoose');

const slotSchema = new mongoose.Schema({
  venueId: {
    type: mongoose.Schema.ObjectId,
    ref: 'Venue',
    required: true
  },
  date: {
    type: Date,
    required: [true, 'Please add a date']
  },
  startTime: {
    type: String, // format: "HH:mm" (24-hour)
    required: [true, 'Please add a start time']
  },
  endTime: {
    type: String, // format: "HH:mm" (24-hour)
    required: [true, 'Please add an end time']
  },
  price: {
    type: Number,
    required: true
  },
  status: {
    type: String,
    enum: ['available', 'locked', 'booked', 'blocked'],
    default: 'available'
  },
  blockReason: {
    type: String,
    default: ''
  }
}, {
  timestamps: true
});

// Compound index to prevent overlapping exact slots
slotSchema.index({ venueId: 1, date: 1, startTime: 1 }, { unique: true });

module.exports = mongoose.model('Slot', slotSchema);
