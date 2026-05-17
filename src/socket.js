const { Server } = require('socket.io');

let io;

const initSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: "http://localhost:3000",
      methods: ["GET", "POST"]
    }
  });

  io.on('connection', (socket) => {
    console.log(`🔌 [SOCKET] New client connected: ${socket.id}`);

    // Health check for monitoring connection stability
    socket.on('ping_health', () => {
      socket.emit('pong_health', { timestamp: Date.now() });
    });

    // Join room based on userId (for private notifications like new bookings)
    socket.on('join_owner_room', (ownerId) => {
      if (!ownerId) return;
      socket.join(`owner_${ownerId}`);
      console.log(`👤 [ROOM] Owner ${ownerId} joined: owner_${ownerId}`);
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
