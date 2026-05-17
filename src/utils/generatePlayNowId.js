const User = require('../models/User');

const generatePlayNowId = async () => {
  const year = new Date().getFullYear();
  let unique = false;
  let playNowId = '';

  while (!unique) {
    // Generate a random 4-digit number
    const randomNum = Math.floor(1000 + Math.random() * 9000);
    playNowId = `PN-${year}-${randomNum}`;

    // Check if ID already exists
    const existingUser = await User.findOne({ playNowId });
    if (!existingUser) {
      unique = true;
    }
  }

  return playNowId;
};

module.exports = generatePlayNowId;
