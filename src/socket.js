const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const User = require('./models/User');

let io;

const initSocket = (server) => {
  const configuredOrigins = (process.env.FRONTEND_URL || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

  io = new Server(server, {
    cors: {
      origin: configuredOrigins.length > 0 ? configuredOrigins : true,
      methods: ["GET", "POST"]
    }
  });

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next();

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = await User.findById(decoded.id).select('_id role roles playNowId');
      next();
    } catch (error) {
      next(new Error('Invalid authentication token'));
    }
  });

  io.on('connection', (socket) => {
    if (socket.user) {
      socket.join(`user_${socket.user._id}`);
      if (socket.user.role === 'owner' || socket.user.roles?.includes('owner')) {
        socket.join(`owner_${socket.user._id}`);
        if (socket.user.playNowId) socket.join(`owner_${socket.user.playNowId}`);
      }
    }

    console.log(`🔌 [SOCKET] New client connected: ${socket.id}`);

    // Health check for monitoring connection stability
    socket.on('ping_health', () => {
      socket.emit('pong_health', { timestamp: Date.now() });
    });

    // Join room based on userId (for private notifications like new bookings)
    socket.on('join_owner_room', (ownerId) => {
      const allowedIds = [socket.user?._id?.toString(), socket.user?.playNowId].filter(Boolean);
      if (!ownerId || !allowedIds.includes(ownerId.toString())) return;
      socket.join(`owner_${ownerId}`);
      console.log(`👤 [ROOM] Owner ${ownerId} joined: owner_${ownerId}`);
    });

    // Join room based on user DB ID (for user-specific real-time notifications)
    socket.on('join_user_room', (userId) => {
      if (!userId || socket.user?._id?.toString() !== userId.toString()) return;
      socket.join(`user_${userId}`);
      console.log(`👤 [ROOM] User joined room: user_${userId}`);
    });

    // Join room based on venueId (for real-time slot updates on booking page)
    socket.on('join_venue_room', (venueId) => {
      if (!venueId) return;
      socket.join(`venue_${venueId}`);
      console.log(`🏟️ [ROOM] User joined venue room: venue_${venueId}`);
    });

    socket.on('error', (err) => {
      console.error(`❌ [SOCKET] Error for ${socket.id}:`, err.message);
    });

    socket.on('disconnect', (reason) => {
      console.log(`🔌 [SOCKET] Client disconnected: ${socket.id} (${reason})`);
    });
  });

  return io;
};

const getIO = () => {
  if (!io) {
    throw new Error('Socket.io not initialized!');
  }
  return io;
};

module.exports = { initSocket, getIO };
