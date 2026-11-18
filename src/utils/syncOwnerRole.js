const User = require('../models/User');
const Venue = require('../models/Venue');

/**
 * syncOwnerRole — the ONLY place in the backend that changes a user's role
 * between 'player' and 'owner'.
 *
 * Business rule:
 *   A user is 'owner' if and only if they own at least one venue
 *   (Venue.ownerId === user._id).
 *
 * This function is idempotent — safe to call multiple times.
 * It never touches admin users.
 *
 * @param {string|ObjectId} userId — the user whose role should be synced
 * @param {object} [options]
 * @param {import('mongoose').ClientSession} [options.session] — Optional Mongoose
 *   session. When provided all DB reads/writes participate in the caller's
 *   transaction. Existing callers that omit this parameter are unaffected.
 */
const syncOwnerRole = async (userId, { session } = {}) => {
  if (!userId) {
    throw new Error('syncOwnerRole: userId is required');
  }

  const user = await User.findById(userId).session(session || null);
  if (!user) return;                  // user deleted — nothing to sync
  if (user.role === 'admin') return;  // admins are never touched

  const venueCount = await Venue.countDocuments(
    { ownerId: userId, isActive: true },
    { session: session || null }
  );

  if (venueCount > 0 && user.role === 'player') {
    user.role = 'owner';
    await user.save({ session: session || null });
    console.log(`[syncOwnerRole] Promoted  ${user._id} (${user.name}) -> owner  (${venueCount} venue(s))`);
  } else if (venueCount === 0 && user.role === 'owner') {
    user.role = 'player';
    await user.save({ session: session || null });
    console.log(`[syncOwnerRole] Demoted   ${user._id} (${user.name}) -> player (0 venues)`);
  }
  // If already in the correct role — no-op (idempotent)
};

module.exports = syncOwnerRole;
