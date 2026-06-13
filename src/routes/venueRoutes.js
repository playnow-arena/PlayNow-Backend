const express = require('express');
const router = express.Router();
const { 
  getVenues, 
  getVenueById, 
  getMyVenues,
  createVenue, 
  updateVenue, 
  deleteVenue 
} = require('../controllers/venueController');
const { protect } = require('../middleware/authMiddleware');
const { authorizeRoles } = require('../middleware/roleMiddleware');

router.route('/')
  .get(getVenues)
  .post(protect, authorizeRoles('owner', 'admin'), createVenue);

router.route('/my')
  .get(protect, authorizeRoles('owner', 'manager', 'admin'), getMyVenues);

router.route('/:id')
  .get(getVenueById)
  .put(protect, authorizeRoles('owner', 'admin'), updateVenue)
  .delete(protect, authorizeRoles('owner', 'admin'), deleteVenue);

module.exports = router;
