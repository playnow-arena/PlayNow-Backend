const OwnerRequest = require('../models/OwnerRequest');
const User = require('../models/User');
const Venue = require('../models/Venue');
const generatePlayNowId = require('../utils/generatePlayNowId');
const syncOwnerRole = require('../utils/syncOwnerRole');

const normalizePhone = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  return String(phone || '').trim();
};

const normalizeList = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof value === 'string') {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }

  return [];
};

const sportNameMap = {
  badminton: 'Badminton',
  pickleball: 'Pickleball',
  cricket: 'Cricket',
  'cricket nets': 'Cricket',
  football: 'Football',
  'football turf': 'Football Turf',
  tennis: 'Tennis',
  basketball: 'Basketball',
  'table tennis': 'Table Tennis'
};

const normalizeSportTypes = (sports) => (
  [...new Set(normalizeList(sports)
    .map((sport) => sportNameMap[String(sport).trim().toLowerCase()] || String(sport).trim())
    .filter(Boolean))]
);

const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getPhoneLookupValues = (phone) => {
  const rawPhone = String(phone || '').trim();
  const digits = rawPhone.replace(/\D/g, '').slice(-10);
  const values = [rawPhone];

  if (digits) {
    values.push(digits, `+91${digits}`, `91${digits}`);
  }

  return [...new Set(values.filter(Boolean))];
};

const findExistingOwnerApplicant = async (ownerRequest) => {
  if (ownerRequest.submittedBy) {
    const submittedUser = await User.findById(ownerRequest.submittedBy);
    if (submittedUser) return submittedUser;
  }

  const email = normalizeOptionalString(ownerRequest.email).toLowerCase();
  if (email) {
    const emailMatch = await User.findOne({
      email: { $regex: `^${escapeRegex(email)}$`, $options: 'i' }
    });

    if (emailMatch) return emailMatch;
  }

  const phoneValues = getPhoneLookupValues(ownerRequest.phone);
  if (!phoneValues.length) return null;

  return User.findOne({ phone: { $in: phoneValues } });
};

// Updates the user's name if missing.
// Preserves existing _id, playNowId, phone, email, password hash, and profile.
// NEVER overwrites existing phone or email to prevent E11000 duplicate key errors.
// DOES NOT change the user's role — role is managed exclusively by syncOwnerRole.
const updateUserProfileFromRequest = async (user, ownerRequest) => {
  user.name = user.name || ownerRequest.ownerName;
  await user.save();
  return user;
};

const normalizeOptionalString = (value) => (
  typeof value === 'string' ? value.trim() : ''
);

const normalizeCoordinates = (coordinates = {}, fallbackLat, fallbackLng) => {
  const rawLat = coordinates?.lat ?? coordinates?.latitude ?? fallbackLat;
  const rawLng = coordinates?.lng ?? coordinates?.longitude ?? fallbackLng;
  const lat = rawLat !== undefined && rawLat !== '' ? Number(rawLat) : undefined;
  const lng = rawLng !== undefined && rawLng !== '' ? Number(rawLng) : undefined;

  return {
    ...(Number.isFinite(lat) && lat >= -90 && lat <= 90 ? { lat } : {}),
    ...(Number.isFinite(lng) && lng >= -180 && lng <= 180 ? { lng } : {})
  };
};

const normalizeContact = (contact = {}) => ({
  ...(normalizeOptionalString(contact.name) ? { name: normalizeOptionalString(contact.name) } : {}),
  ...(normalizeOptionalString(contact.phone) ? { phone: normalizePhone(contact.phone) } : {}),
  ...(normalizeOptionalString(contact.email) ? { email: normalizeOptionalString(contact.email).toLowerCase() } : {}),
  ...(normalizeOptionalString(contact.whatsapp) ? { whatsapp: normalizePhone(contact.whatsapp) } : {})
});

const normalizeContacts = (contacts = {}, fallback = {}) => ({
  owner: {
    ...normalizeContact(contacts.owner),
    ...(fallback.ownerName ? { name: fallback.ownerName } : {}),
    ...(fallback.phone ? { phone: fallback.phone } : {}),
    ...(fallback.email ? { email: fallback.email } : {})
  },
  incharge: normalizeContact(contacts.incharge)
});

