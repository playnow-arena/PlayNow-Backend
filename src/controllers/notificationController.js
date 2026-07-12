const Notification = require('../models/Notification');
const User = require('../models/User');
const { getIO } = require('../socket');

const normalizeFcmToken = (token) => String(token || '').trim();

const isValidFcmToken = (token) => {
  const normalized = normalizeFcmToken(token);
  return normalized.length >= 20 && normalized.length <= 4096;
};

const saveFcmTokenForUser = async (userId, token) => {
  const normalizedToken = normalizeFcmToken(token);
  if (!isValidFcmToken(normalizedToken)) {
    const error = new Error('Valid FCM token is required');
    error.statusCode = 400;
    throw error;
  }

  // A browser token belongs to one logged-in user at a time. Remove it globally
  // first, then add it to the current user without duplicating existing tokens.
  await User.updateMany(
    { fcmTokens: normalizedToken },
    { $pull: { fcmTokens: normalizedToken } }
  );

  const updatedUser = await User.findByIdAndUpdate(
    userId,
    { $addToSet: { fcmTokens: normalizedToken } },
    { new: true, select: '+fcmTokens' }
  );

  return updatedUser?.fcmTokens || [];
};

const removeFcmTokensForUser = async (userId, tokens = []) => {
  const normalizedTokens = (Array.isArray(tokens) ? tokens : [tokens])
    .map(normalizeFcmToken)
    .filter(Boolean);

  if (normalizedTokens.length === 0) {
    const error = new Error('At least one FCM token is required');
    error.statusCode = 400;
    throw error;
  }

  const updatedUser = await User.findByIdAndUpdate(
    userId,
    { $pull: { fcmTokens: { $in: normalizedTokens } } },
    { new: true, select: '+fcmTokens' }
  );

  return updatedUser?.fcmTokens || [];
};

const createNotification = async ({
  userId,
  title,
  message,
  type,
  link = '',
  metadata = {},
  dedupeKey
}) => {
  try {
    // Check User preferences
    const User = require('../models/User');
    const user = await User.findById(userId);
    if (user && user.notificationPreferences) {
      const prefCategory = (type === 'booking' || type === 'match' || type === 'review' || type === 'system') ? type : null;
      if (prefCategory && user.notificationPreferences[prefCategory] === false) {
        console.log(`ℹ️ [NOTIFICATION] Skipped creating ${type} notification for ${userId} due to preference settings.`);
        return null;
      }
    }

    // Basic duplication guard for duplicate-sensitive events within a 1-minute window
    if (!dedupeKey && (type === 'booking' || type === 'match')) {
      const oneMinuteAgo = new Date(Date.now() - 60000);
      const duplicate = await Notification.findOne({
        userId,
        title,
        message,
        type,
        createdAt: { $gte: oneMinuteAgo }
      });
      if (duplicate) return duplicate;
    }

    const notification = await Notification.create({
      userId,
      title,
      message,
      type,
      link,
      metadata,
      dedupeKey
    });

    try {
      const io = getIO();
      io.to(`user_${userId}`).emit('new_notification', notification);
    } catch (err) {
      console.warn('⚠️ [NOTIFICATION] Socket broadcast failed (socket may not be initialized yet):', err.message);
    }

    return notification;
  } catch (error) {
    if (error.code === 11000 && dedupeKey) {
      return Notification.findOne({ userId, dedupeKey });
    }
    console.error('❌ [NOTIFICATION] Error creating notification:', error.message);
  }
};

