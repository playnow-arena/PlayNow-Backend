const mongoose = require('mongoose');
const Slot = require('../models/Slot');
const Booking = require('../models/Booking');

/**
 * recoverOrphanedSlots
 *
 * Scans for slots in status='booked' with a non-null claimToken that:
 * 1. Have been stuck for longer than `maxAgeMs` (default: 5 minutes)
 * 2. Are NOT referenced by any existing Booking in its `slotIds` array
 *
 * Safeguards:
 * - Does not touch recent claims (active booking attempts).
 * - Verifies no Booking references the slot in the database.
 * - Uses atomic findOneAndUpdate matching the exact claimToken and status='booked'
 *   so a concurrent completion or new claim cannot be overwritten.
 * - Preserves manually blocked slots, available slots, and legitimately booked slots.
 * - Returns details of all recovered slots for admin logging/audit.
 *
 * @param {Object} options
 * @param {number} [options.maxAgeMs=300000] - Minimum age of orphaned claim (5 mins)
 * @returns {Promise<Array<{ slotId: string, claimToken: string, venueId: string }>>}
 */
const recoverOrphanedSlots = async ({ maxAgeMs = 5 * 60 * 1000 } = {}) => {
  const safetyCutoff = new Date(Date.now() - maxAgeMs);

  // 1. Find candidate slots with old claims
  const candidates = await Slot.find({
    status: 'booked',
    claimToken: { $ne: null },
    updatedAt: { $lte: safetyCutoff }
  }).lean();

  if (!candidates || candidates.length === 0) {
    return [];
  }

  const candidateIds = candidates.map(s => s._id);

  // 2. Query bookings that reference any of these candidate slot IDs
  const activeBookings = await Booking.find({
    slotIds: { $in: candidateIds }
  }).select('slotIds').lean();

  const bookedSlotIdSet = new Set();
  for (const b of activeBookings) {
    if (Array.isArray(b.slotIds)) {
      for (const id of b.slotIds) {
        bookedSlotIdSet.add(id.toString());
      }
    }
  }

  const recovered = [];

  // 3. Atomically recover only confirmed orphaned slots
  for (const candidate of candidates) {
    const candidateIdStr = candidate._id.toString();

    // If an existing booking references this slot, it's NOT orphaned!
    if (bookedSlotIdSet.has(candidateIdStr)) {
      continue;
    }

    // Recheck immediately before release; a booking may have appeared since
    // the batch query. Cancelled bookings no longer own the slot.
    if (await Booking.exists({ slotIds: candidate._id, bookingStatus: { $ne: 'cancelled' } })) {
      continue;
    }

    // Atomically reset slot ONLY if it still has the exact claimToken and status='booked'
    const updated = await Slot.findOneAndUpdate(
      {
        _id: candidate._id,
        status: 'booked',
        claimToken: candidate.claimToken,
        updatedAt: { $lte: safetyCutoff }
      },
      {
        $set: { status: 'available' },
        $unset: { claimToken: '', lockedBy: '', lockExpiresAt: '' }
      },
      { new: true }
    );

    if (updated) {
      console.warn(`[ORPHAN_RECOVERY] Recovered orphaned slot: ${candidate._id} (claimToken: ${candidate.claimToken}, venue: ${candidate.venueId})`);
      recovered.push({
        slotId: candidate._id.toString(),
        claimToken: candidate.claimToken,
        venueId: candidate.venueId?.toString()
      });
    }
  }

  return recovered;
};

module.exports = {
  recoverOrphanedSlots
};
