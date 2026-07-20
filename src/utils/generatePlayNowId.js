const Counter = require('../models/Counter');

// Entity Configuration
const ENTITY_CONFIG = {
  booking: { key: 'playnow_booking_id', prefix: 'PNBN' },
  owner: { key: 'playnow_owner_id', prefix: 'PNOWN' },
  venue: { key: 'playnow_venue_id', prefix: 'PNVEN' },
  payment: { key: 'playnow_payment_id', prefix: 'PNPAY' },
  match: { key: 'playnow_match_id', prefix: 'PNMAT' },
  user: { key: 'playnow_user_id', prefix: 'PNUSR' }
};

const formatId = (prefix, sequence) => `${prefix}${String(sequence).padStart(6, '0')}`;

const generatePlayNowId = async (entityType) => {
  if (!entityType) {
    throw new Error('entityType parameter is required for generatePlayNowId');
  }

  const config = ENTITY_CONFIG[entityType];
  if (!config) {
    throw new Error(`Invalid entity type for ID generation: ${entityType}`);
  }

  const counter = await Counter.findOneAndUpdate(
    { _id: config.key },
    { $inc: { seq: 1 } },
    {
      new: true,
      upsert: true
    }
  );

  return formatId(config.prefix, counter.seq);
};

module.exports = generatePlayNowId;
