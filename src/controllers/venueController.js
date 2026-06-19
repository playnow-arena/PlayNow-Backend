const Venue = require('../models/Venue');

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
    req.body = normalizeVenuePayload(req.body);

    // Add user as ownerId
    req.body.ownerId = req.user._id;

    const venue = await Venue.create(req.body);
    res.status(201).json(venue);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Update venue
// @route   PUT /api/venues/:id
// @access  Private/Owner
const updateVenue = async (req, res) => {
  try {
    req.body = normalizeVenuePayload(req.body);

    let venue = await Venue.findById(req.params.id);

    if (!venue) {
      return res.status(404).json({ message: 'Venue not found' });
    }

    // Make sure user is venue owner or admin
    if (venue.ownerId.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized to update this venue' });
    }

    venue = await Venue.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true
    });

    res.json(venue);
  } catch (error) {
    res.status(400).json({ message: error.message });
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

    await venue.deleteOne();
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
    const query = req.user.role === 'admin'
      ? {}
      : req.user.role === 'manager'
        ? { managerIds: req.user._id }
        : { ownerId: req.user._id };

    const venues = await Venue.find(query);
    res.json(venues);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getVenues,
  getVenueById,
  getMyVenues,
  createVenue,
  updateVenue,
  deleteVenue
};
