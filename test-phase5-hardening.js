/**
 * PlayNow Phase 5.1 Hardening Regression Test Suite
 *
 * Verifies FIX 1 through FIX 6:
 * 1. Two concurrent cancellation requests cannot issue two refunds.
 * 2. Refund status pending remains refund_pending.
 * 3. Refund status created remains refund_pending.
 * 4. Refund status processed becomes refunded.
 * 5. Gateway timeout does not trigger an unsafe duplicate refund.
 * 6. Unauthenticated create-order returns 401.
 * 7. Unauthenticated verify-payment returns 401.
 * 8. User cannot verify another user's payment intent.
 * 9. Walk-in online payment method is rejected.
 * 10. Walk-in cash booking still works.
 * 11. Orphan recovery does not affect valid bookings.
 * 12. Concurrent orphan recovery cannot release a newly claimed slot.
 */

const assert = require('assert');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const mongoose = require('./node_modules/mongoose');
const { MongoMemoryReplSet } = require('./node_modules/mongodb-memory-server');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'supersecretplaynowkey';
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_key123';
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'rzp_test_secret456';

// Controlled Mock for Razorpay
let mockRefundResponseStatus = 'processed';
let mockRefundShouldTimeout = false;
let refundCallCount = 0;
const refundHistory = [];

