const express = require('express');
const router = express.Router();
const { 
  getSlotsByVenue, 
  createSlots, 
  generateSlots,
  blockSlot,
  getManagedSlots,
  updateSlotStatus,
  lockSlots,
  unlockSlots,
  emergencyClose
} = require('../controllers/slotController');
const { protect } = require('../middleware/authMiddleware');
const { authorizeRoles } = require('../middleware/roleMiddleware');

router.route('/')
  .post(protect, authorizeRoles('owner', 'manager', 'admin'), createSlots);

router.route('/generate')
  .post(protect, authorizeRoles('owner', 'manager', 'admin'), generateSlots);

router.route('/venue/:venueId')
  .get(getSlotsByVenue);

router.route('/manage')
  .get(protect, authorizeRoles('owner', 'manager', 'admin'), getManagedSlots);

router.route('/lock')
  .post(protect, lockSlots);

router.route('/unlock')
  .post(protect, unlockSlots);

router.route('/emergency-close')
  .post(protect, authorizeRoles('owner', 'manager', 'admin'), emergencyClose);

router.route('/:id/block')
  .put(protect, authorizeRoles('owner', 'manager', 'admin'), blockSlot);

router.route('/:id')
  .put(protect, authorizeRoles('owner', 'manager', 'admin'), updateSlotStatus);

module.exports = router;
