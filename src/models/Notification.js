const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  title: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true
  },
  type: {
    type: String,
    required: true,
    enum: ['booking', 'match', 'review', 'venue', 'admin', 'system']
  },
  isRead: {
    type: Boolean,
    required: true,
    default: false,
    index: true
  },
  link: {
    type: String
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed
  },
  dedupeKey: {
    type: String,
    trim: true
  }
}, {
  timestamps: true
});

// Compound index for optimized queries and count
notificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });
notificationSchema.index(
  { userId: 1, dedupeKey: 1 },
  {
    unique: true,
    partialFilterExpression: { dedupeKey: { $type: 'string' } }
  }
);

module.exports = mongoose.model('Notification', notificationSchema);
