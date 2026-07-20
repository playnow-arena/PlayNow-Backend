const Venue = require('../models/Venue');
const User = require('../models/User');
const generatePlayNowId = require('../utils/generatePlayNowId');
const syncOwnerRole = require('../utils/syncOwnerRole');

const toList = (value) => (Array.isArray(value) ? value : String(value || '').split(','))
  .map((item) => item.trim())
  .filter(Boolean);

const uniqueList = (items = []) => (
  items.reduce((values, item) => (
    values.some((value) => value.toLowerCase() === item.toLowerCase()) ? values : [...values, item]
  ), [])
);

const escapeRegex = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const toValidNumber = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

const normalizeVenuePayload = (body = {}) => {
  const payload = { ...body };

  payload.sportTypes = uniqueList(toList(payload.sportTypes));
  payload.amenities = uniqueList(toList(payload.amenities));

  if (!payload.location) {
    payload.location = [payload.area, payload.city, payload.address].filter(Boolean).join(', ');
  }

  if (Array.isArray(payload.courtGroups)) {
    payload.courtGroups = payload.courtGroups.map((group) => ({
      ...group,
      sports: uniqueList(toList(group.sports))
    }));
  }

  return payload;
};

const normalizeOwnerPhone = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  const mobileDigits = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
  return /^[6-9]\d{9}$/.test(mobileDigits) ? `+91${mobileDigits}` : '';
};

const stripOwnerSelectionFields = (payload) => {
  delete payload.ownerUserId;
  delete payload.selectedOwnerId;
  delete payload.ownerPhone;
  delete payload.ownerEmail;
};

const findOwnerUser = async (payload = {}) => {
  const ownerUserId = String(payload.ownerUserId || payload.selectedOwnerId || payload.ownerId || '').trim();
  const ownerEmail = String(payload.ownerEmail || '').trim().toLowerCase();
  const ownerPhone = String(payload.ownerPhone || '').trim();
  const normalizedPhone = normalizeOwnerPhone(ownerPhone);

  if (ownerUserId && /^[a-f\d]{24}$/i.test(ownerUserId)) {
    const user = await User.findById(ownerUserId);
    if (user) return user;
  }

  const clauses = [];
  if (ownerEmail) clauses.push({ email: ownerEmail });
  if (normalizedPhone) {
    const phoneDigits = normalizedPhone.slice(3);
    clauses.push({ phone: { $in: uniqueList([normalizedPhone, phoneDigits, ownerPhone]) } });
  }

  return clauses.length > 0 ? User.findOne({ $or: clauses }) : null;
};

const resolveVenueOwnerId = async (req, payload = {}, existingVenue = null) => {
  if (req.user.role !== 'admin') {
    return req.user._id;
  }

  const hasOwnerSelection = Boolean(
    payload.ownerUserId
    || payload.selectedOwnerId
    || payload.ownerPhone
    || payload.ownerEmail
    || payload.ownerId
  );

  if (!hasOwnerSelection && existingVenue?.ownerId) {
    return existingVenue.ownerId;
  }

  if (!hasOwnerSelection) {
    const error = new Error('Select an existing PlayNow user as venue owner');
    error.statusCode = 400;
    throw error;
  }

  const ownerUser = await findOwnerUser(payload);
  if (!ownerUser) {
    const error = new Error('Selected owner user not found');
    error.statusCode = 404;
    throw error;
  }

  // DO NOT promote here — role is synced AFTER the venue is persisted
  return ownerUser._id;
};

// @desc    Get venues near a location
// @route   GET /api/venues/nearby
// @access  Public
const getNearbyVenues = async (req, res) => {
  try {
    const { lat, lng, maxDistanceKm } = req.query;
    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);
    const maxDistance = parseFloat(maxDistanceKm) || 20; // Default 20km

    if (isNaN(latitude) || isNaN(longitude)) {
      return res.status(400).json({ message: 'Valid latitude and longitude are required' });
    }

    const venues = await Venue.find({
      geo: {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: [longitude, latitude]
          },
          $maxDistance: maxDistance * 1000 // Convert km to meters
        }
      },
      isActive: true
    }).populate('ownerId', 'name playNowId');

    res.json(venues);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all venues (with filters)
