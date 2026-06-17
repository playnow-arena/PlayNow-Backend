const Booking = require('../models/Booking');
const Slot = require('../models/Slot');
const Venue = require('../models/Venue');
const { getIO } = require('../socket');
const n8nService = require('../utils/n8nService');

// @desc    Create a booking
// @route   POST /api/bookings
// @access  Private
const createBooking = async (req, res) => {
  try {
    const { venueId, slotIds, paymentType, paidAmount } = req.body;

    if (!venueId || !slotIds || slotIds.length === 0) {
      return res.status(400).json({ message: 'Venue and at least one slot must be selected' });
    }

    // Check if venue exists
    const venue = await Venue.findById(venueId);
    if (!venue) {
      return res.status(404).json({ message: 'Venue not found' });
    }

    // 1. Validate that ALL slots exist
    const slots = await Slot.find({ _id: { $in: slotIds } });
    
    if (slots.length !== slotIds.length) {
      return res.status(400).json({ message: 'One or more slots do not exist' });
    }

    const unavailableSlots = slots.filter(slot => slot.status !== 'available' && slot.status !== 'locked');
    
    if (unavailableSlots.length > 0) {
      return res.status(400).json({ 
        message: 'Slot already booked or unavailable', 
        unavailableSlots 
      });
    }

    // 2. Calculate totals
    const totalAmount = slots.reduce((acc, slot) => acc + slot.price, 0);

    // 3. Validate payment
    if (paymentType === 'advance') {
      const minAdvance = 100 * slots.length;
      if (paidAmount < minAdvance) {
        return res.status(400).json({ message: `Advance payment must be at least ₹${minAdvance}` });
      }
    } else if (paymentType === 'full') {
      if (paidAmount < totalAmount) {
        return res.status(400).json({ message: `Full payment must be ₹${totalAmount}` });
      }
    }

    const remainingAmount = totalAmount - paidAmount;

    // 4. Update Slot Statuses (Atomically prevent race conditions)
    const updateResult = await Slot.updateMany(
      { _id: { $in: slotIds }, status: { $in: ['available', 'locked'] } },
      { $set: { status: 'booked' } }
    );
    console.log(`[BOOKING CONCURRENCY DEBUG] slotIds.length: ${slotIds.length}, matchedCount: ${updateResult.matchedCount}, modifiedCount: ${updateResult.modifiedCount}, nModified: ${updateResult.nModified}`);

    if ((updateResult.modifiedCount !== undefined && updateResult.modifiedCount !== slotIds.length) || 
        (updateResult.nModified !== undefined && updateResult.nModified !== slotIds.length) || 
        (updateResult.matchedCount !== undefined && updateResult.matchedCount !== slotIds.length)) {
      // Revert any partially booked slots just in case
      await Slot.updateMany({ _id: { $in: slotIds }, status: 'booked' }, { $set: { status: 'available' } });
      return res.status(409).json({ message: 'Conflict: One or more slots were booked by someone else.' });
    }

    const { createNotification } = require('./notificationController');

    // 5. Create Booking
    const booking = await Booking.create({
      userId: req.user._id,
      venueId,
      slotIds,
      totalAmount,
      paymentType,
      paidAmount,
      remainingAmount,
      bookingStatus: 'confirmed',
      paymentStatus: 'completed' // MVP mock
    });

    // Save persistent notifications
    await createNotification({
      userId: req.user._id,
      title: 'Booking Confirmed',
      message: `Your booking at ${venue.name} has been successfully confirmed!`,
      type: 'booking',
      link: '/dashboard',
      metadata: { bookingId: booking._id, venueId }
    });

    await createNotification({
      userId: venue.ownerId,
      title: 'New Booking Received',
      message: `A new booking has been made for ${venue.name} by ${req.user.name}`,
      type: 'booking',
      link: '/owner',
      metadata: { bookingId: booking._id, venueId }
    });

    // --- REAL-TIME NOTIFICATION ---
    const io = getIO();
    // Notify the owner
    io.to(`owner_${venue.ownerId}`).emit('newBooking', {
      bookingId: booking._id,
      venueName: venue.name,
      totalAmount: booking.totalAmount,
      slots: slots.map(s => ({ startTime: s.startTime, endTime: s.endTime }))
    });
    // Notify everyone on the venue page to update slot statuses
    io.to(`venue_${venueId}`).emit('slotStatusChanged', {
      slotIds,
      status: 'booked'
    });

    // --- N8N WEBHOOK INTEGRATION ---
    const bookingData = {
      bookingId: booking._id.toString(),
      playerName: req.user.name || 'Unknown',
      email: req.user.email || 'No email provided',
      phone: req.user.phone || 'No phone provided',
      turfName: venue.name,
      bookingDate: slots[0]?.date ? new Date(slots[0].date).toISOString().split('T')[0] : 'Unknown Date',
      bookingTime: slots[0]?.startTime || 'Unknown Time',
      amount: totalAmount,
      bookingCreatedAt: booking.createdAt ? booking.createdAt.toISOString() : new Date().toISOString()
    };
    n8nService.sendBookingConfirmation(bookingData);

    res.status(201).json(booking);

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get user's bookings
// @route   GET /api/bookings/my
// @access  Private
const getMyBookings = async (req, res) => {
  try {
    const bookings = await Booking.find({ userId: req.user._id })
      .populate('venueId', 'name location')
      .populate('slotIds', 'date startTime endTime price status');
    
    res.json(bookings);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get bookings for owner's venues
// @route   GET /api/bookings/owner
// @access  Private/Owner
const getOwnerBookings = async (req, res) => {
  try {
    // Find venues owned by this user
    const venues = await Venue.find({ ownerId: req.user._id }).select('_id');
    const venueIds = venues.map(v => v._id);

    const bookings = await Booking.find({ venueId: { $in: venueIds } })
      .populate('userId', 'name phone playNowId')
      .populate('venueId', 'name')
      .populate('slotIds', 'date startTime endTime status');

    res.json(bookings);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all bookings for admin
// @route   GET /api/bookings/admin
// @access  Private/Admin
const getAdminBookings = async (req, res) => {
  try {
    const { status, venueId, date } = req.query;
    const query = {};

    if (status) query.bookingStatus = status;
    if (venueId) query.venueId = venueId;

    let bookingsQuery = Booking.find(query)
      .sort({ createdAt: -1 })
      .populate('userId', 'name phone playNowId')
      .populate('venueId', 'name location city area ownerId')
      .populate('slotIds', 'date startTime endTime price status');

    let bookings = await bookingsQuery;

    if (date) {
      const dateKey = new Date(date).toISOString().slice(0, 10);
      bookings = bookings.filter((booking) => (
        booking.slotIds || []
      ).some((slot) => (
        slot.date ? new Date(slot.date).toISOString().slice(0, 10) === dateKey : false
      )));
    }

    res.json(bookings);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Mark booking balance collected
// @route   PUT /api/bookings/:id/collect-balance
// @access  Private/Owner/Admin
const collectBookingBalance = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id).populate('venueId');

    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    if (booking.bookingStatus === 'cancelled') {
      return res.status(400).json({ message: 'Cannot collect balance for cancelled booking' });
    }

    if (req.user.role !== 'admin' && booking.venueId.ownerId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to collect this balance' });
    }

    booking.paidAmount = booking.totalAmount;
    booking.remainingAmount = 0;
    booking.paymentStatus = 'completed';
    await booking.save();

    const populatedBooking = await Booking.findById(booking._id)
      .populate('userId', 'name phone playNowId')
      .populate('venueId', 'name location city area ownerId')
      .populate('slotIds', 'date startTime endTime price status');

    res.json(populatedBooking);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Cancel a booking
// @route   PUT /api/bookings/:id/cancel
// @access  Private
const cancelBooking = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id).populate('slotIds');

    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    // Ensure user is the one who booked it
    if (booking.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to cancel this booking' });
    }

    if (booking.bookingStatus === 'cancelled') {
      return res.status(400).json({ message: 'Booking is already cancelled' });
    }

    // Calculate time difference
    // Assume the first slot dictates the start time
    // Sort slots by date and startTime
    const sortedSlots = booking.slotIds.sort((a, b) => {
      const dateA = new Date(a.date);
      const [hoursA, minutesA] = a.startTime.split(':');
      dateA.setHours(parseInt(hoursA), parseInt(minutesA), 0);

      const dateB = new Date(b.date);
      const [hoursB, minutesB] = b.startTime.split(':');
      dateB.setHours(parseInt(hoursB), parseInt(minutesB), 0);

      return dateA - dateB;
    });

    const firstSlot = sortedSlots[0];
    const matchTime = new Date(firstSlot.date);
    const [h, m] = firstSlot.startTime.split(':');
    matchTime.setHours(parseInt(h), parseInt(m), 0);
    
    const now = new Date();
    const hoursDifference = (matchTime - now) / (1000 * 60 * 60);

    let cancellationFee = 0;
    let refundAmount = booking.paidAmount;

    // Check if within 4 hours
    if (hoursDifference > 0 && hoursDifference <= 4) {
      // 10% cancellation fee on total amount
      cancellationFee = booking.totalAmount * 0.10;
      refundAmount = booking.paidAmount - cancellationFee;
      
      // If advance was less than the 10% fee, refund is 0 and they might owe money (but we cap at 0 for now)
      if (refundAmount < 0) refundAmount = 0;
    } else if (hoursDifference <= 0) {
      return res.status(400).json({ message: 'Cannot cancel after the match has started' });
    }

    // Update booking
    booking.bookingStatus = 'cancelled';
    booking.cancellationFee = cancellationFee;
    booking.refundAmount = refundAmount;
    booking.paymentStatus = 'refunded';
    
    await booking.save();

    // Release slots back to available
    const slotIds = booking.slotIds.map(slot => slot._id);
    await Slot.updateMany(
      { _id: { $in: slotIds } },
      { $set: { status: 'available' } }
    );

    // --- REAL-TIME NOTIFICATION ---
    const io = getIO();
    const venue = await Venue.findById(booking.venueId);
    if (venue) {
      const { createNotification } = require('./notificationController');

      // Save persistent notifications for cancel
      await createNotification({
        userId: booking.userId,
        title: 'Booking Cancelled',
        message: `Your booking at ${venue.name} has been cancelled.`,
        type: 'booking',
        link: '/dashboard',
        metadata: { bookingId: booking._id, venueId: venue._id }
      });

      await createNotification({
        userId: venue.ownerId,
        title: 'Booking Cancelled',
        message: `A booking at ${venue.name} has been cancelled by the player.`,
        type: 'booking',
        link: '/owner',
        metadata: { bookingId: booking._id, venueId: venue._id }
      });

      io.to(`owner_${venue.ownerId}`).emit('bookingCancelled', {
        bookingId: booking._id,
        venueName: venue.name
      });
      io.to(`venue_${booking.venueId}`).emit('slotStatusChanged', {
        slotIds,
        status: 'available'
      });
    }

    res.json({
      message: 'Booking cancelled successfully',
      booking
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  createBooking,
  getMyBookings,
  getOwnerBookings,
  getAdminBookings,
  collectBookingBalance,
  cancelBooking
};
