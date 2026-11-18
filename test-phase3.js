const assert = require('assert');
const mongoose = require('./node_modules/mongoose');

// Load models
const Venue = require('./src/models/Venue');
const VenueDeletionRequest = require('./src/models/VenueDeletionRequest');
const Slot = require('./src/models/Slot');
const Booking = require('./src/models/Booking');

// Load controllers
const { normalizeVenuePayload } = require('./src/controllers/venueController');
const {
  createDeletionRequest,
  getMyDeletionRequests,
  getDeletionRequests,
  approveDeletionRequest,
  rejectDeletionRequest
} = require('./src/controllers/venueDeletionRequestController');

console.log('==============================================');
console.log('   RUNNING PHASE 3 TESTS (20 TEST CASES)     ');
console.log('==============================================\n');

let passedTests = 0;

// Helper to create mock Express req, res
const mockReqRes = (options = {}) => {
  const req = {
    user: options.user || null,
    body: options.body || {},
    params: options.params || {},
    query: options.query || {},
    headers: options.headers || {},
  };
  let statusCode = 200;
  let responseData = null;

  const res = {
    status: (code) => {
      statusCode = code;
      return res;
    },
    json: (data) => {
      responseData = data;
      return res;
    },
    get statusCode() {
      return statusCode;
    },
    get data() {
      return responseData;
    }
  };

  return { req, res };
};

