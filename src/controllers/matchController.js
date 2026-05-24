const Match = require('../models/Match');

const createMatch = async (req, res) => {
  try {
    const { sport, venue, date, time, totalPlayers, totalAmount } = req.body;

    if (!sport || !venue || !date || !time || !totalPlayers || !totalAmount) {
      return res.status(400).json({ message: 'Please fill all match details' });
    }

    const match = await Match.create({
      host: req.user._id,
      sport,
      venue,
      date,
      time,
      totalPlayers,
      totalAmount,
      joinedPlayers: [req.user._id],
    });

    res.status(201).json(match);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getMatches = async (req, res) => {
  try {
    const matches = await Match.find()
      .populate('host', 'name phone playNowId')
      .populate('joinedPlayers', 'name playNowId')
      .sort({ createdAt: -1 });

    res.json(matches);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { createMatch, getMatches };