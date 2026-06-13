const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema({
  name: {
    type: String,
    trim: true
  },
  phone: {
    type: String,
    trim: true
  },
  email: {
    type: String,
    trim: true,
    match: [/^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/, 'Please add a valid email']
  },
  whatsapp: {
    type: String,
    trim: true
  }
}, { _id: false });

const courtGroupRequestSchema = new mongoose.Schema({
  name: {
    type: String,
    trim: true
  },
  sports: {
    type: [String],
    default: []
  },
  courtCount: {
    type: Number,
    min: [1, 'Court count must be at least 1'],
    default: 1
  },
  pricePerHour: {
    type: Number,
    min: [0, 'Price cannot be negative']
  },
  courtType: {
    type: String,
    trim: true,
    default: 'Standard'
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, { _id: false });

const ownerRequestSchema = new mongoose.Schema({
  ownerName: {
    type: String,
    required: [true, 'Please add owner full name']
  },
  venueName: {
    type: String,
    required: [true, 'Please add venue name']
  },
  phone: {
    type: String,
    required: [true, 'Please add phone number']
  },
  email: {
    type: String,
    trim: true,
    match: [/^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/, 'Please add a valid email']
  },
  sportTypes: {
    type: [String],
    default: []
  },
  location: String,
  city: {
    type: String,
    trim: true
  },
  area: {
    type: String,
    trim: true
  },
  landmark: {
    type: String,
    trim: true
  },
  coordinates: {
    lat: Number,
    lng: Number
  },
  address: {
    type: String,
    required: [true, 'Please add venue address']
  },
  pricePerHour: Number,
  amenities: {
    type: [String],
    default: []
  },
  description: String,
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
    }
  },
  courtGroups: {
    type: [courtGroupRequestSchema],
    default: []
  },
  venuePhotos: [String],
  numberOfCourts: {
    type: Number
  },
  idProof: String,
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  submittedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  reviewedAt: Date,
  reviewNote: String,
  linkedUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  linkedVenueId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Venue'
  },
  rejectionReason: String,
  submittedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('OwnerRequest', ownerRequestSchema);