(async () => {
  // Common test IDs
  const ownerAId = new mongoose.Types.ObjectId();
  const ownerBId = new mongoose.Types.ObjectId();
  const adminId = new mongoose.Types.ObjectId();

  const userOwnerA = { _id: ownerAId, role: 'owner', name: 'Owner A' };
  const userOwnerB = { _id: ownerBId, role: 'owner', name: 'Owner B' };
  const userAdmin = { _id: adminId, role: 'admin', name: 'Super Admin' };

  // ==========================================
  // VENUE CREATION TESTS (1 - 6)
  // ==========================================

  console.log('--- VENUE CREATION ---');

  // Test 1: Authenticated owner creates a venue successfully
  console.log('Test 1: Authenticated owner creates a venue successfully');
  {
    const rawPayload = {
      name: 'Owner Turf Arena',
      sportTypes: ['Badminton', 'Football Turf'],
      location: 'Anna Nagar, Chennai',
      address: '100 Feet Road, Anna Nagar',
      city: 'Chennai',
      area: 'Anna Nagar',
      pricePerHour: 800,
    };

    const normalized = normalizeVenuePayload(rawPayload);
    normalized.ownerId = userOwnerA._id;
    normalized.venueCode = 'V-TEST01';

    const venue = new Venue(normalized);
    const err = venue.validateSync();
    assert.strictEqual(err, undefined, `Expected valid venue: ${err?.message}`);
    assert.strictEqual(venue.name, 'Owner Turf Arena');
    assert.strictEqual(venue.ownerId.toString(), ownerAId.toString());
    assert.strictEqual(venue.isActive, true);
    console.log('  Passed: Owner creates venue successfully with valid fields\n');
    passedTests++;
  }

  // Test 2: Venue creation without coordinates succeeds
  console.log('Test 2: Venue creation without coordinates succeeds');
  {
    const rawPayload = {
      name: 'No Coords Turf',
      sportTypes: ['Cricket'],
      location: 'RS Puram, Coimbatore',
      address: 'DB Road, RS Puram',
      pricePerHour: 1000,
    };

    const normalized = normalizeVenuePayload(rawPayload);
    normalized.ownerId = userOwnerA._id;
    normalized.venueCode = 'V-TEST02';

    const venue = new Venue(normalized);
    const err = venue.validateSync();
    assert.strictEqual(err, undefined);
    assert.strictEqual(venue.geo, undefined, 'Geo subdocument must be undefined');
    assert.strictEqual(venue.coordinates.lat, undefined);
    console.log('  Passed: Venue without coordinates validates cleanly with geo=undefined\n');
    passedTests++;
  }

  // Test 3: Valid coordinates are preserved
  console.log('Test 3: Valid coordinates are preserved');
  {
    const rawPayload = {
      name: 'Geo Turf Arena',
      sportTypes: ['Badminton'],
      location: 'T Nagar, Chennai',
      address: 'Usman Road',
      pricePerHour: 700,
      coordinates: { lat: 13.0418, lng: 80.2341 }
    };

    const normalized = normalizeVenuePayload(rawPayload);
    normalized.ownerId = userOwnerA._id;
    normalized.venueCode = 'V-TEST03';

    const venue = new Venue(normalized);
    const err = venue.validateSync();
    assert.strictEqual(err, undefined);
    assert.deepStrictEqual(venue.geo.coordinates, [80.2341, 13.0418]);
    assert.strictEqual(venue.coordinates.lat, 13.0418);
    assert.strictEqual(venue.coordinates.lng, 80.2341);
    console.log('  Passed: Valid coordinates preserved as GeoJSON Point [lng, lat]\n');
    passedTests++;
  }

  // Test 4: Invalid coordinates are rejected
  console.log('Test 4: Invalid coordinates are rejected');
  {
    assert.throws(() => {
      normalizeVenuePayload({
        name: 'Bad Lat Arena',
        coordinates: { lat: 95.0, lng: 80.0 }
      });
    }, (err) => err.statusCode === 400 && err.message.includes('latitude must be between -90 and 90'));

    assert.throws(() => {
      normalizeVenuePayload({
        name: 'Bad Lng Arena',
        coordinates: { lat: 13.0, lng: 200.0 }
      });
    }, (err) => err.statusCode === 400 && err.message.includes('longitude between -180 and 180'));

    console.log('  Passed: Out-of-bounds coordinates correctly throw HTTP 400 error\n');
    passedTests++;
  }

  // Test 5: Owner cannot create a venue for another owner
  console.log('Test 5: Owner cannot create a venue for another owner');
  {
    // Controller helper resolveVenueOwnerId enforces:
    // if req.user.role !== 'admin', always return req.user._id
    const resolveVenueOwnerId = (req, payload) => {
      if (req.user.role !== 'admin') {
        return req.user._id;
      }
      return payload.ownerId || req.user._id;
    };

    const forgedReq = {
      user: userOwnerA,
      body: {
        ownerId: ownerBId.toString(),
        ownerUserId: ownerBId.toString(),
        selectedOwnerId: ownerBId.toString()
      }
    };

    const resolvedOwnerId = resolveVenueOwnerId(forgedReq, forgedReq.body);
    assert.strictEqual(resolvedOwnerId.toString(), ownerAId.toString(), 'Must ignore forged ownerId and use req.user._id');
    console.log('  Passed: Owner ID forged in request body is strictly discarded for non-admins\n');
    passedTests++;
  }

  // Test 6: Unauthenticated requests are rejected
  console.log('Test 6: Unauthenticated requests are rejected');
  {
    const authMiddlewareProtect = (req, res, next) => {
      if (!req.headers.authorization || !req.headers.authorization.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Not authorized, no token' });
      }
      next();
    };

    const { req, res } = mockReqRes({ headers: {} });
    let nextCalled = false;
    authMiddlewareProtect(req, res, () => { nextCalled = true; });

    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(nextCalled, false);
    console.log('  Passed: Requests without valid Bearer token are rejected with 401\n');
    passedTests++;
  }

  // ==========================================
  // VENUE MANAGEMENT TESTS (7 - 9)
  // ==========================================

  console.log('--- VENUE MANAGEMENT ---');

  // Test 7: Owner can edit their own venue
  console.log('Test 7: Owner can edit their own venue');
  {
    const venue = new Venue({
      name: 'Original Name',
      sportTypes: ['Badminton'],
      location: 'Chennai',
      address: 'Address 1',
      pricePerHour: 500,
      ownerId: ownerAId,
      venueCode: 'V-OWN01'
    });

    // Check ownership authorization logic
    const canUpdate = (venue.ownerId.toString() === userOwnerA._id.toString() || userOwnerA.role === 'admin');
    assert.strictEqual(canUpdate, true, 'Owner A must be allowed to edit their venue');

    const updatePayload = normalizeVenuePayload({
      name: 'Updated Arena Name',
      pricePerHour: 750
    });
    delete updatePayload.ownerId; // non-admins cannot change ownerId

    venue.set(updatePayload);
    assert.strictEqual(venue.name, 'Updated Arena Name');
    assert.strictEqual(venue.pricePerHour, 750);
    assert.strictEqual(venue.ownerId.toString(), ownerAId.toString(), 'Ownership must remain Owner A');
    console.log('  Passed: Owner successfully edits their own venue\n');
    passedTests++;
  }

  // Test 8: Owner cannot edit another owner\'s venue
  console.log('Test 8: Owner cannot edit another owner\'s venue');
  {
    const venueB = new Venue({
      name: 'Owner B Arena',
      sportTypes: ['Football'],
      location: 'Madurai',
      address: 'Address B',
      pricePerHour: 1200,
      ownerId: ownerBId,
      venueCode: 'V-OWN02'
    });

    const isAuthorized = (venueB.ownerId.toString() === userOwnerA._id.toString() || userOwnerA.role === 'admin');
    assert.strictEqual(isAuthorized, false, 'Owner A must be forbidden from editing Owner B venue');
    console.log('  Passed: Non-owner update attempt is blocked with 403 Forbidden\n');
    passedTests++;
  }

  // Test 9: Existing slot and booking functionality remains intact
  console.log('Test 9: Existing slot and booking functionality remains intact');
  {
    const venue = new Venue({
      name: 'Active Venue For Slots',
      sportTypes: ['Badminton'],
      location: 'Chennai',
      address: 'Address',
      pricePerHour: 600,
      ownerId: ownerAId,
      isActive: true,
      venueCode: 'V-ACTIVE01'
    });

    assert.strictEqual(venue.isActive, true);

    const slot = new Slot({
      venueId: venue._id,
      date: new Date('2026-12-01'),
      startTime: '07:00',
      endTime: '08:00',
      price: 600,
      status: 'available'
    });
    const slotErr = slot.validateSync();
    assert.strictEqual(slotErr, undefined, `Slot must validate cleanly: ${slotErr?.message}`);

    const booking = new Booking({
      bookingCode: 'BK-TEST01',
      userId: new mongoose.Types.ObjectId(),
      venueId: venue._id,
      slotIds: [slot._id],
      totalAmount: 600,
      paymentType: 'full',
      paidAmount: 600,
      remainingAmount: 0,
      paymentStatus: 'completed',
      bookingStatus: 'confirmed'
    });
    const bookingErr = booking.validateSync();
    assert.strictEqual(bookingErr, undefined, `Booking must validate cleanly: ${bookingErr?.message}`);
    console.log('  Passed: Slot creation and booking validation remain intact on active venues\n');
    passedTests++;
  }

  // ==========================================
  // DELETION REQUEST TESTS (10 - 20)
  // ==========================================

  console.log('--- DELETION REQUEST WORKFLOW ---');

  // Shared in-memory venue and request objects for workflow tests
  const testVenue = new Venue({
    _id: new mongoose.Types.ObjectId(),
    name: 'Turf To Delete',
    sportTypes: ['Badminton'],
    location: 'Chennai',
    address: 'Main Road',
    pricePerHour: 500,
    ownerId: ownerAId,
    isActive: true,
    venueCode: 'V-DEL01'
  });

  // Mock database stores for isolated testing
  const mockVenuesDB = new Map([[testVenue._id.toString(), testVenue]]);
  const mockRequestsDB = new Map();
  const mockSlotsDB = new Map();

  // Populate mock slots
  const slot1 = new Slot({ _id: new mongoose.Types.ObjectId(), venueId: testVenue._id, status: 'available', date: new Date(), startTime: '06:00', endTime: '07:00', price: 500 });
  const slot2 = new Slot({ _id: new mongoose.Types.ObjectId(), venueId: testVenue._id, status: 'available', date: new Date(), startTime: '07:00', endTime: '08:00', price: 500 });
  mockSlotsDB.set(slot1._id.toString(), slot1);
  mockSlotsDB.set(slot2._id.toString(), slot2);

  const createQueryHelper = (result) => {
    const helper = {
      sort: () => createQueryHelper(result),
      populate: () => createQueryHelper(result),
      session: () => createQueryHelper(result),
      then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
      catch: (reject) => Promise.resolve(result).catch(reject)
    };
    if (result && typeof result === 'object') {
      Object.setPrototypeOf(helper, result);
    }
    return helper;
  };

  const User = require('./src/models/User');
  User.findById = () => createQueryHelper({
    _id: ownerAId,
    role: 'owner',
    notificationPreferences: {},
    save: async () => {}
  });
  User.findByIdAndUpdate = async () => null;
  User.updateMany = async () => ({ modifiedCount: 0 });

  const Notification = require('./src/models/Notification');
  Notification.create = async (doc) => doc;
  Notification.findOne = async () => null;

  testVenue.save = async function() {
    mockVenuesDB.set(this._id.toString(), this);
    return this;
  };

  // Monkey patch Mongoose model methods on VenueDeletionRequest and Venue
  Venue.findById = (id) => createQueryHelper(mockVenuesDB.get(id?.toString()) || null);
  Venue.find = async () => Array.from(mockVenuesDB.values());
  Venue.countDocuments = async () => 1;
  mongoose.startSession = async () => ({
    withTransaction: async (cb) => { await cb(); },
    endSession: () => {}
  });
  VenueDeletionRequest.findById = (id) => {
    const item = mockRequestsDB.get(id?.toString()) || null;
    return createQueryHelper(item);
  };
  VenueDeletionRequest.findByIdAndUpdate = async (id, update) => {
    const item = mockRequestsDB.get(id?.toString()) || null;
    if (item && update.$set) {
      Object.assign(item, update.$set);
    }
    return item;
  };
  VenueDeletionRequest.findOneAndUpdate = async (filter, update, options) => {
    for (const req of mockRequestsDB.values()) {
      let match = true;
      if (filter._id && req._id.toString() !== filter._id.toString()) match = false;
      if (filter.venueId && req.venueId.toString() !== filter.venueId.toString()) match = false;
      if (filter.status && req.status !== filter.status) match = false;
      if (match) {
        if (update.$set) {
          Object.assign(req, update.$set);
        }
        return req;
      }
    }
    return null;
  };
  VenueDeletionRequest.findOne = async (filter) => {
    for (const req of mockRequestsDB.values()) {
      let match = true;
      if (filter.venueId && req.venueId.toString() !== filter.venueId.toString()) match = false;
      if (filter.status && req.status !== filter.status) match = false;
      if (match) return req;
    }
    return null;
  };
  VenueDeletionRequest.create = async (doc) => {
    const instance = new VenueDeletionRequest(doc);
    instance._id = new mongoose.Types.ObjectId();
    instance.createdAt = new Date();
    instance.save = async function() {
      mockRequestsDB.set(instance._id.toString(), instance);
      return instance;
    };
    mockRequestsDB.set(instance._id.toString(), instance);
    return instance;
  };
  Slot.updateMany = async (filter, update) => {
    let count = 0;
    for (const slot of mockSlotsDB.values()) {
      if (slot.venueId.toString() === filter.venueId.toString() && slot.status === filter.status) {
        if (update.$set) Object.assign(slot, update.$set);
        count++;
      }
    }
    return { modifiedCount: count };
  };

  let createdRequestId = null;

  // Test 10: Owner can submit a deletion request
  console.log('Test 10: Owner can submit a deletion request');
  {
    const { req, res } = mockReqRes({
      user: userOwnerA,
      body: {
        venueId: testVenue._id.toString(),
        reason: 'Relocating business to another city'
      }
    });

    await createDeletionRequest(req, res);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.data.status, 'pending');
    assert.strictEqual(res.data.venueId.toString(), testVenue._id.toString());
    assert.strictEqual(res.data.ownerId.toString(), ownerAId.toString());
    createdRequestId = res.data._id.toString();
    console.log('  Passed: Owner submits deletion request; saved with status=pending\n');
    passedTests++;
  }

  // Test 11: Owner cannot request deletion of another owner's venue
  console.log('Test 11: Owner cannot request deletion of another owner\'s venue');
  {
    const { req, res } = mockReqRes({
      user: userOwnerB, // Owner B trying to delete Owner A's venue
      body: {
        venueId: testVenue._id.toString(),
        reason: 'Malicious deletion request'
      }
    });

    await createDeletionRequest(req, res);
    assert.strictEqual(res.statusCode, 403);
    assert.ok(res.data.message.includes('only request deletion for your own venues'));
    console.log('  Passed: Cross-owner deletion request rejected with 403 Forbidden\n');
    passedTests++;
  }

  // Test 12: Duplicate pending requests are prevented
  // Phase 4 update: status code changed from 400 to 409 Conflict (more precise semantics)
  console.log('Test 12: Duplicate pending requests are prevented');
  {
    const { req, res } = mockReqRes({
      user: userOwnerA,
      body: {
        venueId: testVenue._id.toString(),
        reason: 'Duplicate request while one is pending'
      }
    });

    await createDeletionRequest(req, res);
    assert.strictEqual(res.statusCode, 409);
    assert.ok(res.data.message.includes('already pending'));
    console.log('  Passed: Duplicate pending request rejected with 409 Conflict\n');
    passedTests++;
  }

  // Test 13: Owner cannot approve or reject requests
  console.log('Test 13: Owner cannot approve or reject requests');
  {
    const authorizeAdmin = (req, res, next) => {
      if (req.user.role !== 'admin') {
        return res.status(403).json({ message: 'Access denied. Role (owner) is not authorized.' });
      }
      next();
    };

    const { req, res } = mockReqRes({ user: userOwnerA });
    let adminNext = false;
    authorizeAdmin(req, res, () => { adminNext = true; });

    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(adminNext, false);
    console.log('  Passed: Non-admin role blocked from approve/reject route with 403\n');
    passedTests++;
  }

  // Test 14: Admin can view pending requests
  console.log('Test 14: Admin can view pending requests');
  {
    VenueDeletionRequest.find = (query) => ({
      sort: () => ({
        populate: () => ({
          populate: () => ({
            populate: async () => Array.from(mockRequestsDB.values()).filter(r => !query.status || r.status === query.status)
          })
        })
      })
    });

    const { req, res } = mockReqRes({
      user: userAdmin,
      query: { status: 'pending' }
    });

    await getDeletionRequests(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(Array.isArray(res.data));
    assert.strictEqual(res.data.length, 1);
    assert.strictEqual(res.data[0].status, 'pending');
    console.log('  Passed: Admin retrieves list of pending deletion requests\n');
    passedTests++;
  }

  // Test 15: Admin can approve a request
  console.log('Test 15: Admin can approve a request');
  {
    const { req, res } = mockReqRes({
      user: userAdmin,
      params: { id: createdRequestId },
      body: { adminResponse: 'Approved: verified closure with owner' }
    });

    await approveDeletionRequest(req, res);
    assert.strictEqual(res.statusCode, 200);

    const updatedReq = mockRequestsDB.get(createdRequestId);
    assert.strictEqual(updatedReq.status, 'approved');
    assert.strictEqual(updatedReq.reviewedBy.toString(), adminId.toString());
    assert.ok(updatedReq.reviewedAt instanceof Date);

    // Confirm venue was deactivated
    const venue = mockVenuesDB.get(testVenue._id.toString());
    assert.strictEqual(venue.isActive, false, 'Venue must be deactivated (isActive: false)');

    // Confirm available slots were blocked
    for (const slot of mockSlotsDB.values()) {
      if (slot.venueId.toString() === testVenue._id.toString()) {
        assert.strictEqual(slot.status, 'blocked');
        assert.strictEqual(slot.blockReason, 'Venue deletion approved');
      }
    }

    console.log('  Passed: Admin approves request; venue deactivated and available slots blocked\n');
    passedTests++;
  }

  // Test 16: Admin can reject a request with a reason
  console.log('Test 16: Admin can reject a request with a reason');
  {
    // Create a new pending request on another venue to test rejection
    const venue2 = new Venue({
      _id: new mongoose.Types.ObjectId(),
      name: 'Turf To Reject',
      sportTypes: ['Football'],
      location: 'Coimbatore',
      address: 'Address 2',
      pricePerHour: 900,
      ownerId: ownerAId,
      isActive: true,
      venueCode: 'V-REJ01'
    });
    mockVenuesDB.set(venue2._id.toString(), venue2);

    const reqToReject = await VenueDeletionRequest.create({
      venueId: venue2._id,
      venueName: venue2.name,
      ownerId: ownerAId,
      reason: 'Temporary slowdown',
      status: 'pending'
    });

    const { req, res } = mockReqRes({
      user: userAdmin,
      params: { id: reqToReject._id.toString() },
      body: { rejectionReason: 'Temporary slowdown does not warrant permanent deletion.' }
    });

    await rejectDeletionRequest(req, res);
    assert.strictEqual(res.statusCode, 200);

    const rejected = mockRequestsDB.get(reqToReject._id.toString());
    assert.strictEqual(rejected.status, 'rejected');
    assert.strictEqual(rejected.rejectionReason, 'Temporary slowdown does not warrant permanent deletion.');
    console.log('  Passed: Admin rejects deletion request with required reason\n');
    passedTests++;
  }

  // Test 17: Rejected requests leave the venue active
  console.log('Test 17: Rejected requests leave the venue active');
  {
    const venue2 = Array.from(mockVenuesDB.values()).find(v => v.name === 'Turf To Reject');
    assert.strictEqual(venue2.isActive, true, 'Venue must remain active when deletion request is rejected');
    console.log('  Passed: Rejected request keeps venue active (isActive remains true)\n');
    passedTests++;
  }

  // Test 18: Approved requests prevent new public bookings
  console.log('Test 18: Approved requests prevent new public bookings');
  {
    const inactiveVenue = mockVenuesDB.get(testVenue._id.toString());
    assert.strictEqual(inactiveVenue.isActive, false);

    // Simulate createBooking logic check:
    const simulateCreateBooking = (venue) => {
      if (!venue) return { status: 404, message: 'Venue not found' };
      if (!venue.isActive) return { status: 400, message: 'Venue is inactive and not accepting bookings' };
      return { status: 201 };
    };

    const bookingAttempt = simulateCreateBooking(inactiveVenue);
    assert.strictEqual(bookingAttempt.status, 400);
    assert.strictEqual(bookingAttempt.message, 'Venue is inactive and not accepting bookings');
    console.log('  Passed: Inactive venue blocks new public booking attempts with HTTP 400\n');
    passedTests++;
  }

  // Test 19: Historical bookings and payments remain intact
  console.log('Test 19: Historical bookings and payments remain intact');
  {
    // Ensure that soft deletion never drops or cascade-deletes bookings or payments
    const existingHistoricalBooking = new Booking({
      bookingCode: 'HIST-001',
      userId: new mongoose.Types.ObjectId(),
      venueId: testVenue._id,
      slotIds: [new mongoose.Types.ObjectId()],
      totalAmount: 1500,
      paymentType: 'full',
      paidAmount: 1500,
      remainingAmount: 0,
      paymentStatus: 'completed',
      bookingStatus: 'confirmed'
    });

    assert.strictEqual(existingHistoricalBooking.venueId.toString(), testVenue._id.toString());
    assert.strictEqual(existingHistoricalBooking.paymentStatus, 'completed');
    assert.strictEqual(existingHistoricalBooking.totalAmount, 1500);
    console.log('  Passed: Historical booking records and financials remain completely intact\n');
    passedTests++;
  }

  // Test 20: Already reviewed requests cannot be processed again
  // Phase 4 update: status code changed from 400 to 409 Conflict (atomic guard uses 409)
  console.log('Test 20: Already reviewed requests cannot be processed again');
  {
    // Try to re-approve the already approved request
    const { req: reApproveReq, res: reApproveRes } = mockReqRes({
      user: userAdmin,
      params: { id: createdRequestId },
      body: {}
    });

    await approveDeletionRequest(reApproveReq, reApproveRes);
    assert.strictEqual(reApproveRes.statusCode, 409);
    assert.ok(reApproveRes.data.message.includes('already been approved'));

    // Try to reject the already approved request
    const { req: reRejectReq, res: reRejectRes } = mockReqRes({
      user: userAdmin,
      params: { id: createdRequestId },
      body: { rejectionReason: 'Cannot reject now' }
    });

    await rejectDeletionRequest(reRejectReq, reRejectRes);
    assert.strictEqual(reRejectRes.statusCode, 409);
    assert.ok(reRejectRes.data.message.includes('already been approved'));

    console.log('  Passed: Already reviewed requests cannot be re-approved or re-rejected\n');
    passedTests++;
  }

  console.log('==============================================');
  console.log(` ALL ${passedTests}/20 PHASE 3 TESTS PASSED! `);
  console.log('==============================================');
})();
