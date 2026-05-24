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
  status: {
    type: String,
    enum: ['open', 'full', 'cancelled'],
    default: 'open',
  },
}, { timestamps: true });

module.exports = mongoose.model('Match', matchSchema);