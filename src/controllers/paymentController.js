const Booking = require('../models/Booking');
const PaymentIntent = require('../models/PaymentIntent');
const Slot = require('../models/Slot');
const Venue = require('../models/Venue');
const User = require('../models/User');
const { getIO } = require('../socket');
const n8nService = require('../utils/n8nService');
const razorpayService = require('../utils/razorpayService');
const {
  sendBookingConfirmationEmail,
  sendOwnerNewBookingEmail
} = require('../utils/emailService');

const CHECKOUT_WINDOW_MS = 15 * 60 * 1000;

const fail = (message, statusCode) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
};

const normalizePaymentFields = (body = {}) => ({
  razorpayOrderId: body.razorpayOrderId || body.razorpay_order_id,
  razorpayPaymentId: body.razorpayPaymentId || body.razorpay_payment_id,
  razorpaySignature: body.razorpaySignature || body.razorpay_signature
});

const formatOrderResponse = (order) => ({
  success: true,
  order_id: order.id,
  orderId: order.id,
  amount: order.amount,
  currency: order.currency,
  key_id: razorpayService.getPublicKeyId(),
  keyId: razorpayService.getPublicKeyId()
});

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

const createStandardOrder = async (req, res) => {
  const amount = Number(req.body.amount);
  const currency = req.body.currency || 'INR';

  if (!Number.isInteger(amount) || amount < 100) {
    return res.status(400).json({ success: false, message: 'Amount must be at least 100 paise' });
  }

  const order = await razorpayService.createOrder({
    amount,
    currency,
    receipt: req.body.receipt || `playnow_${Date.now()}`,
    notes: req.body.notes || {}
  });

  return res.status(201).json(formatOrderResponse(order));
};

const getBookingContext = async ({ userId, venueId, slotIds, paymentType }) => {
  if (!venueId || !Array.isArray(slotIds) || slotIds.length === 0) {
    fail('Venue and at least one slot must be selected', 400);
  }
  if (!['full', 'advance'].includes(paymentType)) {
    fail('Payment type must be full or advance', 400);
  }

  const venue = await Venue.findOne({ _id: venueId, isActive: true });
  if (!venue) fail('Venue not found or inactive', 404);

  const uniqueSlotIds = [...new Set(slotIds.map(String))];
  if (uniqueSlotIds.length !== slotIds.length) {
    fail('Duplicate slots are not allowed', 400);
  }

  let slots = await Slot.find({ _id: { $in: uniqueSlotIds }, venueId });
  if (slots.length !== uniqueSlotIds.length) {
    fail('One or more slots do not exist for this venue', 400);
  }

  const unavailableSlot = slots.find(slot => (
    slot.status === 'booked'
    || slot.status === 'blocked'
    || (slot.status === 'locked' && slot.lockedBy?.toString() !== userId.toString())
  ));
  if (unavailableSlot) fail('One or more slots are no longer available', 409);

  const lockExpiresAt = new Date(Date.now() + CHECKOUT_WINDOW_MS);
  await Slot.updateMany(
    { _id: { $in: uniqueSlotIds }, venueId, status: 'available' },
    {
      $set: {
        status: 'locked',
        lockedBy: userId,
        lockExpiresAt
      }
    }
  );
  await Slot.updateMany(
    { _id: { $in: uniqueSlotIds }, venueId, status: 'locked', lockedBy: userId },
    { $set: { lockExpiresAt } }
  );

  slots = await Slot.find({ _id: { $in: uniqueSlotIds }, venueId });
  const ownsEveryLock = slots.every(slot => (
    slot.status === 'locked' && slot.lockedBy?.toString() === userId.toString()
  ));
  if (!ownsEveryLock) fail('Unable to secure all selected slots', 409);

  const totalAmount = slots.reduce((sum, slot) => sum + Number(slot.price), 0);
  const paidAmount = paymentType === 'advance'
    ? Math.min(totalAmount, 100 * slots.length)
    : totalAmount;

  return {
    venue,
    slots,
    slotIds: uniqueSlotIds,
    totalAmount,
    paidAmount,
    remainingAmount: totalAmount - paidAmount,
    lockExpiresAt
  };
};

