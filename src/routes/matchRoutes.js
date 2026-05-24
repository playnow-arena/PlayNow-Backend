const express = require('express');
const router = express.Router();

const { createMatch, getMatches } = require('../controllers/matchController');
const { protect } = require('../middleware/authMiddleware');

router.post('/', protect, createMatch);
router.get('/', getMatches);

module.exports = router;