/**
 * PlayNowArena — Phase 4.1 Integration Test Suite
 *
 * Uses MongoMemoryReplSet (replica-set mode) required for MongoDB transactions.
 * All tests execute real MongoDB operations against an isolated in-memory
 * database that is completely separate from the production database.
 *
 * Covers:
 *   A. Reactivation Security (owner stripped, admin permitted)
 *   B. Duplicate Prevention & Unique Partial Index (concurrent Promise.all, 11000 -> 409)
 *   C. Atomic Claim & Native Transaction Rollbacks (claim inside session, venue/slot/role rollback)
 *   D. Notification Safety (0 notifications on rollback, exactly 1 on commit)
 *   E. Pending-Request Edit Protection (409 while pending, allowed after rejection)
 *   F. Index Preflight & Migration Verification (preflight duplicate detection, listIndexes)
 *   G. HTTP-Level Express Route & Middleware Integration (JWT protect, roleMiddleware)
 *
 * Run: node test-phase4-integration.js
 */

const assert = require('assert');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('./node_modules/mongoose');
const { MongoMemoryReplSet } = require('./node_modules/mongodb-memory-server');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'supersecretplaynowkey';

// Models
const Venue = require('./src/models/Venue');
const VenueDeletionRequest = require('./src/models/VenueDeletionRequest');
const Slot = require('./src/models/Slot');
const User = require('./src/models/User');

// Scripts
const {
  runPreflightCheck,
  migrateVenueDeletionRequestIndex
} = require('./scripts/migrate-venue-deletion-request-index');

// ─── Notification Capture ───────────────────────────────────────────────────

const recordedNotifications = [];
jest_mock_notifications();
function jest_mock_notifications() {
  const Module = require('module');
  const _origLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request.includes('notificationController')) {
      return {
        createNotification: async (doc) => {
          recordedNotifications.push(doc);
          return doc;
        }
      };
    }
    return _origLoad.apply(this, arguments);
  };
}

// Load controllers AFTER notification mock
const {
  createDeletionRequest,
  approveDeletionRequest,
  rejectDeletionRequest
} = require('./src/controllers/venueDeletionRequestController');

const { updateVenue } = require('./src/controllers/venueController');

// ─── Helpers ────────────────────────────────────────────────────────────────

const mockReqRes = (options = {}) => {
  const req = {
    user: options.user || null,
    body: options.body || {},
    params: options.params || {},
    query: options.query || {},
    headers: options.headers || {}
  };
  let statusCode = 200;
  let responseData = null;
  const res = {
    status: (code) => { statusCode = code; return res; },
    json: (data) => { responseData = data; return res; },
    get statusCode() { return statusCode; },
    get data() { return responseData; }
  };
  return { req, res };
};

// ─── Test State ──────────────────────────────────────────────────────────────

let replSet;
let passedTests = 0;
let blockedTests = 0;
let totalTests = 0;

console.log('=================================================================');
console.log('  PHASE 4.1 INTEGRATION TESTS (Replica Set MongoDB + HTTP Routes)');
console.log('=================================================================\n');

async function setupReplSet() {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri();
  await mongoose.connect(uri);
  console.log(`Connected to in-memory replica set: ${uri}\n`);

  const session = await mongoose.startSession();
  let txSupported = false;
  try {
    await session.withTransaction(async () => {});
    txSupported = true;
  } catch (e) {
    // topology error
  } finally {
    session.endSession();
  }
  return txSupported;
}

async function seedUsers() {
  const ownerA = await User.create({
    name: 'Owner A', phone: '+919000000001', role: 'owner', playNowId: 'U-OA01'
  });
  const ownerB = await User.create({
    name: 'Owner B', phone: '+919000000002', role: 'owner', playNowId: 'U-OB01'
  });
  const player = await User.create({
    name: 'Player X', phone: '+919000000004', role: 'player', playNowId: 'U-PX01'
  });
  const admin = await User.create({
    name: 'Admin', phone: '+919000000003', role: 'admin', playNowId: 'U-AD01'
  });
  return { ownerA, ownerB, player, admin };
}

