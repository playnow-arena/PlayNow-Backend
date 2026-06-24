const express = require('express');
const router = express.Router();
const { getMyProfile, updateMyProfile } = require('../controllers/userController');
const { protect } = require('../middleware/authMiddleware');

router.route('/me')
  .get(protect, getMyProfile)
  .patch(protect, updateMyProfile);

module.exports = router;
