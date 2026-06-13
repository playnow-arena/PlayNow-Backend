const Notification = require('./models/Notification');

// Runs daily (every 24 hours) to delete notifications older than 90 days
const initAutoCleanup = () => {
  const cleanupJob = async () => {
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
  cleanupJob();

  // Run every 24 hours
  setInterval(cleanupJob, 24 * 60 * 60 * 1000);
  console.log('⏰ [CLEANUP] Notification Auto Cleanup job scheduled (runs every 24 hours).');
};

module.exports = { initAutoCleanup };