const sendBookingSuccessEvents = async ({ booking, venue, slots, user }) => {
  const { createNotification } = require('./notificationController');
  const owner = venue.ownerId ? await User.findById(venue.ownerId).select('name email phone') : null;
  const eventPayload = buildBookingEventPayload({ booking, venue, slots, user });

  await createNotification({
    userId: user._id,
    title: 'Booking Confirmed',
    message: `Your booking at ${venue.name} has been successfully confirmed!`,
    type: 'booking',
    link: '/dashboard',
    metadata: eventPayload,
    dedupeKey: `booking:${booking._id}:confirmed:player`
  });
  await createNotification({
    userId: venue.ownerId,
    title: 'New Booking Received',
    message: `A new booking has been made for ${venue.name} by ${eventPayload.customerName}`,
    type: 'booking',
    link: '/owner',
    metadata: eventPayload,
    dedupeKey: `booking:${booking._id}:confirmed:owner`
  });
  await createNotification({
    userId: user._id,
    title: 'Payment Successful',
    message: `Your payment of Rs ${booking.paidAmount} for ${venue.name} was successful.`,
    type: 'booking',
    link: '/dashboard',
    metadata: {
      bookingId: booking._id,
      venueId: venue._id,
      amount: booking.paidAmount,
      razorpayPaymentId: booking.razorpayPaymentId,
      ...eventPayload
    },
    dedupeKey: `booking:${booking._id}:payment-success`
  });

  const io = getIO();
  io.to(`user_${user._id}`).emit('booking_confirmed', eventPayload);
  io.to(`owner_${venue.ownerId}`).emit('newBooking', {
    ...eventPayload
  });
  io.to(`owner_${venue.ownerId}`).emit('booking_received', eventPayload);
  io.to(`venue_${venue._id}`).emit('slotStatusChanged', {
    slotIds: booking.slotIds,
    status: 'booked'
  });

  await Promise.allSettled([
    sendBookingConfirmationEmail({
      to: user.email,
      booking,
      venue,
      slots,
      player: user
    }),
    sendOwnerNewBookingEmail({
      to: owner?.email || venue.contacts?.owner?.email,
      booking,
      venue,
      slots,
      player: user
    })
  ]);

  n8nService.sendBookingConfirmation({
    bookingId: booking._id.toString(),
    playerName: user.name || 'Unknown',
    email: user.email || 'No email provided',
    phone: user.phone || 'No phone provided',
    turfName: venue.name,
    bookingDate: slots[0]?.date
      ? new Date(slots[0].date).toISOString().split('T')[0]
      : 'Unknown Date',
    bookingTime: slots[0]?.startTime || 'Unknown Time',
    amount: booking.totalAmount,
    bookingCreatedAt: booking.createdAt?.toISOString() || new Date().toISOString()
  });
};

const createRazorpayOrder = async (req, res) => {
  try {
    if (req.body.amount !== undefined && !req.body.venueId) {
      return createStandardOrder(req, res);
    }

    if (!req.user?._id) {
      return res.status(401).json({ message: 'Login is required to create a booking payment order' });
    }

    const context = await getBookingContext({
      userId: req.user._id,
      venueId: req.body.venueId,
      slotIds: req.body.slotIds,
      paymentType: req.body.paymentType
    });

    const existingIntent = await PaymentIntent.findOne({
      userId: req.user._id,
      venueId: context.venue._id,
      slotIds: { $all: context.slotIds, $size: context.slotIds.length },
      paymentType: req.body.paymentType,
      status: 'created',
      expiresAt: { $gt: new Date() }
    });
    if (existingIntent) {
      return res.json({
        success: true,
        key_id: razorpayService.getPublicKeyId(),
        keyId: razorpayService.getPublicKeyId(),
        order_id: existingIntent.razorpayOrderId,
        orderId: existingIntent.razorpayOrderId,
        amount: Math.round(existingIntent.paidAmount * 100),
        currency: 'INR'
      });
    }

    const order = await razorpayService.createOrder({
      amount: Math.round(context.paidAmount * 100),
      currency: 'INR',
      receipt: `pn_${req.user._id.toString().slice(-8)}_${Date.now()}`,
      notes: {
        userId: req.user._id.toString(),
        venueId: context.venue._id.toString(),
        paymentType: req.body.paymentType
      }
    });

    await PaymentIntent.create({
      userId: req.user._id,
      venueId: context.venue._id,
      slotIds: context.slotIds,
      paymentType: req.body.paymentType,
      totalAmount: context.totalAmount,
      paidAmount: context.paidAmount,
      remainingAmount: context.remainingAmount,
      razorpayOrderId: order.id,
      expiresAt: context.lockExpiresAt
    });

    res.status(201).json(formatOrderResponse(order));
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.error?.description
        || error.response?.data?.error?.description
        || error.message
        || 'Unable to create payment order'
    });
  }
};

