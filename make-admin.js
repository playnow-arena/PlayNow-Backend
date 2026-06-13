const mongoose = require('mongoose');
const dotenv = require('dotenv');
const crypto = require('crypto');

// Load env vars
dotenv.config();

const DB_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/playnow';

function generatePlayNowId() {
  return 'PN-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

async function run() {
  try {
    await mongoose.connect(DB_URI);
    console.log('✅ MongoDB Connected to:', DB_URI.replace(/\/\/.*@/, '//***@'));

    const targetPhone = process.argv[2];
    const targetRole  = process.argv[3] || 'admin'; // 'admin' or 'owner'
    const targetName  = process.argv[4] || (targetRole === 'admin' ? 'Admin User' : 'Venue Owner');

    if (!targetPhone) {
      console.log('\n❌ Error: Please provide a phone number.');
      console.log('Usage:   node make-admin.js <+91XXXXXXXXXX> <role> <name>');
      console.log('Example: node make-admin.js +919876543210 admin "Admin User"');
      console.log('Example: node make-admin.js +919876543210 owner "Venue Owner"');
      process.exit(1);
    }

    const db = mongoose.connection.db;
    const users = db.collection('users');

    // Check if user already exists
    const existing = await users.findOne({ phone: targetPhone });

    if (existing) {
      // User exists — just update the role
      if (existing.role === targetRole) {
        console.log(`\n✅ User with phone ${targetPhone} is ALREADY a "${targetRole}"!`);
        console.log(`   Name: ${existing.name}`);
        console.log(`   PlayNow ID: ${existing.playNowId}`);
      } else {
        await users.updateOne({ phone: targetPhone }, { $set: { role: targetRole } });
        console.log(`\n🎉 Success! Updated role of "${existing.name}" (${targetPhone}) to "${targetRole}".`);
      }
    } else {
      // User does NOT exist — create them fresh
      const playNowId = generatePlayNowId();
      await users.insertOne({
        name:         targetName,
        phone:        targetPhone,
        playNowId,
        profilePhoto: 'default.jpg',
        role:         targetRole,
        accountStatus: 'active',
        createdAt:    new Date(),
        updatedAt:    new Date(),
      });
      console.log(`\n🎉 Success! Created new ${targetRole} account:`);
      console.log(`   Name:       ${targetName}`);
      console.log(`   Phone:      ${targetPhone}`);
      console.log(`   PlayNow ID: ${playNowId}`);
      console.log(`   Role:       ${targetRole}`);
    }

    console.log('\n📋 All users in DB:');
    const allAdmins = await users.find({ role: { $in: ['admin', 'owner'] } }).toArray();
    allAdmins.forEach(u => {
      console.log(`   [${u.role.toUpperCase()}] ${u.name} — ${u.phone} — ${u.playNowId}`);
    });

    process.exit(0);
  } catch (err) {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
  }
}

run();
