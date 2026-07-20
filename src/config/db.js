const mongoose = require('mongoose');
const dns = require('dns');
const User = require('../models/User'); // Import User model for seeding
const generatePlayNowId = require('../utils/generatePlayNowId'); // Import ID generator

// Force Google DNS to resolve MongoDB SRV records (fixes ECONNREFUSED issues)
dns.setServers(['8.8.8.8', '8.8.4.4']);

let resolveDbReady;
const dbReadyPromise = new Promise((resolve) => {
  resolveDbReady = resolve;
});

const connectDB = async () => {
  try {
    let uri = process.env.MONGO_URI;
    if (uri && uri.includes('localhost')) {
      console.log('Using in-memory MongoDB for local development...');
      const { MongoMemoryServer } = require('mongodb-memory-server');
      const mongoServer = await MongoMemoryServer.create();
      uri = mongoServer.getUri();
    }
    const conn = await mongoose.connect(uri);
    console.log(`MongoDB Connected: ${conn.connection.host}`);

    // Migration to safely remove the obsolete key_1 unique index and invalid documents
    try {
      const countersCol = conn.connection.db.collection('counters');
      const indexes = await countersCol.indexes();
      const hasKeyIndex = indexes.some(idx => idx.name === 'key_1');
      if (hasKeyIndex) {
        console.log('Found obsolete key_1 index on counters collection. Dropping it...');
        await countersCol.dropIndex('key_1');
        console.log('Successfully dropped key_1 index.');
      }

      const validKeys = [
        'playnow_booking_id',
        'playnow_owner_id',
        'playnow_venue_id',
        'playnow_payment_id',
        'playnow_match_id',
        'playnow_user_id'
      ];

      const deleteResult = await countersCol.deleteMany({
        $or: [
          { _id: { $type: 'null' } },
          { _id: { $exists: false } },
          { _id: { $nin: validKeys } }
        ]
      });
      if (deleteResult.deletedCount > 0) {
        console.log(`Cleaned up ${deleteResult.deletedCount} invalid/obsolete counter documents.`);
      }
    } catch (migError) {
      if (migError.code === 26 || migError.codeName === 'NamespaceNotFound') {
        console.log('Counters collection does not exist yet. Skipping index dropping/cleanup migration.');
      } else {
        console.error('Migration failed during database connection setup:', migError);
      }
    } finally {
      resolveDbReady();
    }

    // Seed admin and owner if using memory server
    if (uri.includes('localhost') || uri.includes('127.0.0.1')) {
      console.log('Seeding initial admin and owner accounts...');
      
      const adminExists = await User.findOne({ phone: '+919999999999' });
      if (!adminExists) {
        await User.create({
          name: 'Super Admin',
          phone: '+919999999999',
          role: 'admin',
          playNowId: await generatePlayNowId('user')
        });
      }

      const ownerExists = await User.findOne({ phone: '+918888888888' });
      if (!ownerExists) {
        await User.create({
          name: 'Test Venue Owner',
          phone: '+918888888888',
          role: 'owner',
          playNowId: await generatePlayNowId('user'),
          ownerId: 'OWNER123'
        });
      }
      console.log('Seeding complete. Admin: 9999999999, Owner: 8888888888');
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    console.warn('⚠️ Server will continue running without database connection.');
    resolveDbReady(); // Resolve to avoid hanging callers if connection fails
  }
};

module.exports = { connectDB, dbReadyPromise };
