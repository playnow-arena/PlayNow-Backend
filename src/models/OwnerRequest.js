const mongoose = require('mongoose');

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
    required: [true, 'Please add email'],
    match: [/^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/, 'Please add a valid email']
  },
  address: {
    type: String,
    required: [true, 'Please add venue address']
  },
  venuePhotos: [String],
  numberOfCourts: {
    type: Number,
    required: [true, 'Please specify number of courts']
  },
  idProof: String,
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  submittedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('OwnerRequest', ownerRequestSchema);