const verifyRazorpayPayment = async (req, res) => {
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = normalizePaymentFields(req.body);
  let intent;

  try {
    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return res.status(400).json({ message: 'Payment verification details are required' });
    }

    intent = req.user?._id
      ? await PaymentIntent.findOne({ razorpayOrderId, userId: req.user._id })
      : null;
    if (!intent) {
      const signatureIsValid = razorpayService.verifyPaymentSignature({
        orderId: razorpayOrderId,
        paymentId: razorpayPaymentId,
        signature: razorpaySignature
      });
      if (!signatureIsValid) {
        return res.status(400).json({ success: false, message: 'Payment signature verification failed' });
      }

      return res.json({
        success: true,
        razorpay_order_id: razorpayOrderId,
        razorpay_payment_id: razorpayPaymentId
      });
    }

    if (intent.status === 'completed' && intent.bookingId) {
      const existingBooking = await Booking.findById(intent.bookingId);
      if (!existingBooking) {
        return res.status(404).json({ success: false, message: 'Booking not found for this payment' });
      }
      return res.json({ success: true, booking: existingBooking, ...existingBooking.toObject() });
    }

    const signatureIsValid = razorpayService.verifyPaymentSignature({
      orderId: razorpayOrderId,
      paymentId: razorpayPaymentId,
      signature: razorpaySignature
    });
    if (!signatureIsValid) {
      return res.status(400).json({ success: false, message: 'Payment signature verification failed' });
    }

    const payment = await razorpayService.getPayment(razorpayPaymentId);
    if (
      payment.order_id !== razorpayOrderId
      || payment.amount !== Math.round(intent.paidAmount * 100)
      || payment.currency !== 'INR'
      || payment.status !== 'captured'
    ) {
      return res.status(400).json({ success: false, message: 'Payment could not be verified as captured' });
    }

    const existingBooking = await Booking.findOne({
      $or: [{ razorpayOrderId }, { razorpayPaymentId }]
    });
    if (existingBooking) {
      if (existingBooking.userId.toString() !== req.user._id.toString()) {
        return res.status(409).json({ message: 'Payment is already linked to another booking' });
      }
      await PaymentIntent.updateOne(
        { _id: intent._id },
        {
          $set: {
            status: 'completed',
            bookingId: existingBooking._id,
            razorpayPaymentId
          }
        }
      );
      return res.json({ success: true, booking: existingBooking, ...existingBooking.toObject() });
    }

    intent = await PaymentIntent.findOneAndUpdate(
      { _id: intent._id, status: 'created' },
      { $set: { status: 'processing', razorpayPaymentId } },
      { new: true }
    );
    if (!intent) {
      return res.status(409).json({ message: 'Payment is already being processed' });
    }

    const slots = await Slot.find({ _id: { $in: intent.slotIds }, venueId: intent.venueId });
    const ownsEveryLock = slots.length === intent.slotIds.length && slots.every(slot => (
      slot.status === 'locked' && slot.lockedBy?.toString() === req.user._id.toString()
    ));
    if (!ownsEveryLock) {
      await PaymentIntent.updateOne(
        { _id: intent._id },
        { $set: { status: 'failed' } }
      );
      return res.status(409).json({ message: 'Selected slots are no longer reserved' });
    }

    const slotUpdate = await Slot.updateMany(
      {
        _id: { $in: intent.slotIds },
        venueId: intent.venueId,
        status: 'locked',
        lockedBy: req.user._id
      },
      {
        $set: { status: 'booked' },
        $unset: { lockedBy: '', lockExpiresAt: '' }
      }
    );
    if (slotUpdate.modifiedCount !== intent.slotIds.length) {
      await Slot.updateMany(
        { _id: { $in: intent.slotIds }, status: 'booked' },
        {
          $set: {
            status: 'locked',
            lockedBy: req.user._id,
            lockExpiresAt: new Date(Date.now() + CHECKOUT_WINDOW_MS)
          }
        }
      );
      throw new Error('Unable to finalize selected slots');
    }

    let booking;
    try {
      booking = await Booking.create({
        userId: req.user._id,
        venueId: intent.venueId,
        slotIds: intent.slotIds,
        totalAmount: intent.totalAmount,
        paymentType: intent.paymentType,
        paidAmount: intent.paidAmount,
        remainingAmount: intent.remainingAmount,
        bookingStatus: 'confirmed',
        paymentStatus: intent.remainingAmount > 0 ? 'advance_paid' : 'completed',
        razorpayOrderId,
        razorpayPaymentId
      });
    } catch (error) {
      await Slot.updateMany(
        { _id: { $in: intent.slotIds }, status: 'booked' },
        {
          $set: {
            status: 'locked',
            lockedBy: req.user._id,
            lockExpiresAt: new Date(Date.now() + CHECKOUT_WINDOW_MS)
          }
        }
      );
      throw error;
    }

    await PaymentIntent.updateOne(
      { _id: intent._id },
      { $set: { status: 'completed', bookingId: booking._id } }
    );

    const venue = await Venue.findById(intent.venueId);
    try {
      await sendBookingSuccessEvents({ booking, venue, slots, user: req.user });
    } catch (eventError) {
      console.error('[PAYMENT] Booking confirmed but success event failed:', eventError.message);
    }

    res.status(201).json({ success: true, booking, ...booking.toObject() });
  } catch (error) {
    if (intent?.status === 'processing') {
      await PaymentIntent.updateOne(
        { _id: intent._id, status: 'processing' },
        { $set: { status: 'created' } }
      );
    }
    res.status(error.code === 11000 ? 409 : 500).json({
      success: false,
      message: error.code === 11000
        ? 'Payment has already been used for a booking'
        : error.message
    });
  }
};

module.exports = {
  createRazorpayOrder,
  verifyRazorpayPayment
};