const normalizeCourtGroups = (courtGroups) => {
  if (!Array.isArray(courtGroups)) return [];

  return courtGroups
    .map((group) => ({
      name: normalizeOptionalString(group.name),
      sports: normalizeSportTypes(group.sports),
      courtCount: Number(group.courtCount) || 1,
      pricePerHour: group.pricePerHour !== undefined && group.pricePerHour !== '' ? Number(group.pricePerHour) : undefined,
      courtType: normalizeOptionalString(group.courtType) || 'Standard',
      isActive: group.isActive !== false
    }))
    .filter((group) => group.name && group.sports.length > 0 && Number.isFinite(group.pricePerHour));
};

const buildVenuePayload = (request, ownerId) => {
  const lat = request.coordinates?.lat !== undefined && request.coordinates?.lat !== '' ? Number(request.coordinates.lat) : undefined;
  const lng = request.coordinates?.lng !== undefined && request.coordinates?.lng !== '' ? Number(request.coordinates.lng) : undefined;
  const hasValidCoordinates = Number.isFinite(lat) && lat >= -90 && lat <= 90 && Number.isFinite(lng) && lng >= -180 && lng <= 180;

  return {
    name: request.venueName,
    ownerId,
    sportTypes: normalizeSportTypes(request.sportTypes).length ? normalizeSportTypes(request.sportTypes) : ['Badminton'],
    location: request.location || request.address,
    city: request.city,
    area: request.area,
    landmark: request.landmark,
    ...(hasValidCoordinates ? {
      coordinates: { lat, lng },
      geo: {
        type: 'Point',
        coordinates: [lng, lat]
      }
    } : {}),
    address: request.address,
  pricePerHour: Number(request.pricePerHour || 0),
  amenities: request.amenities || [],
  description: request.description || 'A premium sports venue for athletes.',
  images: request.venuePhotos?.length ? request.venuePhotos : ['default-venue.jpg'],
  contacts: request.contacts,
  courtGroups: request.courtGroups || [],
  isActive: true
  };
};

