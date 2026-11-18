/**
 * PlayNowArena — Safe Booking System & Concurrency Audit Test Suite
 *
 * Tests the 15 required scenarios in Section 7 of the user prompt:
 * 1. User A books an available slot.
 * 2. User B attempts to book the same slot.
 * 3. User A locks a slot and User B attempts to book it.
 * 4. User A books their own legitimately locked slot.
 * 5. An expired lock is handled correctly.
 * 6. A user cancels a booking.
 * 7. A manually blocked slot remains blocked after cancellation.
 * 8. A cancelled booking at an inactive venue does not reopen slots.
 * 9. An already cancelled booking cannot be cancelled again.
 * 10. A user cannot cancel another user's booking.
 * 11. Two users attempt simultaneous multi-slot bookings.
 * 12. Admin approves a venue deletion.
 * 13. Owner has multiple active venues and deletes one.
 * 14. Owner's last active venue is deactivated.
 * 15. Existing booked slots remain preserved.
 *
 * Runs against MongoMemoryReplSet (isolated, never touches production).
 */

const assert = require('assert');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('./node_modules/mongoose');
const { MongoMemoryReplSet } = require('./node_modules/mongodb-memory-server');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'supersecretplaynowkey';

// Mock External Services (Sockets, Emails, Push, ID generator, n8n)
const socketMock = {
  getIO: () => ({
    to: () => ({
      emit: () => {}
    })
  })
};
let mockIdSeq = 1000;
const Module = require('module');
const origRequire = Module.prototype.require;
Module.prototype.require = function(path) {
  if (path === '../socket' || path === './socket') {
    return socketMock;
  }
  if (path.includes('emailService')) {
    return {
      sendBookingConfirmationEmail: async () => ({ success: true, skipped: true }),
      sendOwnerNewBookingEmail: async () => ({ success: true, skipped: true })
    };
  }
  if (path.includes('fcmService')) {
    return {
      sendUserPushNotification: async () => ({ success: true, skipped: true })
    };
  }
  if (path.includes('n8nService')) {
    return {
      sendBookingConfirmation: async () => {}
    };
  }
  if (path.includes('generatePlayNowId')) {
    return async (entity) => `PN_${entity.toUpperCase()}_${mockIdSeq++}`;
  }
  return origRequire.apply(this, arguments);
};

// Models
const Venue = require('./src/models/Venue');
const Slot = require('./src/models/Slot');
const Booking = require('./src/models/Booking');
const User = require('./src/models/User');
const VenueDeletionRequest = require('./src/models/VenueDeletionRequest');
const syncOwnerRole = require('./src/utils/syncOwnerRole');

// Routes
const bookingRoutes = require('./src/routes/bookingRoutes');
const slotRoutes = require('./src/routes/slotRoutes');
const venueDeletionRequestRoutes = require('./src/routes/venueDeletionRequestRoutes');

let server;
let baseUrl;
let replSet;

// Helper to make HTTP requests
function apiRequest(method, endpoint, token, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, baseUrl);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json'
      }
    };
    if (token) {
      options.headers.Authorization = `Bearer ${token}`;
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) { json = data; }
        resolve({ status: res.statusCode, body: json });
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

function generateToken(user) {
  return jwt.sign(
    { id: user._id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '1d' }
  );
}

// Future date helpers (always tomorrow onwards)
function getFutureDate(daysAhead = 2) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(10, 0, 0, 0);
  return d;
}