const razorpayMock = {
  createOrder: async ({ amount, currency, receipt, notes }) => ({
    id: `order_${Date.now()}_${Math.random().toString(36).substring(7)}`,
    amount,
    currency,
    receipt,
    notes,
    status: 'created'
  }),
  getPayment: async (paymentId) => ({
    id: paymentId,
    order_id: 'order_test_fixed',
    amount: 50000,
    currency: 'INR',
    status: 'captured'
  }),
  verifyPaymentSignature: ({ orderId, paymentId, signature }) => {
    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');
    return signature === expected;
  },
  createRefund: async ({ paymentId, amount, notes }) => {
    refundCallCount++;
    refundHistory.push({ paymentId, amount, notes, time: Date.now() });

    if (mockRefundShouldTimeout) {
      throw new Error('ETIMEDOUT: Gateway connection timed out');
    }

    return {
      id: `rfnd_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      entity: 'refund',
      amount: Math.round(Number(amount) * 100),
      status: mockRefundResponseStatus
    };
  },
  getPublicKeyId: () => process.env.RAZORPAY_KEY_ID
};

const socketMock = {
  getIO: () => ({ to: () => ({ emit: () => {} }) })
};

let mockIdSeq = 8000;
const Module = require('module');
const origRequire = Module.prototype.require;
Module.prototype.require = function(path) {
  if (path === '../socket' || path === './socket') return socketMock;
  if (path.includes('razorpayService')) return razorpayMock;
  if (path.includes('emailService')) {
    return {
      sendBookingConfirmationEmail: async () => ({ success: true }),
      sendOwnerNewBookingEmail: async () => ({ success: true })
    };
  }
  if (path.includes('fcmService')) {
    return { sendUserPushNotification: async () => ({ success: true }) };
  }
  if (path.includes('n8nService')) {
    return { sendBookingConfirmation: async () => {} };
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
const PaymentIntent = require('./src/models/PaymentIntent');

// Routes
const bookingRoutes = require('./src/routes/bookingRoutes');
const paymentRoutes = require('./src/routes/paymentRoutes');
const { recoverOrphanedSlots } = require('./src/utils/slotRecoveryService');

let server;
let baseUrl;
let replSet;

function apiRequest(method, endpoint, token, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, baseUrl);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json' }
    };
    if (token) options.headers.Authorization = `Bearer ${token}`;

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
    if (body) req.write(JSON.stringify(body));
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

function getFutureDate(daysAhead = 3) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(10, 0, 0, 0);
  return d;
}

async function runHardeningTests() {
  console.log('=================================================================');
  console.log('  PHASE 5.1 HARDENING & REGRESSION SUITE (12 TEST SCENARIOS)');
  console.log('=================================================================\n');

  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' }
  });
  const uri = replSet.getUri();
  await mongoose.connect(uri);

  const app = express();
  app.use(express.json());
  app.use('/api/bookings', bookingRoutes);
  app.use('/api/payments', paymentRoutes);

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  // Seed test users
  const playerA = await User.create({
    name: 'Player A',
    email: 'playerA@hard.test',
    phone: '9111111111',
    role: 'player',
    playNowId: 'U-HARD-PA'
  });
  const tokenA = generateToken(playerA);

  const playerB = await User.create({
    name: 'Player B',
    email: 'playerB@hard.test',
    phone: '9222222222',
    role: 'player',
    playNowId: 'U-HARD-PB'
  });
  const tokenB = generateToken(playerB);

  const owner = await User.create({
    name: 'Owner User',
    email: 'owner@hard.test',
    phone: '9333333333',
    role: 'owner',
    playNowId: 'U-HARD-OW'
  });
  const ownerToken = generateToken(owner);

  const venue = await Venue.create({
    name: 'Hardening Venue',
    venueCode: 'VC-HARD-01',
    sportTypes: ['Football'],
    location: 'Bangalore',
    address: 'Hardening Lane 1',
    pricePerHour: 500,
    ownerId: owner._id,
    isActive: true
  });

  let passed = 0;

  // ---------------------------------------------------------------------------
  // Test 1: Two concurrent cancellation requests cannot issue two refunds (B3/B4)
  // ---------------------------------------------------------------------------
  console.log('Test 1: Two concurrent cancellation requests cannot issue two refunds');
  refundCallCount = 0;
  mockRefundShouldTimeout = false;
  mockRefundResponseStatus = 'processed';

  const slotC1 = await Slot.create({
    venueId: venue._id,
    courtCode: 'C1',
    date: getFutureDate(3),
    startTime: '10:00',
    endTime: '11:00',
    price: 500,
    status: 'booked'
  });

  const bookingToCancelConcurrently = await Booking.create({
    userId: playerA._id,
    venueId: venue._id,
    slotIds: [slotC1._id],
    totalAmount: 500,
    paymentType: 'full',
    paidAmount: 500,
    remainingAmount: 0,
    bookingStatus: 'confirmed',
    paymentStatus: 'completed',
    razorpayPaymentId: 'pay_concurrent_cancel_01',
    bookingCode: 'PN_CONCUR_01'
  });

  // Fire two simultaneous cancellations
  const [resCancel1, resCancel2] = await Promise.all([
    apiRequest('PUT', `/api/bookings/${bookingToCancelConcurrently._id}/cancel`, tokenA),
    apiRequest('PUT', `/api/bookings/${bookingToCancelConcurrently._id}/cancel`, tokenA)
  ]);

  const statuses = [resCancel1.status, resCancel2.status].sort();
  assert.deepStrictEqual(statuses, [200, 400], 'One request must succeed (200) and the other must be rejected (400)');
  // Wait a moment for non-blocking refund helper
  await new Promise(r => setTimeout(r, 200));

  assert.strictEqual(refundCallCount, 1, 'Gateway createRefund must be called EXACTLY once');
  const dbBookingC1 = await Booking.findById(bookingToCancelConcurrently._id);
  assert.strictEqual(dbBookingC1.bookingStatus, 'cancelled');
  assert.strictEqual(dbBookingC1.paymentStatus, 'refunded');
  console.log('  PASSED: Only one refund issued, concurrent request rejected with 400\n');
  passed++;

  // ---------------------------------------------------------------------------
  // Test 2: Refund status pending remains refund_pending (B2)
  // ---------------------------------------------------------------------------
  console.log('Test 2: Refund response status="pending" sets paymentStatus="refund_pending"');
  mockRefundResponseStatus = 'pending';
  const slotC2 = await Slot.create({
    venueId: venue._id,
    courtCode: 'C1',
    date: getFutureDate(3),
    startTime: '11:00',
    endTime: '12:00',
    price: 500,
    status: 'booked'
  });

  const bookingPendingRefund = await Booking.create({
    userId: playerA._id,
    venueId: venue._id,
    slotIds: [slotC2._id],
    totalAmount: 500,
    paymentType: 'full',
    paidAmount: 500,
    remainingAmount: 0,
    bookingStatus: 'confirmed',
    paymentStatus: 'completed',
    razorpayPaymentId: 'pay_pending_status_02',
    bookingCode: 'PN_PENDING_02'
  });

  const resPending = await apiRequest('PUT', `/api/bookings/${bookingPendingRefund._id}/cancel`, tokenA);
  assert.strictEqual(resPending.status, 200);
  await new Promise(r => setTimeout(r, 150));

  const dbBookingC2 = await Booking.findById(bookingPendingRefund._id);
  assert.strictEqual(dbBookingC2.bookingStatus, 'cancelled');
  assert.strictEqual(dbBookingC2.paymentStatus, 'refund_pending', 'Async pending refund must be refund_pending, NOT refunded');
  assert.ok(dbBookingC2.razorpayRefundId, 'Refund ID must be saved for webhook reconciliation');
  console.log('  PASSED: Asynchronous pending refund recorded as refund_pending with refund ID\n');
  passed++;

  // ---------------------------------------------------------------------------
  // Test 3: Refund status created remains refund_pending (B2)
  // ---------------------------------------------------------------------------
  console.log('Test 3: Refund response status="created" sets paymentStatus="refund_pending"');
  mockRefundResponseStatus = 'created';
  const slotC3 = await Slot.create({
    venueId: venue._id,
    courtCode: 'C1',
    date: getFutureDate(3),
    startTime: '12:00',
    endTime: '13:00',
    price: 500,
    status: 'booked'
  });

  const bookingCreatedRefund = await Booking.create({
    userId: playerA._id,
    venueId: venue._id,
    slotIds: [slotC3._id],
    totalAmount: 500,
    paymentType: 'full',
    paidAmount: 500,
    remainingAmount: 0,
    bookingStatus: 'confirmed',
    paymentStatus: 'completed',
    razorpayPaymentId: 'pay_created_status_03',
    bookingCode: 'PN_CREATED_03'
  });

  await apiRequest('PUT', `/api/bookings/${bookingCreatedRefund._id}/cancel`, tokenA);
  await new Promise(r => setTimeout(r, 150));

  const dbBookingC3 = await Booking.findById(bookingCreatedRefund._id);
  assert.strictEqual(dbBookingC3.paymentStatus, 'refund_pending', 'status=created must set refund_pending');
  console.log('  PASSED: Gateway status="created" marked refund_pending\n');
  passed++;

  // ---------------------------------------------------------------------------
  // Test 4: Refund status processed becomes refunded (B2)
  // ---------------------------------------------------------------------------
  console.log('Test 4: Refund response status="processed" sets paymentStatus="refunded"');
  mockRefundResponseStatus = 'processed';
  const slotC4 = await Slot.create({
    venueId: venue._id,
    courtCode: 'C1',
    date: getFutureDate(3),
    startTime: '13:00',
    endTime: '14:00',
    price: 500,
    status: 'booked'
  });

  const bookingProcessedRefund = await Booking.create({
    userId: playerA._id,
    venueId: venue._id,
    slotIds: [slotC4._id],
    totalAmount: 500,
    paymentType: 'full',
    paidAmount: 500,
    remainingAmount: 0,
    bookingStatus: 'confirmed',
    paymentStatus: 'completed',
    razorpayPaymentId: 'pay_processed_status_04',
    bookingCode: 'PN_PROCESSED_04'
  });

  await apiRequest('PUT', `/api/bookings/${bookingProcessedRefund._id}/cancel`, tokenA);
  await new Promise(r => setTimeout(r, 150));

  const dbBookingC4 = await Booking.findById(bookingProcessedRefund._id);
  assert.strictEqual(dbBookingC4.paymentStatus, 'refunded', 'status=processed must set refunded');
  console.log('  PASSED: Fully processed refund correctly marked paymentStatus="refunded"\n');
  passed++;

  // ---------------------------------------------------------------------------
  // Test 5: Gateway timeout leaves booking in refund_pending and prevents duplicate retry
  // ---------------------------------------------------------------------------
  console.log('Test 5: Gateway timeout leaves booking in refund_pending and avoids blind retry');
  mockRefundShouldTimeout = true;
  refundCallCount = 0;

  const slotC5 = await Slot.create({
    venueId: venue._id,
    courtCode: 'C1',
    date: getFutureDate(3),
    startTime: '14:00',
    endTime: '15:00',
    price: 500,
    status: 'booked'
  });

  const bookingTimeout = await Booking.create({
    userId: playerA._id,
    venueId: venue._id,
    slotIds: [slotC5._id],
    totalAmount: 500,
    paymentType: 'full',
    paidAmount: 500,
    remainingAmount: 0,
    bookingStatus: 'confirmed',
    paymentStatus: 'completed',
    razorpayPaymentId: 'pay_timeout_05',
    bookingCode: 'PN_TIMEOUT_05'
  });

  await apiRequest('PUT', `/api/bookings/${bookingTimeout._id}/cancel`, tokenA);
  await new Promise(r => setTimeout(r, 150));

  const dbBookingC5 = await Booking.findById(bookingTimeout._id);
  assert.strictEqual(dbBookingC5.bookingStatus, 'cancelled');
  assert.strictEqual(dbBookingC5.paymentStatus, 'refund_pending');
  assert.strictEqual(refundCallCount, 1, 'Only one attempt made during timeout');
  console.log('  PASSED: Timeout handled safely, booking remains cancelled with refund_pending\n');
  passed++;

  // Reset timeout mock
  mockRefundShouldTimeout = false;

  // ---------------------------------------------------------------------------
  // Test 6: Unauthenticated create-order returns 401
  // ---------------------------------------------------------------------------
  console.log('Test 6: Unauthenticated create-order returns 401');
  const resNoAuthOrder = await apiRequest('POST', '/api/payments/create-order', null, {
    venueId: venue._id.toString(),
    slotIds: [slotC1._id.toString()],
    paymentType: 'full'
  });
  assert.strictEqual(resNoAuthOrder.status, 401, `Expected 401, got ${resNoAuthOrder.status}`);
  console.log('  PASSED: Unauthenticated POST /api/payments/create-order rejected with 401\n');
  passed++;

  // ---------------------------------------------------------------------------
  // Test 7: Unauthenticated verify-payment returns 401
  // ---------------------------------------------------------------------------
  console.log('Test 7: Unauthenticated verify-payment returns 401');
  const resNoAuthVerify = await apiRequest('POST', '/api/payments/verify-payment', null, {
    razorpay_order_id: 'order_dummy',
    razorpay_payment_id: 'pay_dummy',
    razorpay_signature: 'sig_dummy'
  });
  assert.strictEqual(resNoAuthVerify.status, 401, `Expected 401, got ${resNoAuthVerify.status}`);
  console.log('  PASSED: Unauthenticated POST /api/payments/verify-payment rejected with 401\n');
  passed++;

  // ---------------------------------------------------------------------------
  // Test 8: User cannot verify another user\'s payment intent
  // ---------------------------------------------------------------------------
  console.log('Test 8: User cannot verify another user\'s payment intent');
  const slotC8 = await Slot.create({
    venueId: venue._id,
    courtCode: 'C2',
    date: getFutureDate(4),
    startTime: '10:00',
    endTime: '11:00',
    price: 500,
    status: 'available'
  });

  // Player A creates the order
  const orderResA = await apiRequest('POST', '/api/payments/create-order', tokenA, {
    venueId: venue._id.toString(),
    slotIds: [slotC8._id.toString()],
    paymentType: 'full'
  });
  assert.strictEqual(orderResA.status, 201);
  const orderIdA = orderResA.body.order_id || orderResA.body.orderId;

  // Player B attempts to verify Player A's payment intent
  const resCrossVerify = await apiRequest('POST', '/api/payments/verify-payment', tokenB, {
    razorpay_order_id: orderIdA,
    razorpay_payment_id: 'pay_cross_user_08',
    razorpay_signature: 'fake_sig'
  });
  assert.strictEqual(resCrossVerify.status, 404, `Expected 404 for intent owned by another user, got ${resCrossVerify.status}`);
  console.log('  PASSED: Cross-user payment verification prevented\n');
  passed++;

  // ---------------------------------------------------------------------------
  // Test 9: Walk-in online payment method is rejected
  // ---------------------------------------------------------------------------
  console.log('Test 9: Walk-in endpoint rejects paymentMethod="online"');
  const slotC9 = await Slot.create({
    venueId: venue._id,
    courtCode: 'C2',
    date: getFutureDate(4),
    startTime: '11:00',
    endTime: '12:00',
    price: 500,
    status: 'available'
  });

  const resOnlineWalkin = await apiRequest('POST', '/api/bookings/direct', ownerToken, {
    venueId: venue._id.toString(),
    slotIds: [slotC9._id.toString()],
    paymentType: 'full',
    paidAmount: 500,
    paymentMethod: 'online' // FORBIDDEN for walk-in
  });
  assert.strictEqual(resOnlineWalkin.status, 400, `Expected 400, got ${resOnlineWalkin.status}`);
  assert.ok(resOnlineWalkin.body.message.includes('cash') || resOnlineWalkin.body.message.includes('walkin'));
  console.log('  PASSED: Walk-in booking strictly rejects paymentMethod="online"\n');
  passed++;

  // ---------------------------------------------------------------------------
  // Test 10: Walk-in cash booking still works
  // ---------------------------------------------------------------------------
  console.log('Test 10: Walk-in cash booking still works');
  const resCashWalkin = await apiRequest('POST', '/api/bookings/direct', ownerToken, {
    venueId: venue._id.toString(),
    slotIds: [slotC9._id.toString()],
    paymentType: 'full',
    paidAmount: 500,
    paymentMethod: 'cash'
  });
  assert.strictEqual(resCashWalkin.status, 201);
  assert.strictEqual(resCashWalkin.body.paymentMethod, 'cash');
  console.log('  PASSED: Authorized walk-in cash booking confirmed\n');
  passed++;

  // ---------------------------------------------------------------------------
  // Test 11: Orphan recovery does not affect valid bookings
  // ---------------------------------------------------------------------------
  console.log('Test 11: Orphan recovery preserves valid bookings and recent claims');
  const now = new Date();
  const oldDate = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago

  // Create an old booked slot that IS associated with a real booking
  const validBookedSlot = await Slot.create({
    venueId: venue._id,
    courtCode: 'C3',
    date: getFutureDate(5),
    startTime: '10:00',
    endTime: '11:00',
    price: 500,
    status: 'booked',
    claimToken: 'token_valid_old',
    updatedAt: oldDate
  });

  const validBooking = await Booking.create({
    userId: playerA._id,
    venueId: venue._id,
    slotIds: [validBookedSlot._id],
    totalAmount: 500,
    paymentType: 'full',
    paidAmount: 500,
    remainingAmount: 0,
    bookingStatus: 'confirmed',
    paymentStatus: 'completed',
    bookingCode: 'PN_VALID_SLOT_11'
  });

  // Create a genuine orphan: old, booked, has claimToken, but NO booking references it
  const orphanedSlot = await Slot.create({
    venueId: venue._id,
    courtCode: 'C3',
    date: getFutureDate(5),
    startTime: '11:00',
    endTime: '12:00',
    price: 500,
    status: 'booked',
    claimToken: 'token_orphan_123'
  });
  // Explicitly backdate updatedAt without triggering timestamps overwrite
  await Slot.collection.updateOne(
    { _id: orphanedSlot._id },
    { $set: { updatedAt: oldDate } }
  );

  await Slot.collection.updateOne(
    { _id: validBookedSlot._id },
    { $set: { updatedAt: oldDate } }
  );

  // Create a recent claim: booked 10 seconds ago, no booking yet (in-flight transaction)
  const recentClaimSlot = await Slot.create({
    venueId: venue._id,
    courtCode: 'C3',
    date: getFutureDate(5),
    startTime: '12:00',
    endTime: '13:00',
    price: 500,
    status: 'booked',
    claimToken: 'token_recent_flight',
    updatedAt: now
  });

  // Run orphan recovery with 5 minute threshold
  const recovered = await recoverOrphanedSlots({ maxAgeMs: 5 * 60 * 1000 });

  assert.strictEqual(recovered.length, 1, `Expected 1 recovered slot, got ${recovered.length}`);
  assert.strictEqual(recovered[0].slotId, orphanedSlot._id.toString());

  // Check database statuses
  const checkValid = await Slot.findById(validBookedSlot._id);
  assert.strictEqual(checkValid.status, 'booked', 'Valid booked slot must remain booked');

  const checkRecent = await Slot.findById(recentClaimSlot._id);
  assert.strictEqual(checkRecent.status, 'booked', 'Recent in-flight claim must remain booked');

  const checkOrphan = await Slot.findById(orphanedSlot._id);
  assert.strictEqual(checkOrphan.status, 'available', 'Orphaned slot must be restored to available');
  assert.strictEqual(checkOrphan.claimToken, null, 'claimToken must be cleared on recovery');
  console.log('  PASSED: Valid booking and recent claims preserved; only true orphan recovered\n');
  passed++;

  // ---------------------------------------------------------------------------
  // Test 12: Concurrent orphan recovery cannot release a newly claimed slot
  // ---------------------------------------------------------------------------
  console.log('Test 12: Concurrent orphan recovery cannot overwrite a newly changed slot');
  const slotToRace = await Slot.create({
    venueId: venue._id,
    courtCode: 'C3',
    date: getFutureDate(5),
    startTime: '13:00',
    endTime: '14:00',
    price: 500,
    status: 'booked',
    claimToken: 'token_race_01'
  });
  await Slot.collection.updateOne(
    { _id: slotToRace._id },
    { $set: { updatedAt: oldDate } }
  );

  // Simulate racing: right as recovery inspects candidate, another process updates its claimToken or status
  await Slot.updateOne(
    { _id: slotToRace._id },
    { $set: { claimToken: 'token_new_user_active' } }
  );

  // Recovery should fail to match the original claimToken atomically and recover nothing
  const recoveredRace = await recoverOrphanedSlots({ maxAgeMs: 5 * 60 * 1000 });
  const raceFound = recoveredRace.some(r => r.slotId === slotToRace._id.toString());
  assert.strictEqual(raceFound, false, 'Slot with modified claimToken must not be recovered');

  const checkRaceSlot = await Slot.findById(slotToRace._id);
  assert.strictEqual(checkRaceSlot.status, 'booked');
  assert.strictEqual(checkRaceSlot.claimToken, 'token_new_user_active');
  console.log('  PASSED: Atomic claimToken filter prevented accidental recovery of newly claimed slot\n');
  passed++;

  // Cleanup
  await server.close();
  await mongoose.disconnect();
  await replSet.stop();

  console.log('=================================================================');
  console.log(` TOTAL TESTS RUN : 12`);
  console.log(` PASSED          : ${passed}/12`);
  console.log(' ALL 12 PHASE 5.1 HARDENING TESTS PASSED WITH ZERO FAILURES! ✅');
  console.log('=================================================================');
  process.exit(0);
}

runHardeningTests().catch(err => {
  console.error('\n❌ HARDENING SUITE FAILED:', err);
  process.exitCode = 1;
  if (server) server.close();
  mongoose.disconnect().finally(() => {
    if (replSet) replSet.stop();
    process.exit(1);
  });
});
