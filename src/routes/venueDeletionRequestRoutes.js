const express = require('express');
const router = express.Router();
const {
  createDeletionRequest,
  getMyDeletionRequests,
  getDeletionRequests,
  approveDeletionRequest,
  rejectDeletionRequest
} = require('../controllers/venueDeletionRequestController');
const { protect } = require('../middleware/authMiddleware');
const { authorizeRoles } = require('../middleware/roleMiddleware');

router.route('/')
  .post(protect, authorizeRoles('owner', 'admin'), createDeletionRequest)
  .get(protect, authorizeRoles('admin'), getDeletionRequests);

router.route('/my')
  .get(protect, authorizeRoles('owner', 'admin'), getMyDeletionRequests);

router.route('/:id/approve')
  .put(protect, authorizeRoles('admin'), approveDeletionRequest);

router.route('/:id/reject')
  .put(protect, authorizeRoles('admin'), rejectDeletionRequest);

module.exports = router;
