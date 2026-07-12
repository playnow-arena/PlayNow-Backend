const express = require('express');
const router = express.Router();
const {
  getNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  deleteNotification,
  markSelectedRead,
  deleteSelected,
  getAdminMetrics,
  upsertFcmToken
} = require('../controllers/notificationController');
const { protect } = require('../middleware/authMiddleware');

router.use(protect);

router.route('/')
  .get(getNotifications);

router.route('/unread-count')
  .get(getUnreadCount);

router.route('/read-all')
  .patch(markAllRead);

router.route('/admin-metrics')
  .get(getAdminMetrics);

router.route('/read-selected')
  .patch(markSelectedRead);

router.route('/delete-selected')
  .post(deleteSelected);

router.route('/fcm-token')
  .post(upsertFcmToken);

router.route('/:id/read')
  .patch(markRead);

router.route('/:id')
  .delete(deleteNotification);

module.exports = router;
