require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { connectDB } = require('./src/config/db');

const http = require('http');
const { initSocket } = require('./src/socket');

// Connect to Database
connectDB().then(() => {
  const { initAutoCleanup } = require('./src/cleanup');
  initAutoCleanup();
});

const app = express();
const server = http.createServer(app);

// Initialize Socket.IO
initSocket(server);

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes
app.use('/api/auth', require('./src/routes/authRoutes'));
app.use('/api/users', require('./src/routes/userRoutes'));
app.use('/api/venues', require('./src/routes/venueRoutes'));
app.use('/api/uploads', require('./src/routes/uploadRoutes'));
app.use('/api/slots', require('./src/routes/slotRoutes'));
app.use('/api/bookings', require('./src/routes/bookingRoutes'));
app.use('/api/payments', require('./src/routes/paymentRoutes'));
app.use('/api/matches', require('./src/routes/matchRoutes'));
app.use('/api/owner-requests', require('./src/routes/ownerRequestRoutes'));
app.use('/api/recurring-block-rules', require('./src/routes/recurringBlockRuleRoutes'));
app.use('/api/reviews', require('./src/routes/reviewRoutes'));
app.use('/api/notifications', require('./src/routes/notificationRoutes'));


app.get('/', (req, res) => {
  res.send('Play Now API is running...');
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`🚀 API Server running at: http://localhost:${PORT}`);
  console.log(`💻 Frontend Dev Server: http://localhost:3000`);
  console.log(`🔐 Admin Portal: http://localhost:3000/#/super-admin-portal-2026`);
});
