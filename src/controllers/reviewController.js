const Review = require('../models/Review');
const Venue  = require('../models/Venue');

// ─────────────────────────────────────────────────────────
// Helper: recalculate and persist venue rating + reviewsCount
// Called after any create / update / delete operation.
// ─────────────────────────────────────────────────────────
const recalcVenueRating = async (venueId) => {
  const allReviews = await Review.find({ venue: venueId });

  if (allReviews.length === 0) {
    // Safe guard: no reviews → reset to defaults
    await Venue.findByIdAndUpdate(venueId, { rating: 5, reviewsCount: 0 });
    return;
  }

  const total = allReviews.reduce((sum, r) => sum + r.rating, 0);
  const avg   = total / allReviews.length;

  await Venue.findByIdAndUpdate(venueId, {
    rating:       Math.round(avg * 10) / 10,
    reviewsCount: allReviews.length
  });
};

// ─────────────────────────────────────────────────────────
// Helper: build rating-distribution map (future analytics)
// Returns { 1: n, 2: n, 3: n, 4: n, 5: n }
// ─────────────────────────────────────────────────────────
const buildRatingDistribution = (reviews) => {
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  reviews.forEach((r) => {
    const star = Math.round(r.rating);
    if (dist[star] !== undefined) dist[star]++;
  });
  return dist;
};

// ─────────────────────────────────────────────────────────
// @desc    Get all reviews for a venue (with rating distribution)
// @route   GET /api/reviews/:venueId
// @access  Public
// ─────────────────────────────────────────────────────────
const getReviewsByVenue = async (req, res) => {
  try {
    const reviews = await Review.find({ venue: req.params.venueId })
      .populate('user', 'name playNowId profilePhoto')
      .sort({ createdAt: -1 });

    const ratingDistribution = buildRatingDistribution(reviews);

    res.json({
      count:              reviews.length,
      ratingDistribution, // structured for future analytics dashboards
      reviews
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─────────────────────────────────────────────────────────
// @desc    Create a review for a venue
// @route   POST /api/reviews/:venueId
// @access  Private (any authenticated user)
// ─────────────────────────────────────────────────────────
const createReview = async (req, res) => {
  try {
    const { venueId } = req.params;
    const { rating, comment } = req.body;

    // Validate that the venue exists
    const venue = await Venue.findById(venueId);
    if (!venue) {
      return res.status(404).json({ message: 'Venue not found' });
    }

    // Controller-level duplicate guard (DB index is the final safety net)
    const existing = await Review.findOne({ venue: venueId, user: req.user._id });
    if (existing) {
      return res.status(400).json({
        message: 'You have already reviewed this venue. Edit your existing review instead.'
      });
    }

    const review = await Review.create({
      venue: venueId,
      user:  req.user._id,
      rating,
      comment: comment || ''
    });

    await recalcVenueRating(venueId);

    // Create persistent notification for the venue owner
    if (venue.ownerId) {
      const { createNotification } = require('./notificationController');
      await createNotification({
        userId: venue.ownerId,
        title: 'New Review Submitted',
        message: `A user has rated "${venue.name}" with ${rating} stars!`,
        type: 'review',
        link: `/owner`, // Owner Dashboard path for checking details
        metadata: { reviewId: review._id, venueId },
        dedupeKey: `review:${review._id}:received`
      });
    }

    // Populate user info before returning
    const populated = await review.populate('user', 'name playNowId profilePhoto');

    res.status(201).json(populated);
  } catch (error) {
    // Catch MongoDB duplicate-key error (E11000) as a safety net
    if (error.code === 11000) {
      return res.status(400).json({
        message: 'You have already reviewed this venue. Edit your existing review instead.'
      });
    }
    res.status(400).json({ message: error.message });
  }
};

// ─────────────────────────────────────────────────────────
// @desc    Update own review
// @route   PUT /api/reviews/:id
// @access  Private (review owner only)
// ─────────────────────────────────────────────────────────
const updateReview = async (req, res) => {
  try {
    let review = await Review.findById(req.params.id);
    if (!review) {
      return res.status(404).json({ message: 'Review not found' });
    }

    // Only the author may edit their review
    if (review.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to edit this review' });
    }

    const { rating, comment } = req.body;
    if (rating !== undefined) review.rating  = rating;
    if (comment !== undefined) review.comment = comment;

    await review.save();
    await recalcVenueRating(review.venue);

    const populated = await review.populate('user', 'name playNowId profilePhoto');
    res.json(populated);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// ─────────────────────────────────────────────────────────
// @desc    Delete a review
// @route   DELETE /api/reviews/:id
// @access  Private (review owner OR admin)
// ─────────────────────────────────────────────────────────
const deleteReview = async (req, res) => {
  try {
    const review = await Review.findById(req.params.id);
    if (!review) {
      return res.status(404).json({ message: 'Review not found' });
    }

    const isOwner = review.user.toString() === req.user._id.toString();
    const isAdmin = req.user.role === 'admin';

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: 'Not authorized to delete this review' });
    }

    const { venue } = review;
    await review.deleteOne();
    await recalcVenueRating(venue);

    res.json({ message: 'Review deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getReviewsByVenue,
  createReview,
  updateReview,
  deleteReview
};
