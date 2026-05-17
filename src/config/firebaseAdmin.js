const admin = require('firebase-admin');

// ============================================================
// Firebase Admin SDK — Initialised via environment variables
// No service account JSON file needed on disk.
//
// Required backend .env variables:
//   FIREBASE_PROJECT_ID   → Firebase Console → Project Settings → General
//   FIREBASE_CLIENT_EMAIL → Firebase Console → Project Settings →
//                           Service Accounts → Generate new private key
//   FIREBASE_PRIVATE_KEY  → Same JSON file (paste the entire private_key value)
//
// Steps to get the service account key:
//   1. Go to Firebase Console → https://console.firebase.google.com
//   2. Select project "playnow-53357"
//   3. Project Settings (gear icon) → Service Accounts tab
//   4. Click "Generate new private key" → download JSON
//   5. Copy projectId, clientEmail, privateKey from JSON → paste into backend/.env
// ============================================================

if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) {
  console.error('❌ [FIREBASE] Critical: Missing configuration environment variables.');
  console.warn('   Required: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY');
  console.warn('   Action: Check your backend/.env file.');
} else {
  try {
    // Only initialise once (nodemon hot-reload guard)
    if (!admin.apps.length) {
      const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
      
      if (!privateKey.includes('BEGIN PRIVATE KEY')) {
        throw new Error('Invalid FIREBASE_PRIVATE_KEY format in .env');
      }

      admin.initializeApp({
        credential: admin.credential.cert({
          projectId:   process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey:  privateKey,
        }),
      });
      console.log(`🔥 [FIREBASE] Admin SDK initialized for project: ${process.env.FIREBASE_PROJECT_ID}`);
    }
  } catch (error) {
    console.error('❌ [FIREBASE] Initialization Failed:', error.message);
  }
}

module.exports = admin;