async function createTestVenue(ownerId, overrides = {}) {
  return Venue.create({
    name: overrides.name || 'Test Turf',
    sportTypes: ['Badminton'],
    location: 'Chennai',
    address: 'Main Road, Chennai',
    pricePerHour: 500,
    ownerId,
    venueCode: `V-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    isActive: overrides.isActive !== undefined ? overrides.isActive : true,
    ...overrides
  });
}

// ─── Main Test Runner ────────────────────────────────────────────────────────

(async () => {
  let txSupported = false;
  try {
    txSupported = await setupReplSet();
    console.log(`Transaction support: ${txSupported ? 'YES ✅' : 'NO ⛔'}\n`);
  } catch (err) {
    console.error('FATAL: Failed to start MongoMemoryReplSet:', err.message);
    process.exit(1);
  }

  const { ownerA, ownerB, player, admin } = await seedUsers();
  const userOwnerA = { _id: ownerA._id, role: 'owner' };
  const userOwnerB = { _id: ownerB._id, role: 'owner' };
  const userAdmin = { _id: admin._id, role: 'admin' };

  // ── SECTION A: Reactivation Security ──────────────────────────────────────
  console.log('--- A: Reactivation Security ---');

  // Test A1
  totalTests++;
  console.log(`Test ${totalTests} (A1): Owner cannot reactivate an inactive venue`);
  {
    const venue = await createTestVenue(ownerA._id, { isActive: false, name: 'Inactive Venue A1' });
    const { req, res } = mockReqRes({
      user: userOwnerA,
      params: { id: venue._id.toString() },
      body: {
        isActive: true,
        name: venue.name,
        sportTypes: venue.sportTypes,
        location: venue.location,
        address: venue.address,
        pricePerHour: venue.pricePerHour
      }
    });
    await updateVenue(req, res);
    const updated = await Venue.findById(venue._id);
    assert.strictEqual(updated.isActive, false, 'Owner must NOT be able to reactivate an inactive venue');
    console.log('  PASSED: isActive remained false after owner update attempt\n');
    passedTests++;
    await venue.deleteOne();
  }

  // Test A2
  totalTests++;
  console.log(`Test ${totalTests} (A2): Admin can change venue active status`);
  {
    const venue = await createTestVenue(ownerA._id, { isActive: false, name: 'Inactive Venue A2' });
    const { req, res } = mockReqRes({
      user: userAdmin,
      params: { id: venue._id.toString() },
      body: {
        isActive: true,
        name: venue.name,
        sportTypes: venue.sportTypes,
        location: venue.location,
        address: venue.address,
        pricePerHour: venue.pricePerHour,
        ownerUserId: ownerA._id.toString()
      }
    });
    await updateVenue(req, res);
    assert.strictEqual(res.statusCode, 200, `Admin update failed: ${JSON.stringify(res.data)}`);
    const updated = await Venue.findById(venue._id);
    assert.strictEqual(updated.isActive, true, 'Admin must be able to reactivate a venue');
    console.log('  PASSED: Admin successfully reactivated the venue\n');
    passedTests++;
    await venue.deleteOne();
  }

  // ── SECTION B: Duplicate Prevention & Partial Index ───────────────────────
  console.log('--- B: Duplicate Pending Deletion Request Prevention ---');

  // Test B3
  totalTests++;
  console.log(`Test ${totalTests} (B3): Concurrent duplicate deletion requests — only one succeeds`);
  {
    const venue = await createTestVenue(ownerA._id, { name: 'Concurrent Venue B3' });
    const makeReq = () => mockReqRes({
      user: userOwnerA,
      body: { venueId: venue._id.toString(), reason: 'Concurrent test reason B3' }
    });
    const r1 = makeReq();
    const r2 = makeReq();

    await Promise.all([
      createDeletionRequest(r1.req, r1.res),
      createDeletionRequest(r2.req, r2.res)
    ]);

    const statuses = [r1.res.statusCode, r2.res.statusCode].sort();
    assert.ok(statuses.includes(201), `Expected one 201, got: ${statuses}`);
    assert.ok(statuses.includes(409), `Expected one 409, got: ${statuses}`);

    const pendingCount = await VenueDeletionRequest.countDocuments({
      venueId: venue._id, status: 'pending'
    });
    assert.strictEqual(pendingCount, 1, `Expected 1 pending request, got ${pendingCount}`);
    console.log(`  PASSED: statuses=${statuses}; exactly 1 pending request in DB\n`);
    passedTests++;

    await VenueDeletionRequest.deleteMany({ venueId: venue._id });
    await venue.deleteOne();
  }

  // Test B4
  totalTests++;
  console.log(`Test ${totalTests} (B4): Duplicate pending request returns HTTP 409`);
  {
    const venue = await createTestVenue(ownerA._id, { name: 'Venue B4' });
    const r1 = mockReqRes({ user: userOwnerA, body: { venueId: venue._id.toString(), reason: 'First request B4' } });
    await createDeletionRequest(r1.req, r1.res);
    assert.strictEqual(r1.res.statusCode, 201);

    const r2 = mockReqRes({ user: userOwnerA, body: { venueId: venue._id.toString(), reason: 'Duplicate request B4' } });
    await createDeletionRequest(r2.req, r2.res);
    assert.strictEqual(r2.res.statusCode, 409, `Expected 409, got ${r2.res.statusCode}`);
    assert.ok(r2.res.data.message.includes('already pending'));
    console.log('  PASSED: Second pending request correctly rejected with 409\n');
    passedTests++;

    await VenueDeletionRequest.deleteMany({ venueId: venue._id });
    await venue.deleteOne();
  }

  // Test B5
  totalTests++;
  console.log(`Test ${totalTests} (B5): Rejected request allows a new deletion request`);
  {
    const venue = await createTestVenue(ownerA._id, { name: 'Venue B5' });
    const r1 = mockReqRes({ user: userOwnerA, body: { venueId: venue._id.toString(), reason: 'First request B5' } });
    await createDeletionRequest(r1.req, r1.res);
    const reqId = r1.res.data._id.toString();

    const rej = mockReqRes({ user: userAdmin, params: { id: reqId }, body: { rejectionReason: 'Not needed' } });
    await rejectDeletionRequest(rej.req, rej.res);
    assert.strictEqual(rej.res.statusCode, 200);

    const r2 = mockReqRes({ user: userOwnerA, body: { venueId: venue._id.toString(), reason: 'Second attempt B5' } });
    await createDeletionRequest(r2.req, r2.res);
    assert.strictEqual(r2.res.statusCode, 201);
    console.log('  PASSED: New deletion request accepted after previous was rejected\n');
    passedTests++;

    await VenueDeletionRequest.deleteMany({ venueId: venue._id });
    await venue.deleteOne();
  }

  // ── SECTION C: Atomic Claim & Transaction Rollback Boundaries ─────────────
  console.log('--- C: Atomic Claim & Transaction Boundaries ---');

  // Test C6
  totalTests++;
  console.log(`Test ${totalTests} (C6): Concurrent approve attempts — only one succeeds`);
  {
    const venue = await createTestVenue(ownerA._id, { name: 'Venue C6' });
    const r1 = mockReqRes({ user: userOwnerA, body: { venueId: venue._id.toString(), reason: 'Approve race test C6' } });
    await createDeletionRequest(r1.req, r1.res);
    const reqId = r1.res.data._id.toString();

    const app1 = mockReqRes({ user: userAdmin, params: { id: reqId }, body: {} });
    const app2 = mockReqRes({ user: userAdmin, params: { id: reqId }, body: {} });

    await Promise.all([
      approveDeletionRequest(app1.req, app1.res),
      approveDeletionRequest(app2.req, app2.res)
    ]);
    const statuses = [app1.res.statusCode, app2.res.statusCode].sort();
    assert.ok(statuses.includes(200), `Expected one 200, got: ${statuses}`);
    assert.ok(statuses.includes(409), `Expected one 409, got: ${statuses}`);

    const finalReq = await VenueDeletionRequest.findById(reqId);
    assert.strictEqual(finalReq.status, 'approved');
    console.log(`  PASSED: statuses=${statuses}; single claim succeeded inside transaction\n`);
    passedTests++;

    await VenueDeletionRequest.deleteMany({ venueId: venue._id });
    await venue.deleteOne();
  }

  // Test C7
  totalTests++;
  console.log(`Test ${totalTests} (C7): Concurrent approve + reject — only one succeeds`);
  {
    const venue = await createTestVenue(ownerA._id, { name: 'Venue C7' });
    const r1 = mockReqRes({ user: userOwnerA, body: { venueId: venue._id.toString(), reason: 'Approve+reject race C7' } });
    await createDeletionRequest(r1.req, r1.res);
    const reqId = r1.res.data._id.toString();

    const app = mockReqRes({ user: userAdmin, params: { id: reqId }, body: {} });
    const rej = mockReqRes({ user: userAdmin, params: { id: reqId }, body: { rejectionReason: 'Competing reject' } });

    await Promise.all([
      approveDeletionRequest(app.req, app.res),
      rejectDeletionRequest(rej.req, rej.res)
    ]);
    const statuses = [app.res.statusCode, rej.res.statusCode].sort();
    assert.ok(statuses.includes(200), `Expected one 200, got: ${statuses}`);
    assert.ok(statuses.includes(409), `Expected one 409, got: ${statuses}`);

    const finalReq = await VenueDeletionRequest.findById(reqId);
    assert.ok(['approved', 'rejected'].includes(finalReq.status));
    console.log(`  PASSED: statuses=${statuses}; final status='${finalReq.status}'\n`);
    passedTests++;

    await VenueDeletionRequest.deleteMany({ venueId: venue._id });
    await venue.deleteOne();
  }

  // Test C8
  totalTests++;
  console.log(`Test ${totalTests} (C8): Already-reviewed request returns 409 without side effects`);
  {
    const venue = await createTestVenue(ownerA._id, { name: 'Venue C8' });
    const cr = mockReqRes({ user: userOwnerA, body: { venueId: venue._id.toString(), reason: 'Already reviewed C8' } });
    await createDeletionRequest(cr.req, cr.res);
    const reqId = cr.res.data._id.toString();

    const app1 = mockReqRes({ user: userAdmin, params: { id: reqId }, body: {} });
    await approveDeletionRequest(app1.req, app1.res);
    assert.strictEqual(app1.res.statusCode, 200);

    const app2 = mockReqRes({ user: userAdmin, params: { id: reqId }, body: {} });
    await approveDeletionRequest(app2.req, app2.res);
    assert.strictEqual(app2.res.statusCode, 409);

    const rej2 = mockReqRes({ user: userAdmin, params: { id: reqId }, body: { rejectionReason: 'Too late' } });
    await rejectDeletionRequest(rej2.req, rej2.res);
    assert.strictEqual(rej2.res.statusCode, 409);

    console.log('  PASSED: Re-process attempts cleanly returned 409\n');
    passedTests++;

    await VenueDeletionRequest.deleteMany({ venueId: venue._id });
    await venue.deleteOne();
  }

  // Test C9a: Failure during venue update rolls back claim
  totalTests++;
  console.log(`Test ${totalTests} (C9a): Failure during venue update rolls back claim status to pending`);
  {
    const venue = await createTestVenue(ownerA._id, { name: 'Venue C9a' });
    const cr = mockReqRes({ user: userOwnerA, body: { venueId: venue._id.toString(), reason: 'Venue failure rollback C9a' } });
    await createDeletionRequest(cr.req, cr.res);
    const reqId = cr.res.data._id.toString();

    // Inject failure into Venue.prototype.save during transaction
    const origSave = Venue.prototype.save;
    Venue.prototype.save = async function(...args) {
      Venue.prototype.save = origSave; // restore
      throw new Error('Simulated Venue.prototype.save failure in transaction');
    };

    const app = mockReqRes({ user: userAdmin, params: { id: reqId }, body: {} });
    await approveDeletionRequest(app.req, app.res);
    assert.strictEqual(app.res.statusCode, 500);

    // Verify native transaction rollback: request status must STILL be pending
    const reqAfter = await VenueDeletionRequest.findById(reqId);
    assert.strictEqual(reqAfter.status, 'pending', 'Request status must revert to pending natively');

    const venueAfter = await Venue.findById(venue._id);
    assert.strictEqual(venueAfter.isActive, true, 'Venue must remain active');

    console.log('  PASSED: Request status reverted to pending natively on venue update failure\n');
    passedTests++;

    await VenueDeletionRequest.deleteMany({ venueId: venue._id });
    await venue.deleteOne();
  }

  // Test C9b: Failure during slot blocking rolls back claim
  totalTests++;
  console.log(`Test ${totalTests} (C9b): Failure during slot blocking rolls back claim status to pending`);
  {
    const venue = await createTestVenue(ownerA._id, { name: 'Venue C9b' });
    await Slot.create({
      venueId: venue._id, date: new Date('2027-01-01'),
      startTime: '06:00', endTime: '07:00', price: 500, status: 'available'
    });

    const cr = mockReqRes({ user: userOwnerA, body: { venueId: venue._id.toString(), reason: 'Slot failure rollback C9b' } });
    await createDeletionRequest(cr.req, cr.res);
    const reqId = cr.res.data._id.toString();

    const origUpdateMany = Slot.updateMany.bind(Slot);
    Slot.updateMany = async function(...args) {
      Slot.updateMany = origUpdateMany; // restore
      throw new Error('Simulated Slot.updateMany failure in transaction');
    };

    const app = mockReqRes({ user: userAdmin, params: { id: reqId }, body: {} });
    await approveDeletionRequest(app.req, app.res);
    assert.strictEqual(app.res.statusCode, 500);

    const reqAfter = await VenueDeletionRequest.findById(reqId);
    assert.strictEqual(reqAfter.status, 'pending', 'Request status must be pending');

    const venueAfter = await Venue.findById(venue._id);
    assert.strictEqual(venueAfter.isActive, true, 'Venue must remain active');

    const slotAfter = await Slot.findOne({ venueId: venue._id });
    assert.strictEqual(slotAfter.status, 'available', 'Slot must remain available');

    console.log('  PASSED: Request status reverted to pending natively on slot blocking failure\n');
    passedTests++;

    await VenueDeletionRequest.deleteMany({ venueId: venue._id });
    await Slot.deleteMany({ venueId: venue._id });
    await venue.deleteOne();
  }

  // Test C9c: Failure during owner role sync rolls back all changes
  totalTests++;
  console.log(`Test ${totalTests} (C9c): Failure during owner role sync rolls back all changes`);
  {
    const venue = await createTestVenue(ownerA._id, { name: 'Venue C9c' });
    const cr = mockReqRes({ user: userOwnerA, body: { venueId: venue._id.toString(), reason: 'Role sync failure rollback C9c' } });
    await createDeletionRequest(cr.req, cr.res);
    const reqId = cr.res.data._id.toString();

    // Inject failure into Venue.countDocuments which is always called by syncOwnerRole
    const origCount = Venue.countDocuments.bind(Venue);
    Venue.countDocuments = async function(...args) {
      Venue.countDocuments = origCount; // restore
      throw new Error('Simulated failure during syncOwnerRole');
    };

    const app = mockReqRes({ user: userAdmin, params: { id: reqId }, body: {} });
    await approveDeletionRequest(app.req, app.res);
    assert.strictEqual(app.res.statusCode, 500);

    const reqAfter = await VenueDeletionRequest.findById(reqId);
    assert.strictEqual(reqAfter.status, 'pending', 'Request must be pending');

    const venueAfter = await Venue.findById(venue._id);
    assert.strictEqual(venueAfter.isActive, true, 'Venue must remain active');

    console.log('  PASSED: All modifications rolled back natively on syncOwnerRole failure\n');
    passedTests++;

    await VenueDeletionRequest.deleteMany({ venueId: venue._id });
    await venue.deleteOne();
  }

  // Test C10: Booked slots remain unchanged, available slots blocked
  totalTests++;
  console.log(`Test ${totalTests} (C10): Available slots blocked; booked slots remain unchanged`);
  {
    const venue = await createTestVenue(ownerA._id, { name: 'Venue C10' });
    const availableSlot = await Slot.create({
      venueId: venue._id, date: new Date('2027-02-01'),
      startTime: '07:00', endTime: '08:00', price: 500, status: 'available'
    });
    const bookedSlot = await Slot.create({
      venueId: venue._id, date: new Date('2027-02-01'),
      startTime: '08:00', endTime: '09:00', price: 500, status: 'booked'
    });

    const cr = mockReqRes({ user: userOwnerA, body: { venueId: venue._id.toString(), reason: 'Slot preservation C10' } });
    await createDeletionRequest(cr.req, cr.res);
    const reqId = cr.res.data._id.toString();

    const app = mockReqRes({ user: userAdmin, params: { id: reqId }, body: {} });
    await approveDeletionRequest(app.req, app.res);
    assert.strictEqual(app.res.statusCode, 200);

    const availableAfter = await Slot.findById(availableSlot._id);
    const bookedAfter = await Slot.findById(bookedSlot._id);
    assert.strictEqual(availableAfter.status, 'blocked', 'Available slot must be blocked');
    assert.strictEqual(bookedAfter.status, 'booked', 'Booked slot must remain booked');

    console.log('  PASSED: Available slots blocked, booked slots untouched\n');
    passedTests++;

    await VenueDeletionRequest.deleteMany({ venueId: venue._id });
    await Slot.deleteMany({ venueId: venue._id });
    await venue.deleteOne();
  }

  // ── SECTION D: Notification Safety ────────────────────────────────────────
  console.log('--- D: Notification Safety ---');

  // Test D11: Zero notifications sent on transaction abort
  totalTests++;
  console.log(`Test ${totalTests} (D11): No notification dispatched when transaction fails and rolls back`);
  {
    recordedNotifications.length = 0; // reset capture
    const venue = await createTestVenue(ownerA._id, { name: 'Venue D11' });
    const cr = mockReqRes({ user: userOwnerA, body: { venueId: venue._id.toString(), reason: 'Notif safety D11' } });
    await createDeletionRequest(cr.req, cr.res);
    const reqId = cr.res.data._id.toString();

    // Clear submission notification from createDeletionRequest
    recordedNotifications.length = 0;

    // Inject failure into Slot.updateMany to abort transaction
    const origUpdateMany = Slot.updateMany.bind(Slot);
    Slot.updateMany = async function(...args) {
      Slot.updateMany = origUpdateMany;
      throw new Error('Simulated failure for notification test');
    };

    const app = mockReqRes({ user: userAdmin, params: { id: reqId }, body: {} });
    await approveDeletionRequest(app.req, app.res);
    assert.strictEqual(app.res.statusCode, 500);

    // Verify ZERO approval notifications were sent
    assert.strictEqual(recordedNotifications.length, 0, 'No notification must be sent on transaction failure');
    console.log('  PASSED: 0 notifications dispatched on failed transaction\n');
    passedTests++;

    await VenueDeletionRequest.deleteMany({ venueId: venue._id });
    await venue.deleteOne();
  }

  // Test D12: Exactly one notification sent after successful commit
  totalTests++;
  console.log(`Test ${totalTests} (D12): Exactly one notification dispatched after successful commit`);
  {
    recordedNotifications.length = 0;
    const venue = await createTestVenue(ownerA._id, { name: 'Venue D12' });
    const cr = mockReqRes({ user: userOwnerA, body: { venueId: venue._id.toString(), reason: 'Notif success D12' } });
    await createDeletionRequest(cr.req, cr.res);
    const reqId = cr.res.data._id.toString();

    // Clear the submission notification
    recordedNotifications.length = 0;

    const app = mockReqRes({ user: userAdmin, params: { id: reqId }, body: {} });
    await approveDeletionRequest(app.req, app.res);
    assert.strictEqual(app.res.statusCode, 200);

    assert.strictEqual(recordedNotifications.length, 1, 'Exactly one approval notification must be dispatched');
    assert.strictEqual(recordedNotifications[0].userId.toString(), ownerA._id.toString());
    assert.strictEqual(recordedNotifications[0].title, 'Venue Deletion Approved');
    console.log('  PASSED: Exactly 1 notification dispatched post-commit\n');
    passedTests++;

    await VenueDeletionRequest.deleteMany({ venueId: venue._id });
    await venue.deleteOne();
  }

  // ── SECTION E: Pending-Request Protection ─────────────────────────────────
  console.log('--- E: Pending-Request Edit Protection ---');

  // Test E13: Owner cannot edit venue while deletion is pending (409)
  totalTests++;
  console.log(`Test ${totalTests} (E13): Owner cannot edit venue while deletion request is pending`);
  {
    const venue = await createTestVenue(ownerA._id, { name: 'Venue E13' });
    const cr = mockReqRes({ user: userOwnerA, body: { venueId: venue._id.toString(), reason: 'Pending block E13' } });
    await createDeletionRequest(cr.req, cr.res);

    const { req, res } = mockReqRes({
      user: userOwnerA,
      params: { id: venue._id.toString() },
      body: {
        name: 'Venue E13 Edited',
        sportTypes: venue.sportTypes,
        location: venue.location,
        address: venue.address,
        pricePerHour: 999
      }
    });
    await updateVenue(req, res);
    assert.strictEqual(res.statusCode, 409);
    assert.ok(res.data.message.includes('deletion request is pending'));
    console.log('  PASSED: Owner edit blocked with 409 while deletion is pending\n');
    passedTests++;

    await VenueDeletionRequest.deleteMany({ venueId: venue._id });
    await venue.deleteOne();
  }

  // Test E14: Owner can edit after rejection
  totalTests++;
  console.log(`Test ${totalTests} (E14): Owner can edit venue after deletion request is rejected`);
  {
    const venue = await createTestVenue(ownerA._id, { name: 'Venue E14' });
    const cr = mockReqRes({ user: userOwnerA, body: { venueId: venue._id.toString(), reason: 'Reject edit E14' } });
    await createDeletionRequest(cr.req, cr.res);
    const reqId = cr.res.data._id.toString();

    const rej = mockReqRes({ user: userAdmin, params: { id: reqId }, body: { rejectionReason: 'Not approved' } });
    await rejectDeletionRequest(rej.req, rej.res);
    assert.strictEqual(rej.res.statusCode, 200);

    const { req, res } = mockReqRes({
      user: userOwnerA,
      params: { id: venue._id.toString() },
      body: {
        name: 'Venue E14 Renamed',
        sportTypes: venue.sportTypes,
        location: venue.location,
        address: venue.address,
        pricePerHour: 750
      }
    });
    await updateVenue(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.name, 'Venue E14 Renamed');
    console.log('  PASSED: Owner can edit venue after rejection\n');
    passedTests++;

    await VenueDeletionRequest.deleteMany({ venueId: venue._id });
    await venue.deleteOne();
  }

  // Test E15: Admin retains management permissions regardless of pending state
  totalTests++;
  console.log(`Test ${totalTests} (E15): Admin can edit venue even with pending deletion request`);
  {
    const venue = await createTestVenue(ownerA._id, { name: 'Venue E15' });
    const cr = mockReqRes({ user: userOwnerA, body: { venueId: venue._id.toString(), reason: 'Admin override E15' } });
    await createDeletionRequest(cr.req, cr.res);

    const { req, res } = mockReqRes({
      user: userAdmin,
      params: { id: venue._id.toString() },
      body: {
        name: 'Venue E15 Admin Edit',
        sportTypes: venue.sportTypes,
        location: venue.location,
        address: venue.address,
        pricePerHour: venue.pricePerHour,
        ownerUserId: ownerA._id.toString()
      }
    });
    await updateVenue(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.name, 'Venue E15 Admin Edit');
    console.log('  PASSED: Admin edited venue despite pending deletion request\n');
    passedTests++;

    await VenueDeletionRequest.deleteMany({ venueId: venue._id });
    await venue.deleteOne();
  }

  // ── SECTION F: Production Index Preflight & Migration ─────────────────────
  console.log('--- F: Index Preflight & Migration Verification ---');

  // Test F16: Preflight script detects duplicate pending requests and aborts
  totalTests++;
  console.log(`Test ${totalTests} (F16): Preflight check detects duplicate pending requests and aborts`);
  {
    const testVenueId = new mongoose.Types.ObjectId();
    const col = mongoose.connection.db.collection('venuedeletionrequests');

    // Temporarily drop index to simulate a legacy database containing duplicates
    try {
      await col.dropIndex('venueId_pending_unique');
    } catch (e) {
      // Index might not exist yet
    }

    // Insert two artificial duplicate pending documents directly into collection
    const doc1 = { venueId: testVenueId, venueName: 'Dup Venue', ownerId: ownerA._id, reason: 'Dup 1', status: 'pending', createdAt: new Date() };
    const doc2 = { venueId: testVenueId, venueName: 'Dup Venue', ownerId: ownerA._id, reason: 'Dup 2', status: 'pending', createdAt: new Date() };
    await col.insertMany([doc1, doc2]);

    const preflight = await runPreflightCheck(col);
    assert.strictEqual(preflight.hasDuplicates, true, 'Preflight must detect duplicate pending requests');
    assert.strictEqual(preflight.duplicates.length, 1);
    assert.strictEqual(preflight.duplicates[0]._id.toString(), testVenueId.toString());
    assert.strictEqual(preflight.duplicates[0].count, 2);

    const migrationResult = await migrateVenueDeletionRequestIndex(mongoose.connection.db);
    assert.strictEqual(migrationResult.success, false, 'Migration must abort when duplicates exist');

    console.log('  PASSED: Preflight check caught duplicates and halted migration\n');
    passedTests++;

    // Clean up artificial duplicates
    await col.deleteMany({ venueId: testVenueId });
  }

  // Test F17: Migration creates and verifies unique partial index with listIndexes()
  totalTests++;
  console.log(`Test ${totalTests} (F17): Migration script creates and verifies index using listIndexes()`);
  {
    const result = await migrateVenueDeletionRequestIndex(mongoose.connection.db);
    assert.strictEqual(result.success, true, 'Migration must succeed on clean database');

    const col = mongoose.connection.db.collection('venuedeletionrequests');
    const indexes = await col.indexes();
    const verified = indexes.find(i => i.name === 'venueId_pending_unique');

    assert.ok(verified, 'Index venueId_pending_unique must exist in listIndexes()');
    assert.strictEqual(verified.unique, true, 'Index must be unique');
    assert.deepStrictEqual(verified.partialFilterExpression, { status: 'pending' }, 'Partial filter must match status: pending');

    console.log('  PASSED: Unique partial index verified via listIndexes()\n');
    passedTests++;
  }

  // ── SECTION G: HTTP-Level Express Routes & Middleware Integration ─────────
  console.log('--- G: HTTP Express Route & Middleware Integration ---');

  const app = express();
  app.use(express.json());
  app.use('/api/venue-deletion-requests', require('./src/routes/venueDeletionRequestRoutes'));

  const httpServer = http.createServer(app);
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;
  const baseUrl = `http://127.0.0.1:${port}/api/venue-deletion-requests`;

  const ownerToken = jwt.sign({ id: ownerA._id }, process.env.JWT_SECRET);
  const playerToken = jwt.sign({ id: player._id }, process.env.JWT_SECRET);
  const adminToken = jwt.sign({ id: admin._id }, process.env.JWT_SECRET);

  // Test G18: Unauthenticated request returns HTTP 401
  totalTests++;
  console.log(`Test ${totalTests} (G18): HTTP request without token returns 401`);
  {
    const response = await fetch(`${baseUrl}/my`, { method: 'GET' });
    assert.strictEqual(response.status, 401);
    const body = await response.json();
    assert.ok(body.message.includes('Not authorized'));
    console.log('  PASSED: Unauthenticated request blocked by protect middleware (401)\n');
    passedTests++;
  }

  // Test G19: Player-role token returns HTTP 403 on deletion route
  totalTests++;
  console.log(`Test ${totalTests} (G19): Player-role token returns 403 on deletion submission`);
  {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${playerToken}`
      },
      body: JSON.stringify({ venueId: new mongoose.Types.ObjectId(), reason: 'Player trying to delete' })
    });
    assert.strictEqual(response.status, 403);
    const body = await response.json();
    assert.ok(body.message.includes('not authorized'));
    console.log('  PASSED: Player role blocked by authorizeRoles middleware (403)\n');
    passedTests++;
  }

  // Test G20: Owner token returns HTTP 403 on admin-only approve route
  totalTests++;
  console.log(`Test ${totalTests} (G20): Owner token returns 403 on approve route`);
  {
    const dummyId = new mongoose.Types.ObjectId();
    const response = await fetch(`${baseUrl}/${dummyId}/approve`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`
      },
      body: JSON.stringify({})
    });
    assert.strictEqual(response.status, 403);
    console.log('  PASSED: Owner role blocked from admin approve route (403)\n');
    passedTests++;
  }

  // Test G21: Authenticated owner submits deletion request via HTTP (201)
  let httpCreatedRequestId;
  const httpVenue = await createTestVenue(ownerA._id, { name: 'HTTP Test Venue' });

  totalTests++;
  console.log(`Test ${totalTests} (G21): Authenticated owner submits deletion request via HTTP (201)`);
  {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`
      },
      body: JSON.stringify({
        venueId: httpVenue._id.toString(),
        reason: 'Business relocation to another district'
      })
    });
    assert.strictEqual(response.status, 201);
    const body = await response.json();
    assert.strictEqual(body.status, 'pending');
    assert.strictEqual(body.venueId.toString(), httpVenue._id.toString());
    httpCreatedRequestId = body._id;
    console.log('  PASSED: Owner created request over HTTP Express stack (201)\n');
    passedTests++;
  }

  // Test G22: Authenticated admin approves deletion request via HTTP (200)
  totalTests++;
  console.log(`Test ${totalTests} (G22): Authenticated admin approves deletion request via HTTP (200)`);
  {
    const response = await fetch(`${baseUrl}/${httpCreatedRequestId}/approve`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ adminResponse: 'Approved via HTTP test' })
    });
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.status, 'approved');

    const venueAfter = await Venue.findById(httpVenue._id);
    assert.strictEqual(venueAfter.isActive, false, 'Venue must be deactivated in database');

    console.log('  PASSED: Admin approved request over HTTP Express stack (200)\n');
    passedTests++;

    await VenueDeletionRequest.deleteMany({ venueId: httpVenue._id });
    await httpVenue.deleteOne();
  }

  // Clean up HTTP server
  await new Promise((resolve) => httpServer.close(resolve));

  // ─── Teardown ──────────────────────────────────────────────────────────────
  await mongoose.disconnect();
  await replSet.stop();

  // ─── Summary ───────────────────────────────────────────────────────────────
  const failedTests = totalTests - passedTests - blockedTests;
  console.log('=================================================================');
  console.log(` TOTAL TESTS RUN : ${totalTests}`);
  console.log(` PASSED          : ${passedTests}/${totalTests}`);
  if (blockedTests > 0) {
    console.log(` BLOCKED         : ${blockedTests}/${totalTests}`);
  }
  if (failedTests > 0) {
    console.log(` FAILED          : ${failedTests}/${totalTests}`);
    process.exit(1);
  }
  console.log(' ALL INTEGRATION & HTTP TESTS PASSED WITH ZERO FAILURES! ✅');
  console.log('=================================================================');
})().catch((err) => {
  console.error('Unhandled error in integration test suite:', err);
  process.exit(1);
});
