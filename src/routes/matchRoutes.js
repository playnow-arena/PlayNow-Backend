const express = require('express');
const router = express.Router();

const { createMatch, getMatches, joinMatch } = require('../controllers/matchController');
const { protect } = require('../middleware/authMiddleware');

router.post('/', protect, createMatch);
router.get('/', getMatches);
router.post('/:id/join', protect, joinMatch);

module.exports = router;