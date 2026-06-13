const express = require('express');
const router = express.Router();
const { 
  createBooking, 
  getMyBookings, 
  getOwnerBookings, 
  getAdminBookings,
  collectBookingBalance,
  cancelBooking 
} = require('../controllers/bookingController');
const { protect } = require('../middleware/authMiddleware');
const { authorizeRoles } = require('../middleware/roleMiddleware');

router.route('/')
  .post(protect, createBooking);

router.route('/my')
  .get(protect, getMyBookings);

router.route('/owner')
  .get(protect, authorizeRoles('owner', 'admin'), getOwnerBookings);

router.route('/admin')
  .get(protect, authorizeRoles('admin'), getAdminBookings);

router.route('/:id/collect-balance')
  .put(protect, authorizeRoles('owner', 'admin'), collectBookingBalance);

router.route('/:id/cancel')
  .put(protect, cancelBooking);

module.exports = router;
