const mongoose = require('mongoose');
const Booking = require('../models/Booking');
const Slot = require('../models/Slot');
const Venue = require('../models/Venue');
const User = require('../models/User');
const { getIO } = require('../socket');
const generatePlayNowId = require('../utils/generatePlayNowId');
const n8nService = require('../utils/n8nService');
const razorpayService = require('../utils/razorpayService');
const {
  sendBookingConfirmationEmail,
  sendOwnerNewBookingEmail
} = require('../utils/emailService');
const { sendUserPushNotification } = require('../utils/fcmService');

const isTransactionSupported = () => {
  if (mongoose.connection.readyState !== 1) return false;
  const topology = mongoose.connection.client?.topology;
  if (!topology || !topology.description) return false;
  const type = topology.description.type;
  return type === 'ReplicaSetWithPrimary' || type === 'Sharded';
};

const venueAccessQueryForUser = (user) => {
  if (user.role === 'admin') return {};
  return { ownerId: user._id };
};

const canManageVenue = (venue, user) => (
  user.role === 'admin'
  || venue.ownerId?.toString() === user._id.toString()
);

const formatTime = (time) => {
  if (!time) return '';
  const [hourValue, minute = '00'] = String(time).split(':');
  const hour = Number(hourValue);
  if (Number.isNaN(hour)) return time;
  return `${hour % 12 || 12}:${minute} ${hour >= 12 ? 'PM' : 'AM'}`;
};

const formatSlotRange = (slot) => (
  [formatTime(slot?.startTime), formatTime(slot?.endTime)].filter(Boolean).join(' - ')
);

const formatSlotDate = (slot) => (
  slot?.date
    ? new Date(slot.date).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })
    : 'Date unavailable'
);

