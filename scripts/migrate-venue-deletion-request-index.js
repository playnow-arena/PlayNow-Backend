/**
 * PlayNowArena — Venue Deletion Request Index Migration Script
 *
 * Sequence:
 *   1. Preflight check: scans for duplicate pending requests grouped by venueId.
 *      If any duplicates exist, immediately ABORTS without modifying any indexes or data.
 *   2. Creates unique partial index `venueId_pending_unique` FIRST.
 *   3. Verifies exact key { venueId: 1 }, unique: true, and partialFilterExpression: { status: 'pending' }.
 *   4. ONLY after successful verification, drops the obsolete `venueId_1_status_1` index.
 *   5. If new index creation or verification fails, the old index is strictly preserved.
 *   6. Repeated execution is completely safe and idempotent.
 *
 * Usage:
 *   node scripts/migrate-venue-deletion-request-index.js
 */

const path = require('path');
const mongoose = require('mongoose');

/**
 * Preflight check: scans collection for duplicate pending deletion requests by venueId.
 * @param {import('mongodb').Collection} collection
 * @returns {Promise<{ hasDuplicates: boolean, duplicates: Array }>}
 */
async function runPreflightCheck(collection) {
  const duplicates = await collection.aggregate([
    { $match: { status: 'pending' } },
    {
      $group: {
        _id: '$venueId',
        count: { $sum: 1 },
        requestIds: { $push: '$_id' }
      }
    },
    { $match: { count: { $gt: 1 } } }
  ]).toArray();

  return {
    hasDuplicates: duplicates.length > 0,
    duplicates
  };
}

/**
 * Validates that an index spec matches the exact requirements for venueId_pending_unique:
 *   - exact index key: { venueId: 1 } (and no extra keys)
 *   - unique === true
 *   - partialFilterExpression contains exactly one key: status
 *   - status value is exactly 'pending'
 * @param {object} idx
 * @returns {boolean}
 */
function isPendingUniqueIndexValid(idx) {
  if (!idx) return false;
  const isKeyMatch = idx.key && idx.key.venueId === 1 && Object.keys(idx.key).length === 1;
  const isUnique = idx.unique === true;
  const pfe = idx.partialFilterExpression;
  const isPartialMatch = Boolean(
    pfe &&
    typeof pfe === 'object' &&
    Object.keys(pfe).length === 1 &&
    pfe.status === 'pending'
  );
  return Boolean(isKeyMatch && isUnique && isPartialMatch);
}

/**
 * Executes migration:
 *   1. Runs duplicate preflight check before ANY index modification.
 *   2. Creates the new unique partial index `venueId_pending_unique` FIRST.
 *   3. Verifies its exact key, unique flag, and partialFilterExpression.
 *   4. ONLY after successful verification, drops the obsolete index `venueId_1_status_1`.
 *   5. Preserves the old index if new index creation or verification fails.
 *   6. Safe and idempotent on repeated execution.
 *
 * @param {import('mongodb').Db} db
 * @returns {Promise<{ success: boolean, message: string, indexes?: Array, duplicates?: Array }>}
 */
