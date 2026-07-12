const admin = require('../config/firebaseAdmin');
const User = require('../models/User');
const { isUserVisible } = require('../socket');

const INVALID_TOKEN_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
  'messaging/invalid-argument'
]);

const getFrontendBaseUrl = () => (
  process.env.APP_URL
  || process.env.FRONTEND_URL?.split(',')[0]?.trim()
  || 'https://www.playnowarena.in'
).replace(/\/$/, '');

const toAbsoluteUrl = (path = '/') => {
  if (/^https?:\/\//i.test(path)) return path;
  return `${getFrontendBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
};

const toStringData = (data = {}) => Object.entries(data).reduce((acc, [key, value]) => {
  if (value === undefined || value === null) return acc;
  acc[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return acc;
}, {});

const removeInvalidTokens = async (userId, tokens) => {
  if (!tokens.length) return;
  await User.findByIdAndUpdate(userId, {
    $pull: { fcmTokens: { $in: tokens } }
  });
};

const sendUserPushNotification = async ({
  userId,
  title,
  body,
  url,
  data = {},
  dedupeKey
}) => {
  if (!userId || isUserVisible(userId)) {
    return { sent: 0, skipped: true, reason: 'app-visible' };
  }

  const user = await User.findById(userId).select('+fcmTokens');
  const tokens = [...new Set((user?.fcmTokens || []).filter(Boolean))];
  if (!tokens.length) {
    return { sent: 0, skipped: true, reason: 'no-tokens' };
  }

  if (!admin.apps.length) {
    return { sent: 0, skipped: true, reason: 'firebase-not-initialized' };
  }

  const targetUrl = toAbsoluteUrl(url);

  const response = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: {
      title,
      body
    },
    webpush: {
      fcmOptions: {
        link: targetUrl
      },
      notification: {
        icon: toAbsoluteUrl('/icons/icon-192.png'),
        badge: toAbsoluteUrl('/icons/icon-96.png'),
        tag: dedupeKey,
        renotify: false,
        data: {
          url: targetUrl
        }
      }
    },
    data: toStringData({
      ...data,
      url: targetUrl,
      dedupeKey
    })
  });

  const invalidTokens = response.responses
    .map((result, index) => (result.error && INVALID_TOKEN_CODES.has(result.error.code) ? tokens[index] : null))
    .filter(Boolean);

  await removeInvalidTokens(userId, invalidTokens);

  return {
    sent: response.successCount,
    failed: response.failureCount,
    invalidRemoved: invalidTokens.length
  };
};

module.exports = {
  sendUserPushNotification
};
