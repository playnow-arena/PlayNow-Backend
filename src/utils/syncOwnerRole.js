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
 */
const syncOwnerRole = async (userId) => {
  if (!userId) {
    throw new Error('syncOwnerRole: userId is required');
  }

  const user = await User.findById(userId);
  if (!user) return;                  // user deleted — nothing to sync
  if (user.role === 'admin') return;  // admins are never touched

  const venueCount = await Venue.countDocuments({ ownerId: userId });

  if (venueCount > 0 && user.role === 'player') {
    user.role = 'owner';
    await user.save();
    console.log(`[syncOwnerRole] Promoted  ${user._id} (${user.name}) → owner  (${venueCount} venue(s))`);
  } else if (venueCount === 0 && user.role === 'owner') {
    user.role = 'player';
    await user.save();
    console.log(`[syncOwnerRole] Demoted   ${user._id} (${user.name}) → player (0 venues)`);
  }
  // If already in the correct role — no-op (idempotent)
};

module.exports = syncOwnerRole;
