const mongoose = require('mongoose');

const recurringBlockRuleSchema = new mongoose.Schema({
  venueId: {
    type: mongoose.Schema.ObjectId,
    ref: 'Venue',
    required: true,
    index: true
  },
  courtCode: {
    type: String,
    trim: true,
    default: ''
  },
  daysOfWeek: {
    type: [Number],
    required: true,
    default: []
  },
  startTime: {
    type: String,
    required: true
  },
  endTime: {
    type: String,
    required: true
  },
  startDate: {
    type: Date,
    required: true
  },
  endDate: {
    type: Date
  },
  reason: {
    type: String,
    required: true,
    trim: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  createdBy: {
    type: mongoose.Schema.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('RecurringBlockRule', recurringBlockRuleSchema);
