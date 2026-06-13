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

const joinMatch = async (req, res) => {
  try {
    const match = await Match.findById(req.params.id);

    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    // already joined check
    const alreadyJoined = match.joinedPlayers.includes(req.user._id);

    if (alreadyJoined) {
      return res.status(400).json({ message: 'Already joined this match' });
    }

    // full check
    if (match.joinedPlayers.length >= match.totalPlayers) {
      return res.status(400).json({ message: 'Match is full' });
    }

    match.joinedPlayers.push(req.user._id);

    // auto full status
    if (match.joinedPlayers.length === match.totalPlayers) {
      match.status = 'full';
    }

    await match.save();

    const { createNotification } = require('./notificationController');

    // Notify the host
    if (match.host.toString() !== req.user._id.toString()) {
      await createNotification({
        userId: match.host,
        title: 'Player Joined Match',
        message: `${req.user.name} has joined your ${match.sport} match!`,
        type: 'match',
        link: `/feed`,
        metadata: { matchId: match._id }
      });
    }

    // Notify the player joining
    await createNotification({
      userId: req.user._id,
      title: 'Joined Match',
      message: `You joined the ${match.sport} match on ${new Date(match.date).toLocaleDateString()} successfully!`,
      type: 'match',
      link: `/feed`,
      metadata: { matchId: match._id }
    });

    res.json({
      message: 'Joined successfully',
      match,
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  createMatch,
  getMatches,
  joinMatch,
};