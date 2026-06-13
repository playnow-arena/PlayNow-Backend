const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema(
  {
    venueId: {
      type: mongoose.Schema.ObjectId,
      ref: 'Venue',
      required: [true, 'Review must belong to a venue']
    },
    userId: {
      type: mongoose.Schema.ObjectId,
      ref: 'User',
      required: [true, 'Review must belong to a user']
    },
    rating: {
      type: Number,
      required: [true, 'Please provide a rating'],
      min: [1, 'Rating must be at least 1'],
      max: [5, 'Rating cannot be more than 5']
    },
    comment: {
      type: String,
      trim: true,
      maxlength: [500, 'Comment cannot exceed 500 characters'],
      default: ''
    },
    // Future-proof: flag set to true once a booking at this venue is confirmed
    verifiedVisit: {
      type: Boolean,
      default: false
    }
  },
  {
    timestamps: true,
    // Expose virtual fields when converting to JSON (useful for future analytics)
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// Prevent one user from leaving more than one review per venue
reviewSchema.index({ venueId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('Review', reviewSchema);
