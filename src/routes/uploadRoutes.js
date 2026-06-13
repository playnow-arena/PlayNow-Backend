const express = require('express');
const fs = require('fs');
const path = require('path');
const { protect } = require('../middleware/authMiddleware');
const { authorizeRoles } = require('../middleware/roleMiddleware');

const router = express.Router();
const uploadDir = path.join(__dirname, '..', '..', 'uploads', 'venue-images');
const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const parseMultipartImage = (body, contentType) => {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) return null;

  const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
  const start = body.indexOf(boundary);
  if (start === -1) return null;

  const headerStart = start + boundary.length + 2;
  const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), headerStart);
  if (headerEnd === -1) return null;

  const headers = body.slice(headerStart, headerEnd).toString('utf8');
  if (!/name="image"/i.test(headers)) return null;

  const filenameMatch = headers.match(/filename="([^"]+)"/i);
  const typeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);
  const mimeType = typeMatch?.[1]?.trim() || '';
  const fileStart = headerEnd + 4;
  const fileEnd = body.indexOf(Buffer.from('\r\n--'), fileStart);

  if (!filenameMatch || fileEnd === -1) return null;

  return {
    originalName: path.basename(filenameMatch[1]),
    mimeType,
    buffer: body.slice(fileStart, fileEnd),
  };
};

router.post(
  '/venue-image',
  protect,
  authorizeRoles('owner', 'admin'),
  express.raw({ type: () => true, limit: '6mb' }),
  async (req, res) => {
    try {
      const file = parseMultipartImage(req.body, req.headers['content-type'] || '');

      if (!file || !file.buffer.length) {
        return res.status(400).json({ message: 'Please choose an image file to upload' });
      }

      if (!allowedTypes.has(file.mimeType)) {
        return res.status(400).json({ message: 'Only JPG, PNG, WEBP, or GIF images are allowed' });
      }

      await fs.promises.mkdir(uploadDir, { recursive: true });

      const ext = path.extname(file.originalName).toLowerCase() || '.jpg';
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`;
      const absolutePath = path.join(uploadDir, filename);

      await fs.promises.writeFile(absolutePath, file.buffer);

      res.status(201).json({
        url: `${req.protocol}://${req.get('host')}/uploads/venue-images/${filename}`,
        filename,
      });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }
);

module.exports = router;
