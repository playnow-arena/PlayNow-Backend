const express = require('express');
const router = express.Router();

const { createMatch, getMatches, getMatchById, joinMatch, startMatch, cancelMatch } = require('../controllers/matchController');
const { protect } = require('../middleware/authMiddleware');

router.post('/', protect, createMatch);
router.get('/', getMatches);
router.get('/:id', getMatchById);
router.post('/:id/join', protect, joinMatch);
router.put('/:id/start', protect, startMatch);
router.put('/:id/cancel', protect, cancelMatch);

module.exports = router;
