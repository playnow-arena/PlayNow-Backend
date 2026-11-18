const mongoose = require('mongoose');
const VenueDeletionRequest = require('../models/VenueDeletionRequest');
const Venue = require('../models/Venue');
const Slot = require('../models/Slot');
const syncOwnerRole = require('../utils/syncOwnerRole');
const { createNotification } = require('./notificationController');

// @desc    Submit a venue deletion request
// @route   POST /api/venue-deletion-requests
// @access  Private (Owner / Admin)
const createDeletionRequest = async (req, res) => {
  try {
    const { venueId, reason } = req.body;

    if (!venueId) {
      return res.status(400).json({ message: 'Venue ID is required' });
    }

    if (!reason || !reason.trim() || reason.trim().length < 5) {
      return res.status(400).json({ message: 'Please provide a deletion reason (at least 5 characters)' });
    }

    const venue = await Venue.findById(venueId);
    if (!venue) {
      return res.status(404).json({ message: 'Venue not found' });
    }

    // Ensure the user owns this venue (admins can also submit on behalf)
    if (venue.ownerId.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'You can only request deletion for your own venues' });
    }

    // Application-level pre-check for a friendly error message.
    // The unique partial index below provides the atomic enforcement backstop.
    const existingPending = await VenueDeletionRequest.findOne({
      venueId: venue._id,
      status: 'pending'
    });

    if (existingPending) {
      return res.status(409).json({ message: 'A deletion request is already pending for this venue' });
    }

    let deletionRequest;
    try {
      deletionRequest = await VenueDeletionRequest.create({
        venueId: venue._id,
        venueName: venue.name,
        ownerId: venue.ownerId,
        reason: reason.trim(),
        status: 'pending'
      });
    } catch (createErr) {
      // Duplicate-key error from the unique partial index (race condition backstop)
      if (createErr.code === 11000) {
        return res.status(409).json({ message: 'A deletion request is already pending for this venue' });
      }
      throw createErr;
    }

    // Notify the owner that request is received
    try {
      await createNotification({
        userId: venue.ownerId,
        title: 'Venue Deletion Request Submitted',
        message: `Your deletion request for "${venue.name}" has been received and is pending admin review.`,
        type: 'venue',
        link: '/owner',
        metadata: { deletionRequestId: deletionRequest._id, venueId: venue._id },
        dedupeKey: `deletion-request:${deletionRequest._id}:submitted`
      });
    } catch (notifErr) {
      console.warn('⚠️ [NOTIFICATION] Failed to send submission notification:', notifErr.message);
    }

    res.status(201).json(deletionRequest);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Get current owner's deletion requests