async function runTests() {
  console.log('=================================================================');
  console.log('  CRITICAL BOOKING & VENUE SYSTEM AUDIT (15 SCENARIOS)');
  console.log('=================================================================\n');

  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' }
  });
  const uri = replSet.getUri();
  await mongoose.connect(uri);

  console.log('Connected to replica set:', uri);
  console.log('Transaction support: YES\n');

  // Express Setup
  const app = express();
  app.use(express.json());
  app.use('/api/bookings', bookingRoutes);
  app.use('/api/slots', slotRoutes);
  app.use('/api/venue-deletion-requests', venueDeletionRequestRoutes);

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  // Seed Users
  const userA = await User.create({
    name: 'User A',
    email: 'userA@test.com',
    phone: '9876543210',
    role: 'player',
    playNowId: 'U-TEST-A'
  });
  const tokenA = generateToken(userA);

  const userB = await User.create({
    name: 'User B',
    email: 'userB@test.com',
    phone: '9876543211',
    role: 'player',
    playNowId: 'U-TEST-B'
  });
  const tokenB = generateToken(userB);

  const owner1 = await User.create({
    name: 'Owner One',
    email: 'owner1@test.com',
    phone: '9876543212',
    role: 'owner',
    playNowId: 'U-OWNER-1'
  });
  const tokenOwner1 = generateToken(owner1);

  const adminUser = await User.create({
    name: 'Admin User',
    email: 'admin@test.com',
    phone: '9876543213',
    role: 'admin',
    playNowId: 'U-ADMIN-1'
  });
  const tokenAdmin = generateToken(adminUser);

  // Seed Active Venue
  const venue1 = await Venue.create({
    name: 'Arena Central',
    venueCode: 'VC-TEST-001',
    sportTypes: ['Badminton', 'Football'],
    location: 'Bangalore',
    address: '123 Main Road',
    pricePerHour: 500,
    ownerId: owner1._id,
    isActive: true
  });

  let passedCount = 0;

  // ---------------------------------------------------------------------------
  // SCENARIO 1: User A books an available slot
  // ---------------------------------------------------------------------------
  console.log('Scenario 1: User A books an available slot');
  const slot1 = await Slot.create({
    venueId: venue1._id,
    courtCode: 'CRT-1',
    date: getFutureDate(2),
    startTime: '10:00',
    endTime: '11:00',
    price: 500,
    status: 'available'
  });

  const res1 = await apiRequest('POST', '/api/bookings', tokenA, {
    venueId: venue1._id.toString(),
    slotIds: [slot1._id.toString()],
    paymentType: 'full',
    paidAmount: 500
  });

  assert.strictEqual(res1.status, 201, `Expected 201, got ${res1.status}`);
  assert.strictEqual(res1.body.bookingStatus, 'confirmed');
  assert.strictEqual(res1.body.paidAmount, 500);

  const dbSlot1 = await Slot.findById(slot1._id);
  assert.strictEqual(dbSlot1.status, 'booked', 'Slot status must be booked');
  console.log('  PASSED: User A successfully booked available slot\n');
  passedCount++;

  // ---------------------------------------------------------------------------
  // SCENARIO 2: User B attempts to book the same slot
  // ---------------------------------------------------------------------------
  console.log('Scenario 2: User B attempts to book the same slot');
  const res2 = await apiRequest('POST', '/api/bookings', tokenB, {
    venueId: venue1._id.toString(),
    slotIds: [slot1._id.toString()],
    paymentType: 'full',
    paidAmount: 500
  });

  assert.ok(res2.status === 400 || res2.status === 409, `Expected 400 or 409, got ${res2.status}`);
  const dbSlot1AfterB = await Slot.findById(slot1._id);
  assert.strictEqual(dbSlot1AfterB.status, 'booked', 'Slot must remain booked by User A');
  console.log('  PASSED: User B booking rejected; slot remained safely booked by User A\n');
  passedCount++;

  // ---------------------------------------------------------------------------
  // SCENARIO 3: User A locks a slot and User B attempts to book it
  // ---------------------------------------------------------------------------
  console.log('Scenario 3: User A locks a slot and User B attempts to book it');
  const slot2 = await Slot.create({
    venueId: venue1._id,
    courtCode: 'CRT-1',
    date: getFutureDate(2),
    startTime: '11:00',
    endTime: '12:00',
    price: 500,
    status: 'available'
  });

  // User A locks slot2
  const lockRes = await apiRequest('POST', '/api/slots/lock', tokenA, {
    venueId: venue1._id.toString(),
    slotIds: [slot2._id.toString()]
  });
  assert.strictEqual(lockRes.status, 200, `Expected 200 on lock, got ${lockRes.status}`);

  // User B tries to book User A's locked slot
  const res3 = await apiRequest('POST', '/api/bookings', tokenB, {
    venueId: venue1._id.toString(),
    slotIds: [slot2._id.toString()],
    paymentType: 'full',
    paidAmount: 500
  });

  assert.ok(res3.status === 400 || res3.status === 409, `Expected 400 or 409, got ${res3.status}`);
  const dbSlot2 = await Slot.findById(slot2._id);
  assert.strictEqual(dbSlot2.status, 'locked');
  assert.strictEqual(dbSlot2.lockedBy.toString(), userA._id.toString());
  console.log("  PASSED: User B cannot book another user's locked slot\n");
  passedCount++;

  // ---------------------------------------------------------------------------
  // SCENARIO 4: User A books their own legitimately locked slot
  // ---------------------------------------------------------------------------
  console.log('Scenario 4: User A books their own legitimately locked slot');
  const res4 = await apiRequest('POST', '/api/bookings', tokenA, {
    venueId: venue1._id.toString(),
    slotIds: [slot2._id.toString()],
    paymentType: 'full',
    paidAmount: 500
  });

  assert.strictEqual(res4.status, 201, `Expected 201, got ${res4.status}`);
  const dbSlot2Booked = await Slot.findById(slot2._id);
  assert.strictEqual(dbSlot2Booked.status, 'booked');
  console.log('  PASSED: User A successfully booked their own locked slot\n');
  passedCount++;

  // ---------------------------------------------------------------------------
  // SCENARIO 5: An expired lock is handled correctly
  // ---------------------------------------------------------------------------
  console.log('Scenario 5: An expired lock is handled correctly');
  const slot3 = await Slot.create({
    venueId: venue1._id,
    courtCode: 'CRT-1',
    date: getFutureDate(2),
    startTime: '12:00',
    endTime: '13:00',
    price: 500,
    status: 'locked',
    lockedBy: userA._id,
    lockExpiresAt: new Date(Date.now() - 1000 * 60) // expired 1 minute ago
  });

  // User B attempts to book the slot whose lock expired
  const res5 = await apiRequest('POST', '/api/bookings', tokenB, {
    venueId: venue1._id.toString(),
    slotIds: [slot3._id.toString()],
    paymentType: 'full',
    paidAmount: 500
  });

  assert.strictEqual(res5.status, 201, `Expected 201 for expired lock booking, got ${res5.status}`);
  const dbSlot3 = await Slot.findById(slot3._id);
  assert.strictEqual(dbSlot3.status, 'booked');
  console.log('  PASSED: Expired lock correctly allowed new booking\n');
  passedCount++;

  // ---------------------------------------------------------------------------
  // SCENARIO 6: A user cancels a booking
  // ---------------------------------------------------------------------------
  console.log('Scenario 6: A user cancels a booking');
  const slot4 = await Slot.create({
    venueId: venue1._id,
    courtCode: 'CRT-1',
    date: getFutureDate(3),
    startTime: '14:00',
    endTime: '15:00',
    price: 500,
    status: 'available'
  });

  const bookingToCancelRes = await apiRequest('POST', '/api/bookings', tokenA, {
    venueId: venue1._id.toString(),
    slotIds: [slot4._id.toString()],
    paymentType: 'full',
    paidAmount: 500
  });
  assert.strictEqual(bookingToCancelRes.status, 201);
  const bookingId = bookingToCancelRes.body._id;

  // Cancel booking
  const cancelRes = await apiRequest('PUT', `/api/bookings/${bookingId}/cancel`, tokenA);
  assert.strictEqual(cancelRes.status, 200, `Expected 200, got ${cancelRes.status}`);
  assert.strictEqual(cancelRes.body.booking.bookingStatus, 'cancelled');
  assert.strictEqual(cancelRes.body.booking.refundAmount, 500);
  assert.strictEqual(cancelRes.body.booking.cancellationFee, 0);

  const dbSlot4 = await Slot.findById(slot4._id);
  assert.strictEqual(dbSlot4.status, 'available', 'Slot must be released to available');
  console.log('  PASSED: User cancelled booking and slot was safely released\n');
  passedCount++;

  // ---------------------------------------------------------------------------
  // SCENARIO 7: A manually blocked slot remains blocked after cancellation
  // ---------------------------------------------------------------------------
  console.log('Scenario 7: A manually blocked slot remains blocked after cancellation');
  const slot5 = await Slot.create({
    venueId: venue1._id,
    courtCode: 'CRT-1',
    date: getFutureDate(3),
    startTime: '15:00',
    endTime: '16:00',
    price: 500,
    status: 'available'
  });

  const booking5Res = await apiRequest('POST', '/api/bookings', tokenA, {
    venueId: venue1._id.toString(),
    slotIds: [slot5._id.toString()],
    paymentType: 'full',
    paidAmount: 500
  });
  assert.strictEqual(booking5Res.status, 201);

  // Owner manually blocks the slot during maintenance
  await Slot.findByIdAndUpdate(slot5._id, {
    status: 'blocked',
    blockReason: 'Maintenance emergency'
  });

  // User A cancels their booking
  const cancel5Res = await apiRequest('PUT', `/api/bookings/${booking5Res.body._id}/cancel`, tokenA);
  assert.strictEqual(cancel5Res.status, 200);

  const dbSlot5 = await Slot.findById(slot5._id);
  assert.strictEqual(dbSlot5.status, 'blocked', 'Manually blocked slot must REMAIN blocked');
  assert.strictEqual(dbSlot5.blockReason, 'Maintenance emergency');
  console.log('  PASSED: Manually blocked slot remained blocked after booking cancellation\n');
  passedCount++;

  // ---------------------------------------------------------------------------
  // SCENARIO 8: A cancelled booking at an inactive venue does not reopen slots
  // ---------------------------------------------------------------------------
  console.log('Scenario 8: A cancelled booking at an inactive venue does not reopen slots');
  const inactiveVenue = await Venue.create({
    name: 'Inactive Turf',
    venueCode: 'VC-TEST-002',
    sportTypes: ['Cricket'],
    location: 'Chennai',
    address: '456 Side St',
    pricePerHour: 600,
    ownerId: owner1._id,
    isActive: true // start active so we can book
  });

  const slot6 = await Slot.create({
    venueId: inactiveVenue._id,
    courtCode: 'CRT-1',
    date: getFutureDate(4),
    startTime: '10:00',
    endTime: '11:00',
    price: 600,
    status: 'available'
  });

  const booking6Res = await apiRequest('POST', '/api/bookings', tokenA, {
    venueId: inactiveVenue._id.toString(),
    slotIds: [slot6._id.toString()],
    paymentType: 'full',
    paidAmount: 600
  });
  assert.strictEqual(booking6Res.status, 201);

  // Deactivate venue
  await Venue.findByIdAndUpdate(inactiveVenue._id, { isActive: false });

  // Cancel booking
  const cancel6Res = await apiRequest('PUT', `/api/bookings/${booking6Res.body._id}/cancel`, tokenA);
  assert.strictEqual(cancel6Res.status, 200);

  const dbSlot6 = await Slot.findById(slot6._id);
  assert.notStrictEqual(dbSlot6.status, 'available', 'Slots at inactive venue must NEVER reopen as available');
  assert.strictEqual(dbSlot6.status, 'blocked', 'Slots at inactive venue must be blocked');
  console.log('  PASSED: Inactive venue cancellation does not reopen slots\n');
  passedCount++;

  // ---------------------------------------------------------------------------
  // SCENARIO 9: An already cancelled booking cannot be cancelled again
  // ---------------------------------------------------------------------------
  console.log('Scenario 9: An already cancelled booking cannot be cancelled again');
  const cancelAgainRes = await apiRequest('PUT', `/api/bookings/${bookingToCancelRes.body._id}/cancel`, tokenA);
  assert.strictEqual(cancelAgainRes.status, 400, `Expected 400 for duplicate cancel, got ${cancelAgainRes.status}`);
  assert.ok(cancelAgainRes.body.message.includes('already cancelled'));
  console.log('  PASSED: Second cancellation attempt cleanly rejected with 400\n');
  passedCount++;

  // ---------------------------------------------------------------------------
  // SCENARIO 10: A user cannot cancel another user's booking
  // ---------------------------------------------------------------------------
  console.log("Scenario 10: A user cannot cancel another user's booking");
  const slot7 = await Slot.create({
    venueId: venue1._id,
    courtCode: 'CRT-1',
    date: getFutureDate(3),
    startTime: '16:00',
    endTime: '17:00',
    price: 500,
    status: 'available'
  });

  const booking7Res = await apiRequest('POST', '/api/bookings', tokenA, {
    venueId: venue1._id.toString(),
    slotIds: [slot7._id.toString()],
    paymentType: 'full',
    paidAmount: 500
  });
  assert.strictEqual(booking7Res.status, 201);

  // User B attempts to cancel User A's booking
  const unauthorizedCancelRes = await apiRequest('PUT', `/api/bookings/${booking7Res.body._id}/cancel`, tokenB);
  assert.strictEqual(unauthorizedCancelRes.status, 403, `Expected 403 Forbidden, got ${unauthorizedCancelRes.status}`);
  console.log('  PASSED: Cross-user booking cancellation blocked with 403 Forbidden\n');
  passedCount++;

  // ---------------------------------------------------------------------------
  // SCENARIO 11: Two users attempt simultaneous multi-slot bookings
  // ---------------------------------------------------------------------------
  console.log('Scenario 11: Two users attempt simultaneous multi-slot bookings');
  const slotMultiA = await Slot.create({
    venueId: venue1._id,
    courtCode: 'CRT-2',
    date: getFutureDate(3),
    startTime: '18:00',
    endTime: '19:00',
    price: 400,
    status: 'available'
  });
  const slotMultiB = await Slot.create({
    venueId: venue1._id,
    courtCode: 'CRT-2',
    date: getFutureDate(3),
    startTime: '19:00',
    endTime: '20:00',
    price: 400,
    status: 'available'
  });

  const multiPayload = {
    venueId: venue1._id.toString(),
    slotIds: [slotMultiA._id.toString(), slotMultiB._id.toString()],
    paymentType: 'full',
    paidAmount: 800
  };

  const [simA, simB] = await Promise.all([
    apiRequest('POST', '/api/bookings', tokenA, multiPayload),
    apiRequest('POST', '/api/bookings', tokenB, multiPayload)
  ]);

  const statuses = [simA.status, simB.status].sort();
  assert.deepStrictEqual(statuses, [201, 409], `Expected [201, 409], got ${JSON.stringify(statuses)}`);

  // Verify DB state: exactly 1 booking exists for each slot, both slots booked
  const dbMultiA = await Slot.findById(slotMultiA._id);
  const dbMultiB = await Slot.findById(slotMultiB._id);
  assert.strictEqual(dbMultiA.status, 'booked');
  assert.strictEqual(dbMultiB.status, 'booked');

  const totalBookingsForMulti = await Booking.countDocuments({
    slotIds: { $in: [slotMultiA._id, slotMultiB._id] },
    bookingStatus: 'confirmed'
  });
  assert.strictEqual(totalBookingsForMulti, 1, 'Exactly one booking must exist for the multi-slot pair');
  console.log('  PASSED: Concurrent multi-slot bookings: exactly 1 succeeded (201), 1 rejected (409)\n');
  passedCount++;

  // ---------------------------------------------------------------------------
  // SCENARIO 12: Admin approves a venue deletion
  // ---------------------------------------------------------------------------
  console.log('Scenario 12: Admin approves a venue deletion');
  const venueToDelete = await Venue.create({
    name: 'Turf To Delete',
    venueCode: 'VC-TEST-003',
    sportTypes: ['Tennis'],
    location: 'Hyderabad',
    address: 'Road 12',
    pricePerHour: 700,
    ownerId: owner1._id,
    isActive: true
  });

  const availSlot = await Slot.create({
    venueId: venueToDelete._id,
    courtCode: 'CRT-1',
    date: getFutureDate(3),
    startTime: '10:00',
    endTime: '11:00',
    price: 700,
    status: 'available'
  });

  const lockedSlot = await Slot.create({
    venueId: venueToDelete._id,
    courtCode: 'CRT-1',
    date: getFutureDate(3),
    startTime: '11:00',
    endTime: '12:00',
    price: 700,
    status: 'locked',
    lockedBy: userA._id,
    lockExpiresAt: new Date(Date.now() + 15 * 60 * 1000)
  });

  const bookedSlot = await Slot.create({
    venueId: venueToDelete._id,
    courtCode: 'CRT-1',
    date: getFutureDate(3),
    startTime: '12:00',
    endTime: '13:00',
    price: 700,
    status: 'booked'
  });

  const delReq = await VenueDeletionRequest.create({
    venueId: venueToDelete._id,
    ownerId: owner1._id,
    reason: 'Closing permanently',
    status: 'pending'
  });

  const approveRes = await apiRequest('PUT', `/api/venue-deletion-requests/${delReq._id}/approve`, tokenAdmin, {
    adminResponse: 'Approved by admin'
  });
  assert.strictEqual(approveRes.status, 200, `Expected 200, got ${approveRes.status}`);

  const dbDelVenue = await Venue.findById(venueToDelete._id);
  assert.strictEqual(dbDelVenue.isActive, false, 'Venue must be deactivated');

  const dbAvail = await Slot.findById(availSlot._id);
  assert.strictEqual(dbAvail.status, 'blocked', 'Available slot must become blocked');

  const dbLocked = await Slot.findById(lockedSlot._id);
  assert.strictEqual(dbLocked.status, 'blocked', 'Locked slot must become blocked');

  const dbBooked = await Slot.findById(bookedSlot._id);
  assert.strictEqual(dbBooked.status, 'booked', 'Booked slot must remain preserved');

  console.log('  PASSED: Venue deletion approval deactivated venue, blocked unbooked slots, preserved booked slots\n');
  passedCount++;

  // ---------------------------------------------------------------------------
  // SCENARIO 13: Owner has multiple active venues and deletes one
  // ---------------------------------------------------------------------------
  console.log('Scenario 13: Owner has multiple active venues and deletes one');
  const multiOwner = await User.create({
    name: 'Multi Venue Owner',
    email: 'multi@test.com',
    phone: '9876543299',
    role: 'owner',
    playNowId: 'U-MULTI-1'
  });
  const tokenMulti = generateToken(multiOwner);

  const venueA = await Venue.create({
    name: 'Multi Venue A',
    venueCode: 'VC-TEST-004',
    sportTypes: ['Cricket'],
    location: 'Bangalore',
    address: 'East St',
    pricePerHour: 500,
    ownerId: multiOwner._id,
    isActive: true
  });

  const venueB = await Venue.create({
    name: 'Multi Venue B',
    venueCode: 'VC-TEST-005',
    sportTypes: ['Football'],
    location: 'Bangalore',
    address: 'West St',
    pricePerHour: 600,
    ownerId: multiOwner._id,
    isActive: true
  });

  await syncOwnerRole(multiOwner._id);
  let dbMultiOwner = await User.findById(multiOwner._id);
  assert.strictEqual(dbMultiOwner.role, 'owner');

  // Request deletion for venue A
  const reqMultiA = await VenueDeletionRequest.create({
    venueId: venueA._id,
    ownerId: multiOwner._id,
    reason: 'Downsizing branch A',
    status: 'pending'
  });

  // Admin approves deletion for venue A
  const appA = await apiRequest('PUT', `/api/venue-deletion-requests/${reqMultiA._id}/approve`, tokenAdmin, {
    adminResponse: 'Approved branch A closure'
  });
  assert.strictEqual(appA.status, 200);

  dbMultiOwner = await User.findById(multiOwner._id);
  assert.strictEqual(dbMultiOwner.role, 'owner', 'Owner still has Venue B active, so must remain owner');
  console.log('  PASSED: Owner with remaining active venue remains an owner\n');
  passedCount++;

  // ---------------------------------------------------------------------------
  // SCENARIO 14: Owner\'s last active venue is deactivated
  // ---------------------------------------------------------------------------
  console.log("Scenario 14: Owner's last active venue is deactivated");
  // Now request deletion for venue B (the last active venue)
  const reqMultiB = await VenueDeletionRequest.create({
    venueId: venueB._id,
    ownerId: multiOwner._id,
    reason: 'Downsizing branch B',
    status: 'pending'
  });

  // Admin approves deletion for venue B
  const appB = await apiRequest('PUT', `/api/venue-deletion-requests/${reqMultiB._id}/approve`, tokenAdmin, {
    adminResponse: 'Approved branch B closure'
  });
  assert.strictEqual(appB.status, 200);

  dbMultiOwner = await User.findById(multiOwner._id);
  assert.strictEqual(dbMultiOwner.role, 'player', "Owner's last active venue deactivated -> demoted to player");
  console.log("  PASSED: Owner's last active venue deactivated -> successfully demoted to player\n");
  passedCount++;

  // ---------------------------------------------------------------------------
  // SCENARIO 15: Existing booked slots remain preserved
  // ---------------------------------------------------------------------------
  console.log('Scenario 15: Existing booked slots remain preserved');
  // Check booked slot from Scenario 1
  const preservedSlot1 = await Slot.findById(slot1._id);
  assert.strictEqual(preservedSlot1.status, 'booked');

  // Check booked slot from Scenario 11
  const preservedSlotMultiA = await Slot.findById(slotMultiA._id);
  assert.strictEqual(preservedSlotMultiA.status, 'booked');

  // Check booked slot from Scenario 12
  const preservedSlotDel = await Slot.findById(bookedSlot._id);
  assert.strictEqual(preservedSlotDel.status, 'booked');

  console.log('  PASSED: All historical and existing booked slots remain intact and preserved\n');
  passedCount++;

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------
  await server.close();
  await mongoose.disconnect();
  await replSet.stop();

  console.log('=================================================================');
  console.log(` TOTAL SCENARIOS RUN : 15`);
  console.log(` PASSED              : ${passedCount}/15`);
  console.log(' ALL 15 BOOKING & VENUE SYSTEM SCENARIOS PASSED WITH ZERO FAILURES! ✅');
  console.log('=================================================================');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exitCode = 1;
  if (server) server.close();
  mongoose.disconnect().finally(() => {
    if (replSet) replSet.stop();
  });
});
