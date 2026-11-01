const mongoose = require('mongoose');

const matchSchema = new mongoose.Schema({
  host: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  sport: { type: String, required: true },
  venue: { type: String, required: true },
  date: { type: String, required: true },
  time: { type: String, required: true },
  totalPlayers: { type: Number, required: true },
  joinedPlayers: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  }],
  totalAmount: { type: Number, required: true },
  contactPhone: {
    type: String,
    required: true,
  },
  status: {
    type: String,
    enum: ['open', 'full', 'started', 'cancelled'],
    default: 'open',
  },
  startedAt: {
    type: Date,
    default: null,
  },
  matchCode: {
    type: String,
    unique: true
  },
}, { timestamps: true });

module.exports = mongoose.model('Match', matchSchema);
