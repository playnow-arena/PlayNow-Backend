const express = require('express');
const router = express.Router();
const { 
  getSlotsByVenue, 
  createSlots, 
  generateSlots,
  blockSlot,
  lockSlots,
  unlockSlots,
  emergencyClose
} = require('../controllers/slotController');
const { protect } = require('../middleware/authMiddleware');
const { authorizeRoles } = require('../middleware/roleMiddleware');

router.route('/')
  .post(protect, authorizeRoles('owner', 'admin'), createSlots);

router.route('/generate')
  .post(protect, authorizeRoles('owner', 'admin'), generateSlots);

router.route('/venue/:venueId')
  .get(getSlotsByVenue);

router.route('/lock')
  .post(protect, lockSlots);

router.route('/unlock')
  .post(protect, unlockSlots);

router.route('/emergency-close')
  .post(protect, authorizeRoles('owner', 'admin'), emergencyClose);

router.route('/:id/block')
  .put(protect, authorizeRoles('owner', 'admin'), blockSlot);

module.exports = router;
