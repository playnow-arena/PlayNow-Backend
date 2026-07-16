const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
  venue: {
    type: mongoose.Schema.ObjectId,
    ref: 'Venue',
    required: true
  },
  user: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true
  },
  rating: {
    type: Number,
    required: [true, 'Please add a rating between 1 and 5'],
    min: 1,
    max: 5
  },
  comment: {
    type: String,
    required: [true, 'Please add a comment'],
    maxlength: [500, 'Comment cannot be more than 500 characters']
  },
  images: {
    type: [String],
    default: []
  }
}, {
  timestamps: true
});

// Prevent user from submitting more than one review per venue
reviewSchema.index({ venue: 1, user: 1 }, { unique: true });

module.exports = mongoose.model('Review', reviewSchema);
