const User = require('../models/User');

const normalizeUsername = (username) => String(username || '').trim().toLowerCase();
const isValidUsername = (username) => /^[a-z0-9_.]{3,20}$/.test(username);

const userProfileFields = 'name username email phone playNowId role accountStatus bio preferredSports city area location ownerId notificationPreferences profilePhoto achievements statistics favouriteVenues';

const getMyProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select(userProfileFields).populate('favouriteVenues', 'name address');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateMyProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (req.body.username !== undefined) {
      const username = normalizeUsername(req.body.username);
      if (!isValidUsername(username)) {
        return res.status(400).json({ message: 'Username must be 3-20 characters and use lowercase letters, numbers, underscore, or dot only' });
      }

      const usernameOwner = await User.findOne({ username, _id: { $ne: user._id } });
      if (usernameOwner) {
        return res.status(400).json({ message: 'Username already taken' });
      }

      user.username = username;
    }

    if (req.body.name !== undefined) user.name = String(req.body.name).trim();
    if (req.body.profilePhoto !== undefined) user.profilePhoto = String(req.body.profilePhoto).trim();
    if (req.body.bio !== undefined) user.bio = String(req.body.bio).trim();
    if (req.body.city !== undefined) user.city = String(req.body.city).trim();
    if (req.body.area !== undefined) user.area = String(req.body.area).trim();
    if (req.body.location !== undefined) user.location = String(req.body.location).trim();
    if (req.body.preferredSports !== undefined) {
      user.preferredSports = Array.isArray(req.body.preferredSports)
        ? req.body.preferredSports.map((sport) => String(sport).trim()).filter(Boolean)
        : String(req.body.preferredSports).split(',').map((sport) => sport.trim()).filter(Boolean);
    }
    
    if (req.body.favouriteVenues !== undefined) {
      user.favouriteVenues = Array.isArray(req.body.favouriteVenues)
        ? req.body.favouriteVenues
        : [];
    }
    
    // Allow updating achievements and stats if admin or relevant logic allows
    if (req.user.role === 'admin') {
      if (req.body.achievements !== undefined) user.achievements = req.body.achievements;
      if (req.body.statistics !== undefined) user.statistics = req.body.statistics;
    }

    await user.save();

    const updatedUser = await User.findById(user._id).select(userProfileFields).populate('favouriteVenues', 'name address');
    res.json(updatedUser);
  } catch (error) {
    if (error?.code === 11000 && error?.keyPattern?.username) {
      return res.status(400).json({ message: 'Username already taken' });
    }
    res.status(400).json({ message: error.message });
  }
};

module.exports = {
  getMyProfile,
  updateMyProfile
};