const buildBookingEventPayload = ({ booking, venue, slots, user }) => ({
  bookingId: booking._id,
  bookingCode: booking.bookingCode,
  venueId: venue._id,
  venueName: venue.name,
  court: slots.map(slot => `${slot.courtName || 'Court'}${slot.courtNumber ? ` #${slot.courtNumber}` : ''}`).join(', '),
  time: slots.map(formatSlotRange).join(', '),
  date: formatSlotDate(slots[0]),
  customerName: user.name || user.username || 'Player',
  customerPhone: user.phone || '',
  totalAmount: booking.totalAmount,
  paidAmount: booking.paidAmount,
  remainingAmount: booking.remainingAmount,
  slots: slots.map(slot => ({
    id: slot._id,
    date: slot.date,
    startTime: slot.startTime,
    endTime: slot.endTime,
    courtCode: slot.courtCode,
    courtName: slot.courtName,
    courtNumber: slot.courtNumber,
    price: slot.price
  }))
});

// @desc    Create a direct / walk-in booking (Restricted to venue owners and admins)
// @route   POST /api/bookings/direct, POST /api/bookings/walk-in
// @access  Private (Owner / Admin only)
const createBooking = async (req, res) => {
  try {
    // Direct/walk-in booking creation is strictly restricted to owners and admins
    if (req.user.role !== 'admin' && req.user.role !== 'owner') {
      return res.status(403).json({ message: 'Direct bookings are restricted to venue owners and administrators' });
    }

    const { venueId, slotIds, paymentType, paidAmount } = req.body;

    // FIX 4 (B5): Walk-in bookings may only use 'cash' or 'walkin'.
    // Reject 'online' to prevent false accounting records. No Razorpay IDs accepted here.
    const rawPaymentMethod = req.body.paymentMethod;
    if (rawPaymentMethod && !['cash', 'walkin'].includes(rawPaymentMethod)) {
      return res.status(400).json({
        message: "Walk-in bookings only accept 'cash' or 'walkin' as payment method"
      });
    }
    const paymentMethod = rawPaymentMethod || 'cash';

    if (!venueId || !slotIds || !Array.isArray(slotIds) || slotIds.length === 0) {
      return res.status(400).json({ message: 'Venue and at least one slot must be selected' });
    }

    if (!mongoose.Types.ObjectId.isValid(venueId)) {
      return res.status(400).json({ message: 'Invalid venue ID' });
    }

    // Check if venue exists and is active
    const venue = await Venue.findById(venueId);
    if (!venue) {
      return res.status(404).json({ message: 'Venue not found' });
    }

    if (!venue.isActive) {
      return res.status(400).json({ message: 'Venue is inactive and not accepting bookings' });
    }

    // Verify caller can manage this venue
    if (!canManageVenue(venue, req.user)) {
      return res.status(403).json({ message: 'Not authorized to create direct bookings for this venue' });
    }

    const uniqueSlotIds = [...new Set(slotIds.map(id => id.toString()))];
    if (uniqueSlotIds.length !== slotIds.length) {
      return res.status(400).json({ message: 'Duplicate slots in booking request' });
    }

    for (const id of uniqueSlotIds) {
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: 'Invalid slot ID' });
      }
    }

    // 1. Validate that ALL slots exist and belong to this venue
    const slots = await Slot.find({ _id: { $in: uniqueSlotIds } });
    
    if (slots.length !== uniqueSlotIds.length) {
      return res.status(400).json({ message: 'One or more slots do not exist' });
    }

    const foreignSlot = slots.find(slot => slot.venueId.toString() !== venue._id.toString());
    if (foreignSlot) {
      return res.status(400).json({ message: 'One or more slots do not belong to the selected venue' });
    }

    // Validate slots are available or legitimately locked by the current user
    const now = new Date();
    const unavailableSlots = slots.filter(slot => {
      if (slot.status === 'available') return false;
      if (slot.status === 'locked') {
        const isOwner = slot.lockedBy && slot.lockedBy.toString() === req.user._id.toString();
        const isExpired = slot.lockExpiresAt && new Date(slot.lockExpiresAt) <= now;
        if (isOwner || isExpired) return false;
      }
      return true;
    });
    
    if (unavailableSlots.length > 0) {
      return res.status(400).json({ 
        message: 'Slot already booked or unavailable', 
        unavailableSlots 
      });
    }

    // Validate booking dates and times (cannot book past slots)
    const pastSlot = slots.find(slot => {
      const slotDate = new Date(slot.date);
      const [h = '0', m = '0'] = (slot.startTime || '').split(':');
      slotDate.setHours(parseInt(h, 10), parseInt(m, 10), 0, 0);
      return slotDate < now;
    });
    if (pastSlot) {
      return res.status(400).json({ message: 'Cannot book slots in the past' });
    }

    // 2. Calculate totals and validate payment
    const totalAmount = slots.reduce((acc, slot) => acc + (Number(slot.price) || 0), 0);
    const numericPaidAmount = Number(paidAmount);

    if (isNaN(numericPaidAmount) || numericPaidAmount < 0) {
      return res.status(400).json({ message: 'Invalid payment amount' });
    }

    if (paymentType === 'advance') {
      const minAdvance = 100 * slots.length;
      if (numericPaidAmount < minAdvance) {
        return res.status(400).json({ message: `Advance payment must be at least ₹${minAdvance}` });
      }
      if (numericPaidAmount > totalAmount) {
        return res.status(400).json({ message: 'Paid amount cannot exceed total amount' });
      }
    } else if (paymentType === 'full') {
      if (numericPaidAmount < totalAmount) {
        return res.status(400).json({ message: `Full payment must be ₹${totalAmount}` });
      }
      if (numericPaidAmount > totalAmount) {
        return res.status(400).json({ message: 'Paid amount cannot exceed total amount' });
      }
    } else {
      return res.status(400).json({ message: 'Invalid payment type' });
    }

    const remainingAmount = Math.max(0, totalAmount - numericPaidAmount);
    const paymentStatus = remainingAmount === 0 ? 'completed' : 'advance_paid';

    // 3. Atomically claim slots with unique claimToken
    let session = null;
    if (isTransactionSupported()) {
      try {
        session = await mongoose.startSession();
      } catch (_) {
        session = null;
      }
    }

    let booking;
    const claimToken = new mongoose.Types.ObjectId().toString();

    try {
      const executeBooking = async (sess) => {
        // Atomic slot update with strict ownership / availability condition and unique claimToken
        const claimCondition = {
          _id: { $in: uniqueSlotIds },
          venueId: venue._id,
          $or: [
            { status: 'available' },
            { status: 'locked', lockedBy: req.user._id },
            { status: 'locked', lockExpiresAt: { $lte: now } }
          ]
        };

        const updateResult = await Slot.updateMany(
          claimCondition,
          {
            $set: {
              status: 'booked',
              claimToken
            },
            $unset: { lockedBy: '', lockExpiresAt: '' }
          },
          { session: sess || null }
        );

        if (updateResult.matchedCount !== uniqueSlotIds.length) {
          const conflictErr = new Error('Conflict: One or more slots were booked by someone else.');
          conflictErr.statusCode = 409;
          throw conflictErr;
        }

        const bookingDoc = new Booking({
          userId: req.body.userId || req.user._id,
          venueId,
          slotIds: uniqueSlotIds,
          totalAmount,
          paymentType,
          paidAmount: numericPaidAmount,
          remainingAmount,
          bookingStatus: 'confirmed',
          paymentStatus,
          paymentMethod,
          bookingCode: await generatePlayNowId('booking')
        });

        await bookingDoc.save({ session: sess || null });

        // Clean up temporary claimToken marker from booked slots
        await Slot.updateMany(
          { _id: { $in: uniqueSlotIds }, claimToken },
          { $unset: { claimToken: '' } },
          { session: sess || null }
        );

        return bookingDoc;
      };

      if (session) {
        await session.withTransaction(async () => {
          booking = await executeBooking(session);
        });
      } else {
        try {
          booking = await executeBooking(null);
        } catch (execErr) {
          // Revert ONLY slots that this request claimed with this exact unique claimToken
          await Slot.updateMany(
            {
              _id: { $in: uniqueSlotIds },
              status: 'booked',
              claimToken
            },
            {
              $set: { status: 'available' },
              $unset: { claimToken: '', lockedBy: '', lockExpiresAt: '' }
            }
          );
          throw execErr;
        }
      }
    } catch (bookingErr) {
      if (bookingErr.statusCode === 409) {
        return res.status(409).json({ message: bookingErr.message });
      }
      throw bookingErr;
    } finally {
      if (session) {
        session.endSession();
      }
    }

    // 4. Post-commit notifications and events
    try {
      const { createNotification } = require('./notificationController');
      const owner = venue.ownerId ? await User.findById(venue.ownerId).select('name email phone') : null;
      const eventPayload = buildBookingEventPayload({ booking, venue, slots, user: req.user });

      // Save persistent notifications
      const playerNotification = await createNotification({
        userId: booking.userId,
        title: 'Booking Confirmed',
        message: `Your booking at ${venue.name} has been successfully confirmed!`,
        type: 'booking',
        link: '/dashboard',
        metadata: eventPayload,
        dedupeKey: `booking:${booking._id}:confirmed:player`
      });

      let ownerNotification = null;
      if (venue.ownerId) {
        ownerNotification = await createNotification({
          userId: venue.ownerId,
          title: 'New Booking Received',
          message: `A new booking has been made for ${venue.name} by ${eventPayload.customerName}`,
          type: 'booking',
          link: '/owner',
          metadata: eventPayload,
          dedupeKey: `booking:${booking._id}:confirmed:owner`
        });
      }

      await createNotification({
        userId: booking.userId,
        title: 'Payment Recorded',
        message: `Payment of ₹${numericPaidAmount} (${booking.paymentMethod}) for ${venue.name} was recorded.`,
        type: 'booking',
        link: '/dashboard',
        metadata: { bookingId: booking._id, venueId, amount: numericPaidAmount, ...eventPayload },
        dedupeKey: `booking:${booking._id}:payment-success`
      });

      // Real-time Socket.IO events
      const io = getIO();
      if (io) {
        io.to(`user_${booking.userId}`).emit('booking_confirmed', eventPayload);
        if (venue.ownerId) {
          io.to(`owner_${venue.ownerId}`).emit('newBooking', eventPayload);
          io.to(`owner_${venue.ownerId}`).emit('booking_received', eventPayload);
        }
        io.to(`venue_${venueId}`).emit('slotStatusChanged', {
          slotIds: uniqueSlotIds,
          status: 'booked'
        });
      }

      await Promise.allSettled([
        playerNotification ? sendUserPushNotification({
          userId: booking.userId,
          title: 'Booking Confirmed',
          body: `${eventPayload.venueName} • ${eventPayload.court} • ${eventPayload.time} • Rs ${eventPayload.totalAmount}`,
          url: '/dashboard',
          dedupeKey: `booking:${booking._id}:push:player`,
          data: {
            audience: 'player',
            notificationId: playerNotification._id,
            ...eventPayload
          }
        }) : Promise.resolve(),
        ownerNotification && venue.ownerId ? sendUserPushNotification({
          userId: venue.ownerId,
          title: 'New Booking Received',
          body: `${eventPayload.venueName} • ${eventPayload.court} • ${eventPayload.customerName} • ${eventPayload.time} • Rs ${eventPayload.totalAmount}`,
          url: '/owner',
          dedupeKey: `booking:${booking._id}:push:owner`,
          data: {
            audience: 'owner',
            notificationId: ownerNotification._id,
            ...eventPayload
          }
        }) : Promise.resolve(),
        sendBookingConfirmationEmail({
          to: req.user.email,
          booking,
          venue,
          slots,
          player: req.user
        }),
        sendOwnerNewBookingEmail({
          to: owner?.email || venue.contacts?.owner?.email,
          booking,
          venue,
          slots,
          player: req.user
        })
      ]);

      // N8N Webhook
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
    } catch (eventErr) {
      console.error('Post-booking notification error:', eventErr.message);
    }

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
    const venues = await Venue.find(venueAccessQueryForUser(req.user)).select('_id');
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
    const { status, paymentStatus, venueId, date } = req.query;
    const query = {};

    if (status) query.bookingStatus = status;
    if (paymentStatus) query.paymentStatus = paymentStatus;
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

    if (!canManageVenue(booking.venueId, req.user)) {
      return res.status(403).json({ message: 'Not authorized to collect this balance' });
    }

    if (booking.bookingStatus !== 'confirmed' || ['refund_processing', 'refund_pending', 'refunded'].includes(booking.paymentStatus)) {
      return res.status(400).json({ message: 'Cannot update payment for a cancelled or refunding booking' });
    }

    const paymentUpdate = await Booking.updateOne(
      {
        _id: booking._id,
        bookingStatus: 'confirmed',
        paymentStatus: { $in: ['pending', 'advance_paid', 'completed'] }
      },
      { $set: { paidAmount: booking.totalAmount, remainingAmount: 0, paymentStatus: 'completed' } }
    );
    if (!paymentUpdate.modifiedCount) {
      return res.status(409).json({ message: 'Booking payment state changed; reload before collecting balance' });
    }
    booking.paidAmount = booking.totalAmount;
    booking.remainingAmount = 0;
    booking.paymentStatus = 'completed';

    const { createNotification } = require('./notificationController');
    await createNotification({
      userId: booking.userId,
      title: 'Payment Completed',
      message: `The remaining payment for your booking at ${booking.venueId.name} has been received.`,
      type: 'booking',
      link: '/dashboard',
      metadata: { bookingId: booking._id, venueId: booking.venueId._id, amount: booking.totalAmount },
      dedupeKey: `booking:${booking._id}:balance-payment-success`
    });

    const populatedBooking = await Booking.findById(booking._id)
      .populate('userId', 'name phone playNowId')
      .populate('venueId', 'name location city area ownerId')
      .populate('slotIds', 'date startTime endTime price status');

    res.json(populatedBooking);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * processRefundForCancelledBooking
 *
 * Atomically initiates a Razorpay refund for a cancelled booking.
 * Uses 'refund_processing' as an atomic state gate to prevent duplicate refunds.
 *
 * State machine (paymentStatus):
 *   completed / advance_paid  --[atomic]-->  refund_processing
 *   refund_processing  -->  refunded         (Razorpay status === 'processed')
 *   refund_processing  -->  refund_pending   ('pending'/'created', throw, or timeout)
 *   refunded / refund_processing already  -->  no-op
 *
 * Crash safety: if the process dies after the gateway call but before the final
 * Booking.updateOne, the booking stays in 'refund_processing'. A reconciliation
 * job or Razorpay webhook must resolve these stale records.
 */