// @route   GET /api/venue-deletion-requests/my
// @access  Private (Owner / Admin)
const getMyDeletionRequests = async (req, res) => {
  try {
    const query = req.user.role === 'admin' ? {} : { ownerId: req.user._id };
    const requests = await VenueDeletionRequest.find(query)
      .sort({ createdAt: -1 })
      .populate('venueId', 'name location city area venueCode isActive')
      .populate('reviewedBy', 'name playNowId');

    res.json(requests);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all venue deletion requests (with optional status filter)
// @route   GET /api/venue-deletion-requests
// @access  Private (Admin)
const getDeletionRequests = async (req, res) => {
  try {
    const { status } = req.query;
    const query = {};
    if (status) {
      query.status = status;
    }

    const requests = await VenueDeletionRequest.find(query)
      .sort({ createdAt: -1 })
      .populate('venueId', 'name location city area venueCode isActive pricePerHour sportTypes')
      .populate('ownerId', 'name phone email playNowId')
      .populate('reviewedBy', 'name playNowId');

    res.json(requests);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Approve a venue deletion request
// @route   PUT /api/venue-deletion-requests/:id/approve
// @access  Private (Admin)
const approveDeletionRequest = async (req, res) => {
  const session = await mongoose.startSession();
  let claimed = null;

  try {
    await session.withTransaction(async () => {
      // ── Step 1: Atomic claim INSIDE the transaction session ────────────────
      // Conditional findOneAndUpdate under session guarantees that only one admin
      // can claim a pending request, and any subsequent failure automatically
      // rolls back the status change without requiring compensating writes.
      claimed = await VenueDeletionRequest.findOneAndUpdate(
        { _id: req.params.id, status: 'pending' },
        {
          $set: {
            status: 'approved',
            reviewedBy: req.user._id,
            reviewedAt: new Date(),
            adminResponse: req.body.adminResponse || 'Approved by administrator'
          }
        },
        { returnDocument: 'after', session }
      );

      if (!claimed) {
        // Query under the same session to determine whether 404 Not Found or 409 Conflict
        const existing = await VenueDeletionRequest.findById(req.params.id).session(session);
        if (!existing) {
          const err = new Error('Deletion request not found');
          err.statusCode = 404;
          throw err;
        }
        const err = new Error(`Deletion request has already been ${existing.status}`);
        err.statusCode = 409;
        throw err;
      }

      // ── Step 2: Transactional side-effects under the same session ───────────
      const venue = await Venue.findById(claimed.venueId).session(session);
      if (venue) {
        venue.isActive = false;
        await venue.save({ session });

        // Block unbooked future available slots; booked slots are intentionally preserved
        await Slot.updateMany(
          { venueId: venue._id, status: 'available' },
          { $set: { status: 'blocked', blockReason: 'Venue deletion approved' } },
          { session }
        );

        // Also block any lingering locked slots so they cannot be booked
        await Slot.updateMany(
          { venueId: venue._id, status: 'locked' },
          {
            $set: { status: 'blocked', blockReason: 'Venue deletion approved' },
            $unset: { lockedBy: '', lockExpiresAt: '' }
          },
          { session }
        );

        // Re-evaluate owner's role under the same transaction session
        await syncOwnerRole(venue.ownerId, { session });
      }
    });
  } catch (txErr) {
    // If it's a deliberate early abort (404 Not Found or 409 Conflict), return immediately
    if (txErr.statusCode) {
      return res.status(txErr.statusCode).json({ message: txErr.message });
    }

    // Determine whether this is a topology/transaction-support error
    const isTopologyError = (
      txErr.code === 20 ||                              // IllegalOperation
      txErr.codeName === 'IllegalOperation' ||
      txErr.message?.includes('replica set') ||
      txErr.message?.includes('Transaction numbers') ||
      txErr.message?.includes('standalone')
    );

    if (isTopologyError) {
      return res.status(500).json({
        message:
          'Transaction support is not available on this MongoDB deployment. ' +
          'Please connect to a replica set or Atlas cluster to safely approve deletion requests.'
      });
    }

    // Any other failure: withTransaction has natively rolled back all writes (including claim)
    return res.status(500).json({
      message: `Approval transaction failed and was rolled back: ${txErr.message}`
    });
  } finally {
    session.endSession();
  }

  // ── Step 3: Post-commit notification (executed strictly after successful commit) ──
  try {
    await createNotification({
      userId: claimed.ownerId,
      title: 'Venue Deletion Approved',
      message: `Your deletion request for "${claimed.venueName || 'your venue'}" has been approved. The venue has been deactivated.`,
      type: 'venue',
      link: '/owner',
      metadata: { deletionRequestId: claimed._id, venueId: claimed.venueId },
      dedupeKey: `deletion-request:${claimed._id}:approved`
    });
  } catch (notifErr) {
    console.warn('⚠️ [NOTIFICATION] Failed to send approval notification:', notifErr.message);
  }

  const populated = await VenueDeletionRequest.findById(claimed._id)
    .populate('venueId', 'name location city area venueCode isActive')
    .populate('ownerId', 'name phone email playNowId')
    .populate('reviewedBy', 'name playNowId');

  res.json(populated);
};

// @desc    Reject a venue deletion request
// @route   PUT /api/venue-deletion-requests/:id/reject
// @access  Private (Admin)
const rejectDeletionRequest = async (req, res) => {
  try {
    const { rejectionReason } = req.body;

    if (!rejectionReason || !rejectionReason.trim()) {
      return res.status(400).json({ message: 'Rejection reason is required' });
    }

    // Atomic pending → rejected transition. Only succeeds if status is currently 'pending'.
    // Prevents concurrent approve + reject from both succeeding.
    const updated = await VenueDeletionRequest.findOneAndUpdate(
      { _id: req.params.id, status: 'pending' },
      {
        $set: {
          status: 'rejected',
          reviewedBy: req.user._id,
          reviewedAt: new Date(),
          rejectionReason: rejectionReason.trim(),
          adminResponse: rejectionReason.trim()
        }
      },
      { returnDocument: 'after' }
    );

    if (!updated) {
      const existing = await VenueDeletionRequest.findById(req.params.id);
      if (!existing) {
        return res.status(404).json({ message: 'Deletion request not found' });
      }
      return res.status(409).json({
        message: `Deletion request has already been ${existing.status}`
      });
    }

    // Notify the owner
    try {
      await createNotification({
        userId: updated.ownerId,
        title: 'Venue Deletion Request Rejected',
        message: `Your deletion request for "${updated.venueName || 'your venue'}" was rejected: ${rejectionReason.trim()}`,
        type: 'venue',
        link: '/owner',
        metadata: { deletionRequestId: updated._id, venueId: updated.venueId },
        dedupeKey: `deletion-request:${updated._id}:rejected`
      });
    } catch (notifErr) {
      console.warn('⚠️ [NOTIFICATION] Failed to send rejection notification:', notifErr.message);
    }

    const populated = await VenueDeletionRequest.findById(updated._id)
      .populate('venueId', 'name location city area venueCode isActive')
      .populate('ownerId', 'name phone email playNowId')
      .populate('reviewedBy', 'name playNowId');

    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  createDeletionRequest,
  getMyDeletionRequests,
  getDeletionRequests,
  approveDeletionRequest,
  rejectDeletionRequest
};
