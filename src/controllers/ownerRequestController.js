const OwnerRequest = require('../models/OwnerRequest');
const User = require('../models/User');
const Venue = require('../models/Venue');

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

const promoteUserToOwner = async (user, ownerRequest) => {
  user.name = user.name || ownerRequest.ownerName;
  user.phone = user.phone || ownerRequest.phone;
  if (!user.email && ownerRequest.email) {
    user.email = ownerRequest.email;
  }
  if (user.role !== 'admin') {
    user.role = 'owner';
  }
  await user.save();
  return user;
};

const normalizeOptionalString = (value) => (
  typeof value === 'string' ? value.trim() : ''
);

const normalizeCoordinates = (coordinates = {}) => {
  const lat = coordinates.lat !== undefined && coordinates.lat !== '' ? Number(coordinates.lat) : undefined;
  const lng = coordinates.lng !== undefined && coordinates.lng !== '' ? Number(coordinates.lng) : undefined;

  return {
    ...(Number.isFinite(lat) ? { lat } : {}),
    ...(Number.isFinite(lng) ? { lng } : {})
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
  manager: normalizeContact(contacts.manager),
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

const buildVenuePayload = (request, ownerId) => ({
  name: request.venueName,
  ownerId,
  sportTypes: normalizeSportTypes(request.sportTypes).length ? normalizeSportTypes(request.sportTypes) : ['Badminton'],
  location: request.location || request.address,
  city: request.city,
  area: request.area,
  landmark: request.landmark,
  coordinates: request.coordinates,
  address: request.address,
  pricePerHour: Number(request.pricePerHour || 0),
  amenities: request.amenities || [],
  description: request.description || 'A premium sports venue for athletes.',
  images: request.venuePhotos?.length ? request.venuePhotos : ['default-venue.jpg'],
  contacts: request.contacts,
  courtGroups: request.courtGroups || [],
  isActive: true
});

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
      contacts,
      courtGroups,
      pricePerHour,
      amenities,
      description
    } = req.body;

    if (!ownerName || !phone || !venueName || !address) {
      return res.status(400).json({ message: 'ownerName, phone, venueName, and address are required' });
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
      coordinates: normalizeCoordinates(coordinates),
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

    if (ownerRequest.status !== 'pending') {
      return res.status(400).json({ message: `Owner request is already ${ownerRequest.status}` });
    }

    let owner = await findExistingOwnerApplicant(ownerRequest);

    if (owner) {
      owner = await promoteUserToOwner(owner, ownerRequest);
    } else {
      return res.status(404).json({ message: 'User not found for this owner request' });
    }

    const venue = await Venue.create(buildVenuePayload(ownerRequest, owner._id));

    ownerRequest.status = 'approved';
    ownerRequest.reviewedBy = req.user._id;
    ownerRequest.reviewedAt = new Date();
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