// @desc    Save or remove FCM token for current user/device
// @route   POST /api/notifications/fcm-token
// @access  Private
const upsertFcmToken = async (req, res) => {
  try {
    const { token, tokens, action = 'save' } = req.body;

    if (action === 'remove') {
      const remainingTokens = await removeFcmTokensForUser(req.user._id, tokens || token);
      return res.json({
        message: 'FCM token removed',
        tokenCount: remainingTokens.length
      });
    }

    const userTokens = await saveFcmTokenForUser(req.user._id, token);
    return res.json({
      message: 'FCM token saved',
      tokenCount: userTokens.length
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const getNotifications = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const skip = (page - 1) * limit;

    const query = { userId: req.user._id };

    if (req.query.type) {
      query.type = req.query.type;
    }

    if (req.query.search) {
      query.$or = [
        { title: { $regex: req.query.search, $options: 'i' } },
        { message: { $regex: req.query.search, $options: 'i' } }
      ];
    }

    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Notification.countDocuments(query);

    res.json({
      notifications,
      page,
      pages: Math.ceil(total / limit),
      total
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get unread notification count
// @route   GET /api/notifications/unread-count
// @access  Private
const getUnreadCount = async (req, res) => {
  try {
    const count = await Notification.countDocuments({ userId: req.user._id, isRead: false });
    res.json({ count });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Mark a specific notification as read
// @route   PATCH /api/notifications/:id/read
// @access  Private
const markRead = async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id, isRead: false },
      { $set: { isRead: true } },
      { new: true }
    );
    if (!notification) {
      return res.status(404).json({ message: 'Notification not found, already read, or unauthorized' });
    }
    res.json(notification);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Mark all user's notifications as read
// @route   PATCH /api/notifications/read-all
// @access  Private
const markAllRead = async (req, res) => {
  try {
    await Notification.updateMany(
      { userId: req.user._id, isRead: false },
      { $set: { isRead: true } }
    );
    res.json({ message: 'All notifications marked as read' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Delete a notification
// @route   DELETE /api/notifications/:id
// @access  Private
const deleteNotification = async (req, res) => {
  try {
    const result = await Notification.deleteOne({ _id: req.params.id, userId: req.user._id });
    if (result.deletedCount === 0) {
      return res.status(404).json({ message: 'Notification not found or unauthorized' });
    }
    res.json({ message: 'Notification deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Mark selected notifications as read
// @route   PATCH /api/notifications/read-selected
// @access  Private
const markSelectedRead = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'Please provide an array of notification IDs' });
    }
    await Notification.updateMany(
      { _id: { $in: ids }, userId: req.user._id, isRead: false },
      { $set: { isRead: true } }
    );
    res.json({ message: 'Selected notifications marked as read' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Delete selected notifications
// @route   POST /api/notifications/delete-selected (Using POST to support body array)
// @access  Private
const deleteSelected = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'Please provide an array of notification IDs' });
    }
    const result = await Notification.deleteMany({ _id: { $in: ids }, userId: req.user._id });
    res.json({ message: 'Selected notifications deleted', count: result.deletedCount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get admin notification metrics
// @route   GET /api/notifications/admin-metrics
// @access  Private/Admin
const getAdminMetrics = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized: Admin access required' });
    }

    const totalSent = await Notification.countDocuments();
    const readCount = await Notification.countDocuments({ isRead: true });
    const unreadCount = await Notification.countDocuments({ isRead: false });

    // Aggregate by type
    const byType = await Notification.aggregate([
      { $group: { _id: '$type', count: { $sum: 1 } } }
    ]);
    const typeDistribution = {};
    byType.forEach(item => {
      typeDistribution[item._id] = item.count;
    });

    // Daily activity of last 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const dailyActivity = await Notification.aggregate([
      { $match: { createdAt: { $gte: sevenDaysAgo } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    res.json({
      totalSent,
      readCount,
      unreadCount,
      readRate: totalSent > 0 ? (readCount / totalSent) * 100 : 0,
      unreadRate: totalSent > 0 ? (unreadCount / totalSent) * 100 : 0,
      typeDistribution,
      dailyActivity
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  createNotification,
  saveFcmTokenForUser,
  removeFcmTokensForUser,
  upsertFcmToken,
  getNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  deleteNotification,
  markSelectedRead,
  deleteSelected,
  getAdminMetrics
};

