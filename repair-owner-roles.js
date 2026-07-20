/**
 * repair-owner-roles.js
 *
 * One-time CLI repair script.
 *
 * Usage:
 *   node repair-owner-roles.js
 *
 * What it does:
 *   1. Connects to MongoDB using MONGO_URI from .env
 *   2. Finds every user with role = 'owner'
 *   3. Counts venues where Venue.ownerId === user._id
 *   4. If count === 0 AND user is not admin → demotes to 'player'
 *   5. Prints a report and disconnects cleanly
 */

require('dotenv').config();
const mongoose = require('mongoose');

// ── Minimal inline models (avoids loading the full app) ──────────────────────

const userSchema = new mongoose.Schema({
  name:  String,
  phone: String,
  role:  { type: String, enum: ['player', 'owner', 'admin'] }
}, { strict: false });

const venueSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { strict: false });

const User  = mongoose.model('User',  userSchema,  'users');
const Venue = mongoose.model('Venue', venueSchema, 'venues');

// ── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('[repair] ERROR: MONGO_URI is not set in .env');
    process.exit(1);
  }

  console.log('[repair] Connecting to MongoDB...');
  await mongoose.connect(uri);
  console.log('[repair] Connected.\n');

  const owners = await User.find({ role: 'owner' }).lean();
  const scanned = owners.length;
  console.log(`[repair] Owners scanned: ${scanned}`);

  if (scanned === 0) {
    console.log('[repair] No owner-role users found. Nothing to repair.');
    await mongoose.disconnect();
    console.log('\n[repair] Completed successfully.');
    return;
  }

  let repaired = 0;

  for (const owner of owners) {
    // Safety: never touch admins (belt-and-suspenders, though query excludes them)
    if (owner.role === 'admin') continue;

    const venueCount = await Venue.countDocuments({ ownerId: owner._id });

    if (venueCount === 0) {
      await User.updateOne({ _id: owner._id }, { $set: { role: 'player' } });
      console.log(`  ✔ Demoted  ${owner._id}  "${owner.name || owner.phone}"  → player  (0 venues)`);
      repaired += 1;
    } else {
      console.log(`  ✓ OK       ${owner._id}  "${owner.name || owner.phone}"  (${venueCount} venue(s))`);
    }
  }

  console.log(`\n[repair] Owners scanned:           ${scanned}`);
  console.log(`[repair] Owners repaired:           ${repaired}`);

  await mongoose.disconnect();
  console.log('\n[repair] Completed successfully.');
}

run().catch((err) => {
  console.error('[repair] FATAL ERROR:', err.message);
  mongoose.disconnect();
  process.exit(1);
});
