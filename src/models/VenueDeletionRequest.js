const mongoose = require('mongoose');

const venueDeletionRequestSchema = new mongoose.Schema({
  venueId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Venue',
    required: [true, 'Venue ID is required'],
    index: true
  },
  venueName: {
    type: String,
    trim: true,
    default: ''
  },
  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Owner ID is required'],
    index: true
  },
  reason: {
    type: String,
    required: [true, 'Please provide a reason for the deletion request'],
    trim: true,
    minlength: [5, 'Reason must be at least 5 characters']
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
    index: true
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  reviewedAt: {
    type: Date
  },
  rejectionReason: {
    type: String,
    trim: true,
    default: ''
  },
  adminResponse: {
    type: String,
    trim: true,
    default: ''
  }
}, {
  timestamps: true
});

// Unique partial index: only one pending request is allowed per venue at a time.
// Approved and rejected historical requests are not affected because the partial
// filter only covers documents where status === 'pending'.
venueDeletionRequestSchema.index(
  { venueId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'pending' },
    name: 'venueId_pending_unique'
  }
);

// Retained for query performance (listing by owner, filtering by status)
venueDeletionRequestSchema.index({ ownerId: 1, status: 1 });

module.exports = mongoose.model('VenueDeletionRequest', venueDeletionRequestSchema);
