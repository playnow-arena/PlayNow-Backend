const mongoose = require('mongoose');
const dns = require('dns');

// Force Google DNS to resolve MongoDB SRV records (fixes ECONNREFUSED issues)
dns.setServers(['8.8.8.8', '8.8.4.4']);

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI);
    console.log(`MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    console.warn('⚠️ Server will continue running without database connection.');
    // process.exit(1);
  }
};

module.exports = connectDB;
