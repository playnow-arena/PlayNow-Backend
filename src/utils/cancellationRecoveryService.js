const Booking = require('../models/Booking');
const Slot = require('../models/Slot');
const Venue = require('../models/Venue');
const { processRefundForCancelledBooking } = require('../controllers/bookingController');
const razorpayService = require('./razorpayService');

// Replays idempotent post-cancellation work after a process restart.
const recoverCancelledBookings = async () => {
  const staleSlotCutoff = new Date(Date.now() - 5 * 60 * 1000);
  const bookings = await Booking.find({ bookingStatus: 'cancelled' }).select(
    '_id venueId slotIds refundAmount paymentStatus razorpayPaymentId'
  ).lean();

  for (const booking of bookings) {
    try {
      const [venue, otherActiveBooking] = await Promise.all([
        Venue.findById(booking.venueId).select('isActive').lean(),
        Booking.exists({
          _id: { $ne: booking._id },
          slotIds: { $in: booking.slotIds },
          bookingStatus: { $ne: 'cancelled' }
        })
      ]);

      if (!otherActiveBooking && booking.slotIds.length) {
        const slotQuery = {
          _id: { $in: booking.slotIds },
          venueId: booking.venueId,
          status: 'booked',
          updatedAt: { $lte: staleSlotCutoff },
          claimToken: null
        };
        if (venue?.isActive) {
          await Slot.updateMany(slotQuery, {
            $set: { status: 'available', blockReason: '' },
            $unset: { claimToken: '', lockedBy: '', lockExpiresAt: '' }
          });
        } else {
          await Slot.updateMany(slotQuery, {
            $set: { status: 'blocked', blockReason: 'Venue is inactive' },
            $unset: { claimToken: '', lockedBy: '', lockExpiresAt: '' }
          });
        }
      }

      if (Number(booking.refundAmount) > 0 && !['refunded', 'refund_pending', 'refund_processing'].includes(booking.paymentStatus)) {
        await processRefundForCancelledBooking(booking);
      }
    } catch (error) {
      console.error(`[CANCELLATION_RECOVERY] Booking ${booking._id} needs investigation:`, error.message);
    }
  }

  // Reconcile only refunds with a known gateway ID. A processed status comes
  // from Razorpay's authenticated API response, never from client input.
  const pendingRefunds = await Booking.find({
    bookingStatus: 'cancelled',
    paymentStatus: 'refund_pending',
    razorpayRefundId: { $exists: true, $ne: '' }
  }).select('_id razorpayRefundId').lean();
  for (const booking of pendingRefunds) {
    try {
      const refund = await razorpayService.getRefund(booking.razorpayRefundId);
      if (refund?.status === 'processed') {
        await Booking.updateOne(
          { _id: booking._id, paymentStatus: 'refund_pending', razorpayRefundId: booking.razorpayRefundId },
          { $set: { paymentStatus: 'refunded' } }
        );
      }
    } catch (error) {
      console.error(`[REFUND_RECONCILIATION] Booking ${booking._id} lookup failed:`, error.message);
    }
  }

  // A crash after claiming refund_processing has an unknown gateway outcome.
  // Move old claims to the visible manual-reconciliation state; never retry them.
  const staleCutoff = new Date(Date.now() - 10 * 60 * 1000);
  const stale = await Booking.updateMany(
    { bookingStatus: 'cancelled', paymentStatus: 'refund_processing', updatedAt: { $lte: staleCutoff } },
    { $set: { paymentStatus: 'refund_pending' } }
  );
  if (stale.modifiedCount) {
    console.warn(`[CANCELLATION_RECOVERY] ${stale.modifiedCount} stale refund(s) moved to refund_pending for reconciliation`);
  }
};

module.exports = { recoverCancelledBookings };