const processRefundForCancelledBooking = async (booking) => {
  const refundAmount = Number(booking.refundAmount) || 0;
  if (refundAmount <= 0) return;

  if (!booking.razorpayPaymentId) {
    // Cash / walk-in booking: requires manual refund processing
    await Booking.updateOne(
      { _id: booking._id, paymentStatus: { $nin: ['refunded', 'refund_processing', 'refund_pending'] } },
      { $set: { paymentStatus: 'refund_pending' } }
    );
    return;
  }

  // Atomically claim the refund slot — only one concurrent call can win.
  // Excludes 'refund_pending' so a previous timed-out call is not silently retried.
  const refundClaimed = await Booking.findOneAndUpdate(
    {
      _id: booking._id,
      paymentStatus: { $nin: ['refunded', 'refund_processing', 'refund_pending'] }
    },
    { $set: { paymentStatus: 'refund_processing' } },
    { new: true }
  );

  if (!refundClaimed) {
    return; // Another request already holds the gate or refund is in a terminal state
  }

  let newPaymentStatus = 'refund_pending';
  let refundId;

  try {
    const refundResult = await razorpayService.createRefund({
      paymentId: booking.razorpayPaymentId,
      amount: refundAmount,
      notes: {
        bookingId: booking._id.toString(),
        bookingCode: booking.bookingCode || '',
        reason: 'Customer cancellation'
      }
    });

    // FIX 2 (B2): Only 'processed' means money has left Razorpay.
    // 'pending' and 'created' are async states — do NOT mark 'refunded'.
    if (refundResult && refundResult.status === 'processed') {
      newPaymentStatus = 'refunded';
    } else {
      newPaymentStatus = 'refund_pending'; // 'pending', 'created', or unexpected
    }
    // Store refund ID even for async-pending responses so webhooks can reconcile
    if (refundResult && refundResult.id) {
      refundId = refundResult.id;
    }
  } catch (refundErr) {
    console.error('[REFUND] Gateway call failed or timed out:', refundErr.message);
    // Reset to 'refund_pending'. DO NOT retry — the gateway may have already
    // processed this refund. Admin/webhook must reconcile via Razorpay API.
    newPaymentStatus = 'refund_pending';
  }

  await Booking.updateOne(
    { _id: booking._id },
    {
      $set: {
        paymentStatus: newPaymentStatus,
        ...(refundId ? { razorpayRefundId: refundId } : {})
      }
    }
  );
};

