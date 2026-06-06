const Slot = require('../models/Slot');
const Venue = require('../models/Venue');
const { getIO } = require('../socket');


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
    const { venueId, date, slotsData } = req.body; 

    const venue = await Venue.findById(venueId);
    if (!venue) {
      return res.status(404).json({ message: 'Venue not found' });
    }

    if (venue.ownerId.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized' });
    }

    const newSlots = slotsData.map(slot => ({
      venueId,
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

    if (slot.venueId.ownerId.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
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
      { $set: { status: 'locked' } }
    );

    // Emit real-time update
    const io = getIO();
    io.to(`venue_${venueId}`).emit('slotStatusChanged', { slotIds, status: 'locked' });

    // Set timeout to auto-unlock after 10 minutes
    setTimeout(async () => {
      const stillLockedSlots = await Slot.find({ _id: { $in: slotIds }, status: 'locked' });
      if (stillLockedSlots.length > 0) {
        const stillLockedIds = stillLockedSlots.map(s => s._id);
        await Slot.updateMany(
          { _id: { $in: stillLockedIds } },
          { $set: { status: 'available' } }
        );
        io.to(`venue_${venueId}`).emit('slotStatusChanged', { slotIds: stillLockedIds, status: 'available' });
      }
    }, 10 * 60 * 1000); // 10 minutes

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
      { _id: { $in: slotIds }, status: 'locked' },
      { $set: { status: 'available' } }
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

    if (venue.ownerId.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
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
  blockSlot,
  lockSlots,
  unlockSlots,
  emergencyClose
};
