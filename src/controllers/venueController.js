const Venue = require('../models/Venue');

// @desc    Get all venues (with filters)
// @route   GET /api/venues
// @access  Public
const getVenues = async (req, res) => {
  try {
    const { sport, location, maxPrice } = req.query;
    
    // Build query object
    let query = {};
    if (sport) query.sportTypes = { $in: [sport] };
    if (location) query.location = { $regex: location, $options: 'i' };
    if (maxPrice) query.pricePerHour = { $lte: Number(maxPrice) };

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
    const venues = await Venue.find({ ownerId: req.user._id });
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
