const express = require('express');
const router = express.Router();
const {
  createOwnerRequest,
  getOwnerRequests,
  approveOwnerRequest,
  rejectOwnerRequest
} = require('../controllers/ownerRequestController');
const { protect } = require('../middleware/authMiddleware');
const { authorizeRoles } = require('../middleware/roleMiddleware');

router.route('/')
  .post(protect, authorizeRoles('player'), createOwnerRequest)
  .get(protect, authorizeRoles('admin'), getOwnerRequests);

router.route('/:id/approve')
  .put(protect, authorizeRoles('admin'), approveOwnerRequest);

router.route('/:id/reject')
  .put(protect, authorizeRoles('admin'), rejectOwnerRequest);

module.exports = router;
