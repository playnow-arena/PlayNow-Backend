require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./src/config/db');

const http = require('http');
const { initSocket } = require('./src/socket');

// Connect to Database
connectDB();

const app = express();
const server = http.createServer(app);

// Initialize Socket.IO
initSocket(server);

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth', require('./src/routes/authRoutes'));
app.use('/api/venues', require('./src/routes/venueRoutes'));
app.use('/api/slots', require('./src/routes/slotRoutes'));
app.use('/api/bookings', require('./src/routes/bookingRoutes'));
app.use('/api/matches', require('./src/routes/matchRoutes'));

app.get('/', (req, res) => {
  res.send('Play Now API is running...');
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`🚀 API Server running at: http://localhost:${PORT}`);
  console.log(`💻 Frontend Dev Server: http://localhost:3000`);
  console.log(`🔐 Admin Portal: http://localhost:3000/#/super-admin-portal-2026`);
});