// @desc    Submit owner onboarding request
// @route   POST /api/owner-requests
// @access  Private/Player
const createOwnerRequest = async (req, res) => {
  try {
    const {
      ownerName,
      phone,
      email,
      venueName,
      address,
      sportTypes,
      location,
      city,
      area,
      landmark,
      coordinates,
      latitude,
      longitude,
      contacts,
      courtGroups,
      pricePerHour,
      amenities,
      description
    } = req.body;

    if (!ownerName || !phone || !venueName || !address) {
      return res.status(400).json({ message: 'ownerName, phone, venueName, and address are required' });
    }

    const checkLat = coordinates?.lat ?? coordinates?.latitude ?? latitude;
    const checkLng = coordinates?.lng ?? coordinates?.longitude ?? longitude;

    if (checkLat !== undefined && checkLat !== '' && (isNaN(Number(checkLat)) || Number(checkLat) < -90 || Number(checkLat) > 90)) {
      return res.status(400).json({ message: 'Latitude must be a valid number between -90 and 90' });
    }

    if (checkLng !== undefined && checkLng !== '' && (isNaN(Number(checkLng)) || Number(checkLng) < -180 || Number(checkLng) > 180)) {
      return res.status(400).json({ message: 'Longitude must be a valid number between -180 and 180' });
    }

    const normalizedPhone = normalizePhone(phone);
    const normalizedEmail = email ? email.trim().toLowerCase() : undefined;
    const normalizedCourtGroups = normalizeCourtGroups(courtGroups);
    const fallbackSportTypes = normalizeSportTypes(sportTypes);

    const ownerRequest = await OwnerRequest.create({
      submittedBy: req.user?._id,
      ownerName: ownerName.trim(),
      phone: normalizedPhone,
      email: normalizedEmail,
      venueName: venueName.trim(),
      address: address.trim(),
      location: location ? location.trim() : undefined,
      city: city ? city.trim() : undefined,
      area: area ? area.trim() : undefined,
      landmark: landmark ? landmark.trim() : undefined,
      coordinates: normalizeCoordinates(coordinates, latitude, longitude),
      pricePerHour: pricePerHour !== undefined && pricePerHour !== '' ? Number(pricePerHour) : undefined,
      amenities: normalizeList(amenities),
      description: description ? description.trim() : undefined,
      contacts: normalizeContacts(contacts, {
        ownerName: ownerName.trim(),
        phone: normalizedPhone,
        email: normalizedEmail
      }),
      courtGroups: normalizedCourtGroups,
      sportTypes: normalizedCourtGroups.length
        ? [...new Set(normalizedCourtGroups.flatMap((group) => group.sports))]
        : fallbackSportTypes,
      status: 'pending'
    });

    res.status(201).json(ownerRequest);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    List owner requests
// @route   GET /api/owner-requests
// @access  Private/Admin
const getOwnerRequests = async (req, res) => {
  try {
    const { status } = req.query;
    const query = {};

    if (status) {
      query.status = status;
    }

    const requests = await OwnerRequest.find(query)
      .sort({ createdAt: -1 })
      .populate('reviewedBy', 'name phone playNowId')
      .populate('linkedUserId', 'name phone email role playNowId')
      .populate('linkedVenueId', 'name location ownerId');

    res.json(requests);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Approve owner request
// @route   PUT /api/owner-requests/:id/approve
// @access  Private/Admin
const approveOwnerRequest = async (req, res) => {
  try {
    const ownerRequest = await OwnerRequest.findById(req.params.id);

    if (!ownerRequest) {
      return res.status(404).json({ message: 'Owner request not found' });
    }

    if (ownerRequest.status === 'rejected') {
      return res.status(400).json({ message: 'Owner request is already rejected' });
    }

    let owner = await findExistingOwnerApplicant(ownerRequest);

    if (!owner) {
      return res.status(404).json({ message: 'User not found for this owner request' });
    }

    // Sync contact info only — role is NOT changed here, phone/email preserved
    owner = await updateUserProfileFromRequest(owner, ownerRequest);

    // Ensure venue exists and is linked (prevents duplicates on repeat approval)
    let venue = ownerRequest.linkedVenueId ? await Venue.findById(ownerRequest.linkedVenueId) : null;
    if (!venue) {
      venue = await Venue.findOne({ ownerId: owner._id, name: ownerRequest.venueName });
    }
    if (!venue) {
      venue = await Venue.create(buildVenuePayload(ownerRequest, owner._id));
    }

    // Synchronize role: venue exists, so syncOwnerRole promotes to 'owner'
    await syncOwnerRole(owner._id);

    // Assign ownerCode only after confirmed as owner
    const confirmedOwner = await User.findById(owner._id);
    if (confirmedOwner.role === 'owner' && !confirmedOwner.ownerCode) {
      confirmedOwner.ownerCode = await generatePlayNowId('owner');
      await confirmedOwner.save();
    }

    ownerRequest.status = 'approved';
    ownerRequest.reviewedBy = req.user._id;
    ownerRequest.reviewedAt = ownerRequest.reviewedAt || new Date();
    ownerRequest.linkedUserId = owner._id;
    ownerRequest.linkedVenueId = venue._id;
    ownerRequest.rejectionReason = undefined;

    await ownerRequest.save();

    const { createNotification } = require('./notificationController');
    await createNotification({
      userId: owner._id,
      title: 'Owner Request Approved',
      message: `Your partner request for ${venue.name} has been approved.`,
      type: 'system',
      link: '/owner',
      metadata: { ownerRequestId: ownerRequest._id, venueId: venue._id },
      dedupeKey: `owner-request:${ownerRequest._id}:approved`
    });

    const populatedRequest = await OwnerRequest.findById(ownerRequest._id)
      .populate('reviewedBy', 'name phone playNowId')
      .populate('linkedUserId', 'name phone email role playNowId')
      .populate('linkedVenueId', 'name location ownerId');

    res.json(populatedRequest);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Reject owner request
// @route   PUT /api/owner-requests/:id/reject
// @access  Private/Admin
const rejectOwnerRequest = async (req, res) => {
  try {
    const ownerRequest = await OwnerRequest.findById(req.params.id);

    if (!ownerRequest) {
      return res.status(404).json({ message: 'Owner request not found' });
    }

    if (ownerRequest.status !== 'pending') {
      return res.status(400).json({ message: `Owner request is already ${ownerRequest.status}` });
    }

    ownerRequest.status = 'rejected';
    ownerRequest.reviewedBy = req.user._id;
    ownerRequest.reviewedAt = new Date();
    ownerRequest.rejectionReason = req.body.reason || '';

    await ownerRequest.save();

    res.json(ownerRequest);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

module.exports = {
  createOwnerRequest,
  getOwnerRequests,
  approveOwnerRequest,
  rejectOwnerRequest
};
