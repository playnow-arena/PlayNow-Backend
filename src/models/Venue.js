const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema({
  name: {
    type: String,
    trim: true,
    default: ''
  },
  phone: {
    type: String,
    trim: true,
    default: ''
  },
  email: {
    type: String,
    trim: true,
    default: ''
  },
  whatsapp: {
    type: String,
    trim: true,
    default: ''
  }
}, { _id: false });

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
    enum: ['Badminton', 'Football Turf', 'Football', 'Cricket', 'Cricket Nets', 'Pickleball', 'Tennis', 'Basketball', 'Table Tennis', 'Volleyball', 'Box Cricket', 'Other']
  },
  location: {
    type: String,
    required: [true, 'Please add a location/area']
  },
  city: {
    type: String,
    default: ''
  },
  area: {
    type: String,
    default: ''
  },
  landmark: {
    type: String,
    default: ''
  },
  address: {
    type: String,
    required: [true, 'Please add a full address']
  },
  coordinates: {
    lat: Number,
    lng: Number
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
  managerIds: [{
    type: mongoose.Schema.ObjectId,
    ref: 'User'
  }],
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
  contacts: {
    owner: {
      type: contactSchema,
      default: {}
    },
    manager: {
      type: contactSchema,
      default: {}
    },
    incharge: {
      type: contactSchema,
      default: {}
    },
    operational: {
      type: contactSchema,
      default: {}
    }
  },
  courtGroups: [{
    courtCode: { type: String, default: '' },
    name: { type: String, default: '' },
    sports: { type: [String], default: [] },
    courtCount: { type: Number, default: 1 },
    pricePerHour: { type: Number, default: 0 },
    courtType: { type: String, default: 'Standard' },
    dependencyGroup: { type: String, default: '' },
    bookingMode: { type: String, enum: ['independent', 'full', 'half'], default: 'independent' },
    isActive: { type: Boolean, default: true }
  }],
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