const express = require('express');
const router = express.Router();
const RecurringBlockRule = require('../models/RecurringBlockRule');
const Venue = require('../models/Venue');
const { protect } = require('../middleware/authMiddleware');
const { authorizeRoles } = require('../middleware/roleMiddleware');

const canManageVenue = async (req, venueId) => {
  const venue = await Venue.findById(venueId).select('ownerId managerIds');
  if (!venue) return { allowed: false, status: 404, message: 'Venue not found' };
  const isManager = req.user.role === 'manager'
    && (venue.managerIds || []).some((managerId) => managerId.toString() === req.user._id.toString());
  if (req.user.role === 'admin' || venue.ownerId.toString() === req.user._id.toString() || isManager) {
    return { allowed: true, venue };
  }
  return { allowed: false, status: 403, message: 'Not authorized for this venue' };
};

router.route('/')
  .get(protect, authorizeRoles('owner', 'manager', 'admin'), async (req, res) => {
    try {
      const query = {};

      if (req.query.venueId) {
        query.venueId = req.query.venueId;
      }

      if (req.user.role !== 'admin') {
        const venueQuery = req.user.role === 'manager'
          ? { managerIds: req.user._id }
          : { ownerId: req.user._id };
        const venues = await Venue.find(venueQuery).select('_id');
        query.venueId = { $in: venues.map((venue) => venue._id) };
      }

      const rules = await RecurringBlockRule.find(query)
        .sort({ createdAt: -1 })
        .populate('venueId', 'name location city area');

      res.json(rules);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  })
  .post(protect, authorizeRoles('owner', 'manager', 'admin'), async (req, res) => {
    try {
      const access = await canManageVenue(req, req.body.venueId);
      if (!access.allowed) {
        return res.status(access.status).json({ message: access.message });
      }

      const rule = await RecurringBlockRule.create({
        venueId: req.body.venueId,
        courtCode: req.body.courtCode || '',
        daysOfWeek: Array.isArray(req.body.daysOfWeek) ? req.body.daysOfWeek.map(Number) : [],
        startTime: req.body.startTime,
        endTime: req.body.endTime,
        startDate: req.body.startDate,
        endDate: req.body.endDate || undefined,
        reason: req.body.reason,
        isActive: req.body.isActive !== false,
        createdBy: req.user._id
      });

      res.status(201).json({ rule, applySummary: { modifiedSlots: 0 } });
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  });

router.route('/:id')
  .put(protect, authorizeRoles('owner', 'manager', 'admin'), async (req, res) => {
    try {
      const rule = await RecurringBlockRule.findById(req.params.id);
      if (!rule) {
        return res.status(404).json({ message: 'Recurring block rule not found' });
      }

      const access = await canManageVenue(req, rule.venueId);
      if (!access.allowed) {
        return res.status(access.status).json({ message: access.message });
      }

      Object.assign(rule, {
        venueId: req.body.venueId || rule.venueId,
        courtCode: req.body.courtCode ?? rule.courtCode,
        daysOfWeek: Array.isArray(req.body.daysOfWeek) ? req.body.daysOfWeek.map(Number) : rule.daysOfWeek,
        startTime: req.body.startTime || rule.startTime,
        endTime: req.body.endTime || rule.endTime,
        startDate: req.body.startDate || rule.startDate,
        endDate: req.body.endDate || undefined,
        reason: req.body.reason || rule.reason,
        isActive: req.body.isActive !== false
      });

      await rule.save();
      res.json({ rule, applySummary: { modifiedSlots: 0 } });
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  })
  .delete(protect, authorizeRoles('owner', 'manager', 'admin'), async (req, res) => {
    try {
      const rule = await RecurringBlockRule.findById(req.params.id);
      if (!rule) {
        return res.status(404).json({ message: 'Recurring block rule not found' });
      }

      const access = await canManageVenue(req, rule.venueId);
      if (!access.allowed) {
        return res.status(access.status).json({ message: access.message });
      }

      await rule.deleteOne();
      res.json({ message: 'Recurring block rule removed' });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

module.exports = router;
