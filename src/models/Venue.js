const mongoose = require('mongoose');

const venueSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Please add a venue name'],
    trim: true,
    maxlength: [50, 'Name cannot be more than 50 characters']
  },
  sportTypes: {
    type: [String],
    required: true,
    enum: ['Badminton', 'Football Turf', 'Football', 'Cricket', 'Cricket Nets', 'Pickleball', 'Tennis', 'Basketball', 'Table Tennis']
  },
  location: {
    type: String,
    required: [true, 'Please add a location/area']
  },
  address: {
    type: String,
    required: [true, 'Please add a full address']
  },
  images: {
    type: [String],
    default: ['default-venue.jpg']
  },
  amenities: {
    type: [String],
    default: []
  },
  pricePerHour: {
    type: Number,
    required: [true, 'Please add price per hour']
  },
  ownerId: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true
  },
  rating: {
    type: Number,
    min: [1, 'Rating must be at least 1'],
    max: [5, 'Rating must can not be more than 5'],
    default: 5
  },
  description: {
    type: String,
    default: 'A premium sports venue for athletes.'
  },
  reviewsCount: {
    type: Number,
    default: 0
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Venue', venueSchema);
