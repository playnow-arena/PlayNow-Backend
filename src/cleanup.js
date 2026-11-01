const Notification = require('./models/Notification');
const Match = require('./models/Match');

// Runs daily (every 24 hours) to delete notifications older than 90 days
const initAutoCleanup = () => {
  // --- Existing: Notification cleanup ---
  const notificationCleanupJob = async () => {
    try {
      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const result = await Notification.deleteMany({
        createdAt: { $lt: ninetyDaysAgo }
      });
      console.log(`🧹 [CLEANUP] Notification Auto Cleanup finished. Deleted ${result.deletedCount} notifications older than 90 days.`);
    } catch (err) {
      console.error('❌ [CLEANUP] Notification Auto Cleanup failed:', err.message);
    }
  };

  // Run immediately on boot
  notificationCleanupJob();

  // Run every 24 hours
  setInterval(notificationCleanupJob, 24 * 60 * 60 * 1000);
  console.log('⏰ [CLEANUP] Notification Auto Cleanup job scheduled (runs every 24 hours).');

  // --- New: Started match cleanup (soft-delete after 10 minutes) ---
  const TEN_MINUTES_MS = 10 * 60 * 1000;

  const startedMatchCleanupJob = async () => {
    try {
      const cutoff = new Date(Date.now() - TEN_MINUTES_MS);
      // Mark as 'cancelled' (soft remove from active system) any started match
      // whose startedAt timestamp is older than 10 minutes.
      const result = await Match.updateMany(
        {
          status: 'started',
          startedAt: { $lte: cutoff }
        },
        { $set: { status: 'cancelled' } }
      );
      if (result.modifiedCount > 0) {
        console.log(`🧹 [CLEANUP] Started Match Cleanup: expired ${result.modifiedCount} started match(es) older than 10 minutes.`);
      }
    } catch (err) {
      console.error('❌ [CLEANUP] Started Match Cleanup failed:', err.message);
    }
  };

  // Run immediately on boot (handles server restart recovery)
  startedMatchCleanupJob();

  // Run every minute to catch matches within ~10s of the 10-minute window
  setInterval(startedMatchCleanupJob, 60 * 1000);
  console.log('⏰ [CLEANUP] Started Match Cleanup job scheduled (runs every 60 seconds).');
};

module.exports = { initAutoCleanup };