async function migrateVenueDeletionRequestIndex(db) {
  const collection = db.collection('venuedeletionrequests');

  // Step 1: Preflight duplicate check before any index modifications
  console.log('[INDEX MIGRATION] Step 1: Running preflight duplicate check...');
  const { hasDuplicates, duplicates } = await runPreflightCheck(collection);

  if (hasDuplicates) {
    console.error('================================================================================');
    console.error('⛔ [PREFLIGHT FAILED] Duplicate pending deletion requests detected in database!');
    console.error('================================================================================');
    console.error(`Found ${duplicates.length} venue(s) with multiple pending deletion requests:\n`);
    duplicates.forEach((dup, idx) => {
      console.error(`  ${idx + 1}. Venue ID: ${dup._id}`);
      console.error(`     Pending Request Count: ${dup.count}`);
      console.error(`     Request Document IDs : ${dup.requestIds.join(', ')}\n`);
    });
    console.error('Index creation has been ABORTED to protect database integrity.');
    console.error('The existing indexes (including venueId_1_status_1 if present) remain untouched.');
    console.error('Please resolve these conflicting records manually before re-running.');
    console.error('================================================================================');
    return {
      success: false,
      message: 'Preflight check failed: duplicate pending deletion requests exist.',
      duplicates
    };
  }

  console.log('✅ [PREFLIGHT PASSED] No duplicate pending deletion requests found.');

  // Step 2: Create new unique partial index FIRST (or verify if already created)
  console.log('[INDEX MIGRATION] Step 2: Creating unique partial index venueId_pending_unique...');
  await collection.createIndex(
    { venueId: 1 },
    {
      unique: true,
      partialFilterExpression: { status: 'pending' },
      name: 'venueId_pending_unique'
    }
  );

  // Step 3: Verify the new index before making any other changes
  console.log('[INDEX MIGRATION] Step 3: Verifying venueId_pending_unique via listIndexes()...');
  const verifiedIndexes = await collection.indexes();
  const created = verifiedIndexes.find(idx => idx.name === 'venueId_pending_unique');

  if (!isPendingUniqueIndexValid(created)) {
    throw new Error(
      'Index verification failed: venueId_pending_unique was not found with required properties ' +
      '(key: { venueId: 1 }, unique: true, partialFilterExpression: { status: "pending" }). ' +
      'The obsolete index venueId_1_status_1 has been preserved.'
    );
  }

  console.log('✅ [INDEX VERIFIED] Unique partial index venueId_pending_unique verified.');
  console.log('   Properties:', JSON.stringify({
    name: created.name,
    key: created.key,
    unique: created.unique,
    partialFilterExpression: created.partialFilterExpression
  }, null, 2));

  // Step 4: ONLY after successful creation & verification, drop the obsolete index if present
  console.log('[INDEX MIGRATION] Step 4: Checking for obsolete index venueId_1_status_1...');
  const obsoleteIndex = verifiedIndexes.find(idx => idx.name === 'venueId_1_status_1');
  if (obsoleteIndex) {
    console.log('[INDEX MIGRATION] Dropping obsolete index venueId_1_status_1...');
    await collection.dropIndex('venueId_1_status_1');
    console.log('✅ [INDEX MIGRATION] Obsolete index venueId_1_status_1 successfully dropped.');
  } else {
    console.log('[INDEX MIGRATION] Obsolete index venueId_1_status_1 is not present (already removed or not yet created).');
  }

  const finalIndexes = await collection.indexes();
  return {
    success: true,
    message: 'Index created, verified, and obsolete index cleaned up successfully.',
    indexes: finalIndexes
  };
}

// Standalone execution entrypoint
if (require.main === module) {
  // Ensure .env is loaded from the PlayNow-Backend directory regardless of working directory
  const envPath = path.join(__dirname, '..', '.env');
  require('dotenv').config({ path: envPath });

  const uri = process.env.MONGO_URI;

  if (!uri) {
    console.error(`Error: MONGO_URI environment variable is required (checked: ${envPath}).`);
    process.exitCode = 1;
  } else {
    (async () => {
      try {
        console.log(`Connecting to MongoDB...`);
        const conn = await mongoose.connect(uri);
        console.log(`Connected to host: ${conn.connection.host}`);

        const result = await migrateVenueDeletionRequestIndex(conn.connection.db);
        if (!result.success) {
          process.exitCode = 1;
        } else {
          process.exitCode = 0;
        }
      } catch (err) {
        console.error('Fatal migration error:', err);
        process.exitCode = 1;
      } finally {
        await mongoose.disconnect();
      }
    })();
  }
}

module.exports = {
  runPreflightCheck,
  isPendingUniqueIndexValid,
  migrateVenueDeletionRequestIndex
};
