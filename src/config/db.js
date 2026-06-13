const mongoose = require('mongoose');
const dns = require('dns');
const User = require('../models/User'); // Import User model for seeding
const generatePlayNowId = require('../utils/generatePlayNowId'); // Import ID generator

// Force Google DNS to resolve MongoDB SRV records (fixes ECONNREFUSED issues)
dns.setServers(['8.8.8.8', '8.8.4.4']);

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

    // Seed admin and owner if using memory server
    if (uri.includes('localhost') || uri.includes('127.0.0.1')) {
      console.log('Seeding initial admin and owner accounts...');
      
      const adminExists = await User.findOne({ phone: '+919999999999' });
      if (!adminExists) {
        await User.create({
          name: 'Super Admin',
          phone: '+919999999999',
          role: 'admin',
          playNowId: await generatePlayNowId()
        });
      }

      const ownerExists = await User.findOne({ phone: '+918888888888' });
      if (!ownerExists) {
        await User.create({
          name: 'Test Venue Owner',
          phone: '+918888888888',
          role: 'owner',
          playNowId: await generatePlayNowId(),
          ownerId: 'OWNER123'
        });
      }
      console.log('Seeding complete. Admin: 9999999999, Owner: 8888888888');
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    console.warn('⚠️ Server will continue running without database connection.');
    // process.exit(1);
  }
};

module.exports = connectDB;
