const express = require('express');
const router = express.Router();

const {
  createMatch,
  getMatches,
  getMatchById,
  joinMatch,
  startMatch,
  cancelMatch,
  getAdminMatches,
  adminUpdateMatchStatus,
  adminDeleteMatch
} = require('../controllers/matchController');
const { protect } = require('../middleware/authMiddleware');
const { authorizeRoles } = require('../middleware/roleMiddleware');

// Admin-only match control routes
router.get('/admin', protect, authorizeRoles('admin'), getAdminMatches);
router.patch('/admin/:id/status', protect, authorizeRoles('admin'), adminUpdateMatchStatus);
router.delete('/admin/:id', protect, authorizeRoles('admin'), adminDeleteMatch);

// Public / Player routes
router.post('/', protect, createMatch);
router.get('/', getMatches);
router.get('/:id', getMatchById);
router.post('/:id/join', protect, joinMatch);
router.put('/:id/start', protect, startMatch);
router.put('/:id/cancel', protect, cancelMatch);

module.exports = router;