// @route   GET /api/venues
// @access  Public
const getVenues = async (req, res) => {
  try {
    const {
      search,
      sport,
      area,
      location,
      minPrice,
      maxPrice,
      minRating
    } = req.query;
    const clauses = [];
    const areaFilter = area || location;
    const parsedMinPrice = toValidNumber(minPrice);
    const parsedMaxPrice = toValidNumber(maxPrice);
    const parsedMinRating = toValidNumber(minRating);

    if (search?.trim()) {
      const searchRegex = new RegExp(escapeRegex(search.trim()), 'i');
      clauses.push({
        $or: [
          { name: searchRegex },
          { area: searchRegex },
          { city: searchRegex },
          { location: searchRegex }
        ]
      });
    }

    if (sport?.trim()) {
      clauses.push({
        sportTypes: new RegExp(`^${escapeRegex(sport.trim())}$`, 'i')
      });
    }

    if (areaFilter?.trim()) {
      const areaRegex = new RegExp(escapeRegex(areaFilter.trim()), 'i');
      clauses.push({
        $or: [
          { area: areaRegex },
          { city: areaRegex },
          { location: areaRegex }
        ]
      });
    }

    const priceFilter = {};
    if (parsedMinPrice !== null) priceFilter.$gte = parsedMinPrice;
    if (parsedMaxPrice !== null) priceFilter.$lte = parsedMaxPrice;
    if (Object.keys(priceFilter).length > 0) {
      clauses.push({ pricePerHour: priceFilter });
    }

    if (parsedMinRating !== null) {
      clauses.push({ rating: { $gte: parsedMinRating } });
    }

    const query = {
      isActive: true,
      ...(clauses.length > 0 ? { $and: clauses } : {})
    };

    const venues = await Venue.find(query).populate('ownerId', 'name playNowId');
    res.json(venues);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get single venue
// @route   GET /api/venues/:id
// @access  Public
const getVenueById = async (req, res) => {
  try {
    const venue = await Venue.findById(req.params.id).populate('ownerId', 'name');
    if (!venue) {
      return res.status(404).json({ message: 'Venue not found' });
    }
    res.json(venue);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Create new venue
// @route   POST /api/venues
// @access  Private/Owner
const createVenue = async (req, res) => {
  try {
    const payload = normalizeVenuePayload(req.body);

    payload.ownerId = await resolveVenueOwnerId(req, payload);
    stripOwnerSelectionFields(payload);
    payload.venueCode = await generatePlayNowId('venue');

    const venue = await Venue.create(payload);

    // Venue exists — now safe to sync the owner's role
    await syncOwnerRole(venue.ownerId);

    res.status(201).json(venue);
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

// @desc    Update venue
// @route   PUT /api/venues/:id
// @access  Private/Owner
const updateVenue = async (req, res) => {
  try {
    const payload = normalizeVenuePayload(req.body);

    let venue = await Venue.findById(req.params.id);

    if (!venue) {
      return res.status(404).json({ message: 'Venue not found' });
    }

    // Make sure user is venue owner or admin
    if (venue.ownerId.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized to update this venue' });
    }

    // Capture old owner BEFORE the update for potential demotion
    const oldOwnerId = venue.ownerId;

    if (req.user.role === 'admin') {
      payload.ownerId = await resolveVenueOwnerId(req, payload, venue);
    } else {
      delete payload.ownerId;
    }
    stripOwnerSelectionFields(payload);

    venue = await Venue.findByIdAndUpdate(req.params.id, payload, {
      new: true,
      runValidators: true
    });

    // If ownership was transferred, sync both the old and new owner's roles
    const newOwnerId = venue.ownerId;
    if (oldOwnerId.toString() !== newOwnerId.toString()) {
      await syncOwnerRole(oldOwnerId); // may demote old owner if no remaining venues
      await syncOwnerRole(newOwnerId); // may promote new owner if this is their first venue
    }

    res.json(venue);
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

// @desc    Delete venue
// @route   DELETE /api/venues/:id
// @access  Private/Owner
const deleteVenue = async (req, res) => {
  try {
    const venue = await Venue.findById(req.params.id);

    if (!venue) {
      return res.status(404).json({ message: 'Venue not found' });
    }

    // Make sure user is venue owner or admin
    if (venue.ownerId.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized to delete this venue' });
    }

    // Capture old owner BEFORE deletion for potential demotion
    const oldOwnerId = venue.ownerId;

    await venue.deleteOne();

    // Sync role — demotes to player if this was the owner's last venue
    await syncOwnerRole(oldOwnerId);

    res.json({ message: 'Venue removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get venues owned by current user
// @route   GET /api/venues/my
// @access  Private/Owner
const getMyVenues = async (req, res) => {
  try {
    const query = req.user.role === 'admin' ? {} : { ownerId: req.user._id };

    const venues = await Venue.find(query);
    res.json(venues);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get featured venues with fallback
// @route   GET /api/venues/featured
// @access  Public
const getFeaturedVenues = async (req, res) => {
  try {
    const { lat, lng } = req.query;
    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);

    if (isNaN(latitude) || isNaN(longitude)) {
      const venues = await Venue.find({ isActive: true }).limit(6);
      return res.json(venues);
    }

    const fetchByDist = async (km) => Venue.find({
      geo: {
        $near: {
          $geometry: { type: 'Point', coordinates: [longitude, latitude] },
          $maxDistance: km * 1000
        }
      },
      isActive: true
    });

    let venues = await fetchByDist(5);
    
    const addUnique = (existing, newVenues) => {
      const ids = new Set(existing.map(v => v._id.toString()));
      return [...existing, ...newVenues.filter(v => !ids.has(v._id.toString()))];
    };

    if (venues.length < 6) {
      const more = await fetchByDist(10);
      venues = addUnique(venues, more);
    }
    if (venues.length < 6) {
      const more = await fetchByDist(20);
      venues = addUnique(venues, more);
    }
    if (venues.length < 6) {
      const all = await Venue.find({ isActive: true }).limit(10);
      venues = addUnique(venues, all);
    }
    
    res.json(venues.slice(0, 6));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getVenues,
  getNearbyVenues,
  getFeaturedVenues,
  getVenueById,
  getMyVenues,
  createVenue,
  updateVenue,
  deleteVenue
};
