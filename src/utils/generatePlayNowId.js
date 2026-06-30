const Counter = require('../models/Counter');
const User = require('../models/User');

const USER_COUNTER_KEY = 'playnow_user_id';
const USER_ID_PREFIX = 'PNUSR';

const getCurrentMaxUserSequence = async () => {
  const latestUser = await User.findOne({
    playNowId: new RegExp(`^${USER_ID_PREFIX}\\d+$`)
  })
    .sort({ playNowId: -1 })
    .select('playNowId')
    .lean();

  if (!latestUser?.playNowId) return 0;
  return Number(latestUser.playNowId.replace(USER_ID_PREFIX, '')) || 0;
};

const formatUserId = (sequence) => `${USER_ID_PREFIX}${String(sequence).padStart(3, '0')}`;

const generatePlayNowId = async () => {
  const currentMax = await getCurrentMaxUserSequence();
  await Counter.updateOne(
    { _id: USER_COUNTER_KEY },
    { $max: { seq: currentMax } },
    { upsert: true }
  );

  const counter = await Counter.findOneAndUpdate(
    { _id: USER_COUNTER_KEY },
    { $inc: { seq: 1 } },
    {
      returnDocument: 'after'
    }
  );

  return formatUserId(counter.seq);
};

module.exports = generatePlayNowId;
