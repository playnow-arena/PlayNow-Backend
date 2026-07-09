const Slot = require('../models/Slot');
const Venue = require('../models/Venue');
const { getIO } = require('../socket');

const canManageVenue = (venue, user) => (
  user.role === 'admin'
  || venue.ownerId?.toString() === user._id.toString()
);

const venueAccessQueryForUser = (user) => {
  if (user.role === 'admin') return {};
  return { ownerId: user._id };
};

// @desc    Get slots for a venue
// @route   GET /api/slots/venue/:venueId
// @access  Public
const getSlotsByVenue = async (req, res) => {
  try {
    const { date } = req.query;
    let query = { venueId: req.params.venueId };
    
    if (date) {
      const startDate = new Date(date);
      startDate.setUTCHours(0,0,0,0);
      const endDate = new Date(date);
      endDate.setUTCHours(23,59,59,999);
      query.date = { $gte: startDate, $lte: endDate };
    }

    const slots = await Slot.find(query).sort({ startTime: 1 });
    res.json(slots);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Create slots (Batch creation)
// @route   POST /api/slots
// @access  Private/Owner
const createSlots = async (req, res) => {
  try {
    const { venueId, courtCode = '', date, slotsData } = req.body; 

    const venue = await Venue.findById(venueId);
    if (!venue) {
      return res.status(404).json({ message: 'Venue not found' });
    }

    if (!canManageVenue(venue, req.user)) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    const newSlots = slotsData.map(slot => ({
      venueId,
      courtCode: slot.courtCode || courtCode || '',
      date: new Date(date),
      startTime: slot.startTime,
      endTime: slot.endTime,
      price: slot.price || venue.pricePerHour,
      status: 'available'
    }));

    const createdSlots = await Slot.insertMany(newSlots, { ordered: false });
    res.status(201).json(createdSlots);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const addMinutes = (time, minutesToAdd) => {
  const [hour, minute] = String(time || '').split(':').map(Number);
  const totalMinutes = (hour * 60) + minute + minutesToAdd;
  const nextHour = Math.floor(totalMinutes / 60);
  const nextMinute = totalMinutes % 60;
  return `${String(nextHour).padStart(2, '0')}:${String(nextMinute).padStart(2, '0')}`;
};

const timeToMinutes = (time) => {
  const [hour, minute] = String(time || '').split(':').map(Number);
  return (hour * 60) + minute;
};

// @desc    Generate repeated slots for a month/date range
// @route   POST /api/slots/generate
// @access  Private/Owner
const generateSlots = async (req, res) => {
  try {
    const {
      venueId,
      courtCode = '',
      startDate,
      days = 30,
      openingTime,
      closingTime,
      slotDurationMinutes = 60,
      price,
    } = req.body;

    const venue = await Venue.findById(venueId);
    if (!venue) {
      return res.status(404).json({ message: 'Venue not found' });
    }

    if (!canManageVenue(venue, req.user)) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    const start = new Date(startDate);
    if (Number.isNaN(start.getTime())) {
      return res.status(400).json({ message: 'Please choose a valid start date' });
    }

    const duration = Number(slotDurationMinutes) || 60;
    const requestedDays = Math.max(1, Number(days) || 30);
    const requestedSlots = [];
    const openingMinutes = timeToMinutes(openingTime);
    const closingMinutes = timeToMinutes(closingTime);

    if (closingMinutes <= openingMinutes) {
      return res.status(400).json({ message: 'Closing time must be after opening time' });
    }

    for (let dayIndex = 0; dayIndex < requestedDays; dayIndex += 1) {
      const slotDate = new Date(start);
      slotDate.setDate(start.getDate() + dayIndex);

      for (let slotStart = openingTime; timeToMinutes(slotStart) + duration <= closingMinutes; slotStart = addMinutes(slotStart, duration)) {
        requestedSlots.push({
          venueId,
          courtCode,
          date: slotDate,
          startTime: slotStart,
          endTime: addMinutes(slotStart, duration),
          price: Number(price) || venue.pricePerHour,
          status: 'available'
        });
      }
    }

    if (!requestedSlots.length) {
      return res.status(400).json({ message: 'No slots could be generated for the selected timing pattern' });
    }

    const inserted = await Slot.insertMany(requestedSlots, { ordered: false }).catch((error) => {
      if (error?.insertedDocs) return error.insertedDocs;
      throw error;
    });

    res.status(201).json({
      requestedSlots: requestedSlots.length,
      createdSlots: inserted.length,
      existingSlots: requestedSlots.length - inserted.length,
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Get slots managed by owner/admin
// @route   GET /api/slots/manage
// @access  Private/Owner
const getManagedSlots = async (req, res) => {
  try {
    const { venueId, courtCode, date, status } = req.query;
    const query = {};

    if (venueId) {
      const venue = await Venue.findById(venueId);
      if (!venue) {
        return res.status(404).json({ message: 'Venue not found' });
      }
      if (!canManageVenue(venue, req.user)) {
        return res.status(403).json({ message: 'Not authorized' });
      }
      query.venueId = venueId;
    } else if (req.user.role !== 'admin') {
      const venues = await Venue.find(venueAccessQueryForUser(req.user)).select('_id');
      query.venueId = { $in: venues.map((venue) => venue._id) };
    }

    if (courtCode) query.courtCode = courtCode;
    if (status) query.status = status;
    if (date) {
      const startDate = new Date(date);
      startDate.setUTCHours(0, 0, 0, 0);
      const endDate = new Date(date);
      endDate.setUTCHours(23, 59, 59, 999);
      query.date = { $gte: startDate, $lte: endDate };
    }

    const slots = await Slot.find(query).sort({ date: 1, startTime: 1 });
    res.json(slots);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update a slot status from owner dashboard
// @route   PUT /api/slots/:id
// @access  Private/Owner
const updateSlotStatus = async (req, res) => {
  try {
    const { status, reason } = req.body;
    const allowedStatuses = ['available', 'blocked'];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ message: 'Slot status must be available or blocked' });
    }

    const slot = await Slot.findById(req.params.id).populate('venueId');
    if (!slot) {
      return res.status(404).json({ message: 'Slot not found' });
    }

    if (!canManageVenue(slot.venueId, req.user)) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    if (slot.status === 'booked' || slot.status === 'locked') {
      return res.status(400).json({ message: `Cannot change a slot that is currently ${slot.status}` });
    }

    slot.status = status;
    slot.blockReason = status === 'blocked' ? (reason || 'Manual Block by Owner') : '';
    await slot.save();

    res.json(slot);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Block a slot manually
// @route   PUT /api/slots/:id/block
// @access  Private/Owner
const blockSlot = async (req, res) => {
  try {
    const { reason } = req.body;
    const slot = await Slot.findById(req.params.id).populate('venueId');

    if (!slot) {
      return res.status(404).json({ message: 'Slot not found' });
    }

    if (!canManageVenue(slot.venueId, req.user)) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    if (slot.status === 'booked' || slot.status === 'locked') {
      return res.status(400).json({ message: `Cannot block a slot that is currently ${slot.status}` });
    }

    slot.status = 'blocked';
    slot.blockReason = reason || 'Manual Block by Owner';
    
    await slot.save();

    res.json(slot);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Lock slots temporarily (e.g. during payment)
// @route   POST /api/slots/lock
// @access  Private
const lockSlots = async (req, res) => {
  try {
    const { slotIds, venueId } = req.body;

    if (!slotIds || slotIds.length === 0) {
      return res.status(400).json({ message: 'No slots provided' });
    }

    // Check if slots are available
    const slots = await Slot.find({ _id: { $in: slotIds }, status: 'available' });
    if (slots.length !== slotIds.length) {
      return res.status(400).json({ message: 'One or more slots are no longer available' });
    }

    // Update to 'locked'
    await Slot.updateMany(
      { _id: { $in: slotIds } },
      {
        $set: {
          status: 'locked',
          lockedBy: req.user._id,
          lockExpiresAt: new Date(Date.now() + 15 * 60 * 1000)
        }
      }
    );

    // Emit real-time update
    const io = getIO();
    io.to(`venue_${venueId}`).emit('slotStatusChanged', { slotIds, status: 'locked' });

    // Set timeout to auto-unlock after the checkout window.
    setTimeout(async () => {
      const stillLockedSlots = await Slot.find({
        _id: { $in: slotIds },
        status: 'locked',
        lockedBy: req.user._id,
        lockExpiresAt: { $lte: new Date() }
      });
      if (stillLockedSlots.length > 0) {
        const stillLockedIds = stillLockedSlots.map(s => s._id);
        await Slot.updateMany(
          { _id: { $in: stillLockedIds } },
          {
            $set: { status: 'available' },
            $unset: { lockedBy: '', lockExpiresAt: '' }
          }
        );
        io.to(`venue_${venueId}`).emit('slotStatusChanged', { slotIds: stillLockedIds, status: 'available' });
      }
    }, 15 * 60 * 1000);

    res.json({ message: 'Slots locked temporarily' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Unlock slots manually (e.g. if user cancels checkout)
// @route   POST /api/slots/unlock
// @access  Private
const unlockSlots = async (req, res) => {
  try {
    const { slotIds, venueId } = req.body;

    await Slot.updateMany(
      { _id: { $in: slotIds }, status: 'locked', lockedBy: req.user._id },
      {
        $set: { status: 'available' },
        $unset: { lockedBy: '', lockExpiresAt: '' }
      }
    );

    const io = getIO();
    io.to(`venue_${venueId}`).emit('slotStatusChanged', { slotIds, status: 'available' });

    res.json({ message: 'Slots unlocked' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Emergency Close Venue (Block all remaining slots for today)
// @route   POST /api/slots/emergency-close
// @access  Private/Owner
const emergencyClose = async (req, res) => {
  try {
    const { venueId } = req.body;
    const venue = await Venue.findById(venueId);

    if (!venue) {
      return res.status(404).json({ message: 'Venue not found' });
    }

    if (!canManageVenue(venue, req.user)) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    // Block all 'available' and 'locked' slots for this venue for today onwards
    const today = new Date();
    today.setHours(0,0,0,0);

    const result = await Slot.updateMany(
      { 
        venueId, 
        date: { $gte: today }, 
        status: { $in: ['available', 'locked'] } 
      },
      { $set: { status: 'blocked', blockReason: 'Emergency Closure' } }
    );

    const io = getIO();
    io.to(`venue_${venueId}`).emit('venueStatusChanged', { venueId, isActive: false, status: 'emergency_closed' });
    
    // Also notify owner room if needed (though they triggered it)
    io.to(`owner_${req.user.playNowId}`).emit('venueStatusChanged', { venueId, isActive: false });

    res.json({ message: 'Venue closed in emergency mode', affectedSlots: result.modifiedCount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getSlotsByVenue,
  createSlots,
  generateSlots,
  blockSlot,
  getManagedSlots,
  updateSlotStatus,
  lockSlots,
  unlockSlots,
  emergencyClose
};