// @desc    Cancel a booking
// @route   PUT /api/bookings/:id/cancel
// @access  Private
const cancelBooking = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: 'Invalid booking ID' });
    }

    const booking = await Booking.findById(req.params.id).populate('slotIds');

    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    // Ensure user is the one who booked it or an admin
    const isOwner = booking.userId.toString() === req.user._id.toString();
    const isAdmin = req.user.role === 'admin';
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: 'Not authorized to cancel this booking' });
    }

    if (booking.bookingStatus === 'cancelled') {
      return res.status(400).json({ message: 'Booking is already cancelled' });
    }

    if (booking.bookingStatus === 'completed') {
      return res.status(400).json({ message: 'Cannot cancel a completed booking' });
    }

    const sortedSlots = [...(booking.slotIds || [])].sort((a, b) => {
      const dateA = new Date(a.date);
      const [hoursA = '0', minutesA = '0'] = (a.startTime || '').split(':');
      dateA.setHours(parseInt(hoursA, 10), parseInt(minutesA, 10), 0, 0);

      const dateB = new Date(b.date);
      const [hoursB = '0', minutesB = '0'] = (b.startTime || '').split(':');
      dateB.setHours(parseInt(hoursB, 10), parseInt(minutesB, 10), 0, 0);

      return dateA - dateB;
    });

    const firstSlot = sortedSlots[0];
    if (!firstSlot) {
      return res.status(400).json({ message: 'No slots associated with this booking' });
    }

    const matchTime = new Date(firstSlot.date);
    const [h = '0', m = '0'] = (firstSlot.startTime || '').split(':');
    matchTime.setHours(parseInt(h, 10), parseInt(m, 10), 0, 0);
    
    const now = new Date();
    const hoursDifference = (matchTime.getTime() - now.getTime()) / (1000 * 60 * 60);

    if (hoursDifference <= 0) {
      return res.status(400).json({ message: 'Cannot cancel after the match has started' });
    }

    let cancellationFee = 0;
    let refundAmount = Math.max(0, Number(booking.paidAmount) || 0);

    // Check if within 4 hours
    if (hoursDifference > 0 && hoursDifference <= 4) {
      // 10% cancellation fee on total amount
      cancellationFee = (Number(booking.totalAmount) || 0) * 0.10;
      refundAmount = (Number(booking.paidAmount) || 0) - cancellationFee;
      
      // If advance was less than the 10% fee, refund is 0 (capped at 0)
      if (refundAmount < 0) refundAmount = 0;
    }

    // Check venue active status to decide slot release behavior
    const venue = await Venue.findById(booking.venueId);
    const isVenueActive = venue && venue.isActive === true;

    // ── FIX 1 (B3/B4): Atomic cancellation claim ─────────────────────────────
    // All validations have passed. Use findOneAndUpdate with a strict condition
    // so only ONE concurrent request can claim this cancellation.
    // Any racing request will find bookingStatus != 'confirmed' and get a 400.
    const cancelledBooking = await Booking.findOneAndUpdate(
      { _id: booking._id, bookingStatus: 'confirmed' },
      { $set: { bookingStatus: 'cancelled', cancellationFee, refundAmount } },
      { new: true }
    ).populate('slotIds');

    if (!cancelledBooking) {
      return res.status(400).json({ message: 'Booking is already cancelled or not in a cancellable state' });
    }

    const slotIds = cancelledBooking.slotIds.map(slot => slot._id);

    // FIX 1 continued: Slot release (unchanged logic, uses cancelledBooking).
    // Release slots safely:
    // 1. If venue is inactive: slots must become blocked with 'Venue is inactive'
    // 2. If venue is active: ONLY slots that are currently 'booked' become 'available'
    // 3. Manually blocked slots (status: 'blocked') are NEVER converted to 'available'
    // 4. Slots belonging to other bookings are NEVER touched
    if (!isVenueActive) {
      await Slot.updateMany(
        {
          _id: { $in: slotIds },
          venueId: cancelledBooking.venueId,
          status: 'booked'
        },
        {
          $set: { status: 'blocked', blockReason: 'Venue is inactive' },
          $unset: { lockedBy: '', lockExpiresAt: '' }
        }
      );
    } else {
      await Slot.updateMany(
        {
          _id: { $in: slotIds },
          venueId: cancelledBooking.venueId,
          status: 'booked'
        },
        {
          $set: { status: 'available', blockReason: '' },
          $unset: { lockedBy: '', lockExpiresAt: '' }
        }
      );
    }

    // FIX 1: Initiate refund via atomic gate helper (non-blocking, fire-and-forget).
    // processRefundForCancelledBooking uses its own findOneAndUpdate gate so
    // even if two cancel requests reach here, only one refund is ever issued.
    if (cancelledBooking.refundAmount > 0) {
      processRefundForCancelledBooking(cancelledBooking).catch(err => {
        console.error('[REFUND] Unhandled error:', err.message);
      });
    }

    // Real-time notifications and sockets
    try {
      const io = getIO();
      if (venue) {
        const { createNotification } = require('./notificationController');

        await createNotification({
          userId: cancelledBooking.userId,
          title: 'Booking Cancelled',
          message: `Your booking at ${venue.name} has been cancelled.`,
          type: 'booking',
          link: '/dashboard',
          metadata: { bookingId: cancelledBooking._id, venueId: venue._id },
          dedupeKey: `booking:${cancelledBooking._id}:cancelled:player`
        });

        if (venue.ownerId) {
          await createNotification({
            userId: venue.ownerId,
            title: 'Booking Cancelled',
            message: `A booking at ${venue.name} has been cancelled by the player.`,
            type: 'booking',
            link: '/owner',
            metadata: { bookingId: cancelledBooking._id, venueId: venue._id },
            dedupeKey: `booking:${cancelledBooking._id}:cancelled:owner`
          });
        }

        if (io) {
          if (venue.ownerId) {
            io.to(`owner_${venue.ownerId}`).emit('bookingCancelled', {
              bookingId: cancelledBooking._id,
              venueName: venue.name
            });
          }
          io.to(`venue_${cancelledBooking.venueId}`).emit('slotStatusChanged', {
            slotIds,
            status: isVenueActive ? 'available' : 'blocked'
          });
        }
      }
    } catch (notifErr) {
      console.error('Notification error on cancel:', notifErr.message);
    }

    res.json({
      message: 'Booking cancelled successfully',
      booking: cancelledBooking
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
  cancelBooking,
  processRefundForCancelledBooking
};
