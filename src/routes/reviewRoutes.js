const express = require('express');
const router  = express.Router();

const {
  getReviewsByVenue,
  createReview,
  updateReview,
  deleteReview
} = require('../controllers/reviewController');

const { protect } = require('../middleware/authMiddleware');

// GET  /api/reviews/:venueId   → all reviews for a venue (public)
// POST /api/reviews/:venueId   → create a review (authenticated)
router.route('/:venueId')
  .get(getReviewsByVenue)
  .post(protect, createReview);

// PUT    /api/reviews/review/:id  → edit own review (authenticated)
// DELETE /api/reviews/review/:id  → delete review (owner or admin)
router.route('/review/:id')
  .put(protect, updateReview)
  .delete(protect, deleteReview);

module.exports = router;
