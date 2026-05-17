# Play Now Backend

This is the backend API for the Play Now sports booking application built with Node.js, Express, and MongoDB.

## Features
- JWT Authentication & Bcrypt Password Hashing
- User Roles (Player, Owner, Admin)
- Venue Management (Create, List, Filter)
- Slot Management (Batch Creation, Status Tracking, Manual Blocking)
- Booking System (Atomic Availability Check, Advance/Full Payments)
- Cancellation Policy Engine (4-hour rule, 10% penalty calculation, refunds)

## Tech Stack
- Node.js
- Express.js
- MongoDB & Mongoose
- JSON Web Tokens (JWT)
- bcryptjs

## Setup & Installation

1. Make sure you have Node.js and MongoDB installed and running.
2. Clone or navigate to the backend folder.
3. Install dependencies:
   ```bash
   npm install
   ```
4. Configure `.env`:
   Ensure you have a `.env` file in the root of the backend folder with the following:
   ```env
   PORT=5000
   MONGO_URI=mongodb://localhost:27017/playnow
   JWT_SECRET=supersecretplaynowkey
   ```
5. Start the development server:
   ```bash
   npm run dev
   ```
   The server will start on `http://localhost:3000`.

## API Endpoints

### Auth
- `POST /api/auth/signup` - Register a new user
- `POST /api/auth/login` - Login user & get token
- `GET /api/auth/me` - Get current user profile (Private)

### Venues
- `GET /api/venues` - List all venues (Supports queries: `sport`, `location`, `maxPrice`)
- `GET /api/venues/:id` - Get venue by ID
- `POST /api/venues` - Create venue (Owner only)
- `PUT /api/venues/:id` - Edit venue (Owner only)
- `DELETE /api/venues/:id` - Delete venue (Owner only)

### Slots
- `POST /api/slots` - Batch create slots for a venue (Owner only)
- `GET /api/slots/venue/:venueId` - Get slots for a venue
- `PUT /api/slots/:id/block` - Manually block a slot (Owner only)

### Bookings
- `POST /api/bookings` - Create a booking (Private)
- `GET /api/bookings/my` - Get user's bookings (Private)
- `GET /api/bookings/owner` - Get bookings for owner's venues (Owner only)
- `PUT /api/bookings/:id/cancel` - Cancel a booking (Private)

## Design Decisions
- **Double Booking Prevention**: Before creating a booking, the API verifies that all requested slots have the status `available`. If any slot is missing or unavailable, the entire transaction is rejected, preventing partial or double bookings.
- **Mock Payments**: Payment statuses are set to `completed` automatically as Razorpay integration is deferred for the MVP.
