const Match = require('../models/Match');
const generatePlayNowId = require('../utils/generatePlayNowId');

// Reuse the same Indian mobile validation pattern as User model
const isValidIndianMobile = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  const mobile = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
  return /^[6-9]\d{9}$/.test(mobile);
};

const normalizePhone = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  const mobile = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
  return /^[6-9]\d{9}$/.test(mobile) ? `+91${mobile}` : String(phone || '').trim();
};

const createMatch = async (req, res) => {
  try {
    const { sport, venue, date, time, totalPlayers, totalAmount, contactPhone } = req.body;

    if (!sport || !venue || !date || !time || !totalPlayers || !totalAmount) {
      return res.status(400).json({ message: 'Please fill all match details' });
    }

    if (!contactPhone) {
      return res.status(400).json({ message: 'Please enter a contact mobile number' });
    }

    if (!isValidIndianMobile(contactPhone)) {
      return res.status(400).json({ message: 'Enter a valid Indian mobile number (10 digits starting with 6-9)' });
    }

    const match = await Match.create({
      host: req.user._id,
      sport,
      venue,
      date,
      time,
      totalPlayers,
      totalAmount,
      contactPhone: normalizePhone(contactPhone),
      joinedPlayers: [req.user._id],
      matchCode: await generatePlayNowId('match')
    });

    res.status(201).json(match);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getMatches = async (req, res) => {
  try {
    const matches = await Match.find({ status: 'open' })
      .populate('host', 'name phone playNowId')
      .populate('joinedPlayers', 'name playNowId')
      .sort({ createdAt: -1 });

    res.json(matches);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getMatchById = async (req, res) => {
  try {
    const match = await Match.findById(req.params.id)
      .populate('host', 'name phone playNowId')
      .populate('joinedPlayers', 'name playNowId');

    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    res.json(match);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const joinMatch = async (req, res) => {
  try {
    // Single atomic operation: add player + transition status if full.
    // Filter ensures match is 'open' (not full, not started, not cancelled).
    const match = await Match.findOneAndUpdate(
      {
        _id: req.params.id,
        status: 'open',
        joinedPlayers: { $ne: req.user._id },
        $expr: { $lt: [{ $size: '$joinedPlayers' }, '$totalPlayers'] }
      },
      [
        { $set: { joinedPlayers: { $concatArrays: ['$joinedPlayers', [req.user._id]] } } },
        {
          $set: {
            status: {
              $cond: {
                if: { $gte: [{ $size: '$joinedPlayers' }, '$totalPlayers'] },
                then: 'full',
                else: '$status'
              }
            }
          }
        }
      ],
      { new: true }
    );

    if (!match) {
      // Determine specific error for user feedback
      const existing = await Match.findById(req.params.id);
      if (!existing) {
        return res.status(404).json({ message: 'Match not found' });
      }
      if (existing.status === 'started') {
        return res.status(400).json({ message: 'This match has already started and cannot be joined' });
      }
      if (existing.status === 'cancelled') {
        return res.status(400).json({ message: 'This match has been cancelled' });
      }
      if (existing.status === 'full') {
        return res.status(400).json({ message: 'Match is full' });
      }
      const alreadyJoined = existing.joinedPlayers.some(
        playerId => playerId.toString() === req.user._id.toString()
      );
      if (alreadyJoined) {
        return res.status(400).json({ message: 'Already joined this match' });
      }
      if (existing.joinedPlayers.length >= existing.totalPlayers) {
        return res.status(400).json({ message: 'Match is full' });
      }
      return res.status(400).json({ message: 'Unable to join this match' });
    }

    // Send notifications (before populating, so IDs are plain ObjectIds)
    const { createNotification } = require('./notificationController');

    // Notify the host
    if (match.host.toString() !== req.user._id.toString()) {
      await createNotification({
        userId: match.host,
        title: 'Player Joined Match',
        message: `${req.user.name} has joined your ${match.sport} match!`,
        type: 'match',
        link: '/open-matches',
        metadata: { matchId: match._id },
        dedupeKey: `match:${match._id}:joined:${req.user._id}:host`
      });
    }

    // Notify the player joining
    await createNotification({
      userId: req.user._id,
      title: 'Joined Match',
      message: `You joined the ${match.sport} match on ${new Date(match.date).toLocaleDateString()} successfully!`,
      type: 'match',
      link: '/open-matches',
      metadata: { matchId: match._id },
      dedupeKey: `match:${match._id}:joined:${req.user._id}:player`
    });

    if (match.status === 'full') {
      await Promise.all(match.joinedPlayers.map(playerId => createNotification({
        userId: playerId,
        title: 'Match Full',
        message: `The ${match.sport} match at ${match.venue} is now full.`,
        type: 'match',
        link: '/open-matches',
        metadata: { matchId: match._id },
        dedupeKey: `match:${match._id}:full:${playerId}`
      })));
    }

    // Populate for response
    await match.populate('host', 'name phone playNowId');
    await match.populate('joinedPlayers', 'name playNowId');

    res.json({
      message: 'Joined successfully',
      match,
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const startMatch = async (req, res) => {
  try {
    const match = await Match.findById(req.params.id);

    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    if (match.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Only the match host can start the match' });
    }

    if (match.status === 'started') {
      return res.status(400).json({ message: 'Match has already started' });
    }

    if (match.status === 'cancelled') {
      return res.status(400).json({ message: 'Cannot start a cancelled match' });
    }

    match.status = 'started';
    match.startedAt = new Date();
    await match.save();

    res.json({ message: 'Match started', match });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const cancelMatch = async (req, res) => {
  try {
    const match = await Match.findById(req.params.id);

    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    if (match.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Only the match host can cancel this match' });
    }

    if (match.status === 'cancelled') {
      return res.status(400).json({ message: 'Match is already cancelled' });
    }

    match.status = 'cancelled';
    await match.save();

    const { createNotification } = require('./notificationController');
    await Promise.all(match.joinedPlayers.map(playerId => createNotification({
      userId: playerId,
      title: 'Match Cancelled',
      message: `The ${match.sport} match at ${match.venue} has been cancelled.`,
      type: 'match',
      link: '/open-matches',
      metadata: { matchId: match._id },
      dedupeKey: `match:${match._id}:cancelled:${playerId}`
    })));

    res.json({ message: 'Match cancelled successfully', match });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Admin: Get all matches with optional status & sport filters
// @route   GET /api/matches/admin
// @access  Private (Admin only)
const getAdminMatches = async (req, res) => {
  try {
    const { status, sport } = req.query;
    const query = {};

    if (status) {
      query.status = status;
    }

    if (sport) {
      query.sport = { $regex: new RegExp(sport, 'i') };
    }

    const matches = await Match.find(query)
      .populate('host', 'name phone playNowId email')
      .populate('joinedPlayers', 'name phone playNowId email')
      .sort({ createdAt: -1 });

    res.json(matches);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Admin: Update match status / cancel / close match
// @route   PATCH /api/matches/admin/:id/status
// @access  Private (Admin only)
const adminUpdateMatchStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const allowedStatuses = ['open', 'full', 'started', 'cancelled'];

    if (!status || !allowedStatuses.includes(status)) {
      return res.status(400).json({
        message: `Invalid status. Allowed statuses: ${allowedStatuses.join(', ')}`
      });
    }

    const match = await Match.findById(req.params.id);

    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    const previousStatus = match.status;
    match.status = status;

    if (status === 'started' && !match.startedAt) {
      match.startedAt = new Date();
    }

    await match.save();

    // If cancelled by admin, notify joined players
    if (status === 'cancelled' && previousStatus !== 'cancelled') {
      const { createNotification } = require('./notificationController');
      await Promise.all(match.joinedPlayers.map(playerId => createNotification({
        userId: playerId,
        title: 'Match Cancelled by Admin',
        message: `The ${match.sport} match at ${match.venue} has been cancelled by the administrator.`,
        type: 'match',
        link: '/open-matches',
        metadata: { matchId: match._id },
        dedupeKey: `match:${match._id}:admin-cancelled:${playerId}`
      })));
    }

    await match.populate('host', 'name phone playNowId email');
    await match.populate('joinedPlayers', 'name phone playNowId email');

    res.json({
      message: `Match status updated to ${status} successfully`,
      match
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Admin: Permanently delete a match record
// @route   DELETE /api/matches/admin/:id
// @access  Private (Admin only)
const adminDeleteMatch = async (req, res) => {
  try {
    const match = await Match.findById(req.params.id);

    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    await Match.findByIdAndDelete(req.params.id);

    res.json({
      message: 'Match permanently deleted successfully',
      matchId: req.params.id
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  createMatch,
  getMatches,
  getMatchById,
  joinMatch,
  startMatch,
  cancelMatch,
  getAdminMatches,
  adminUpdateMatchStatus,
  adminDeleteMatch,
};
