const https = require('https');

const getAppUrl = () => (process.env.APP_URL || process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

const sendResendEmail = async ({ to, subject, html }) => {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
    console.warn('[EMAIL] Resend is not configured. Email was not sent.');
    return { success: false, skipped: true };
  }

  const payload = JSON.stringify({
    from: process.env.EMAIL_FROM,
    to,
    subject,
    html,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let data = {};
        try {
          data = body ? JSON.parse(body) : {};
        } catch (error) {
          data = { raw: body };
        }

        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ success: true, data });
          return;
        }

        reject(new Error(data.message || data.error || `Resend email failed with status ${res.statusCode}`));
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
};

const baseEmailShell = ({ eyebrow, title, body, buttonText, buttonUrl, footer }) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#0a0f1c;font-family:'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0f1c;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="480" cellpadding="0" cellspacing="0" style="background:#151b2b;border-radius:24px;border:1px solid rgba(255,255,255,0.1);overflow:hidden;">
          <tr>
            <td style="padding:40px 40px 20px;text-align:center;">
              <h1 style="margin:0;font-size:28px;font-weight:900;color:#ffffff;letter-spacing:-0.5px;">
  Play<span style="color:#39FF14;">Now</span>
              </h1>
              <p style="margin:8px 0 0;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:2px;font-weight:700;">
                ${eyebrow}
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 40px 30px;">
              <h2 style="margin:0 0 16px;font-size:20px;color:#ffffff;">${title}</h2>
              ${body}
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding:16px 0;">
                    <a href="${buttonUrl}"
                       style="display:inline-block;background:#39FF14;color:#000000;font-size:14px;font-weight:900;text-decoration:none;padding:14px 40px;border-radius:12px;letter-spacing:0.5px;">
                      ${buttonText}
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:16px 0 0;font-size:12px;color:#6b7280;line-height:1.5;">
                ${footer}
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 40px;border-top:1px solid rgba(255,255,255,0.05);text-align:center;">
              <p style="margin:0;font-size:10px;color:#4b5563;text-transform:uppercase;letter-spacing:1.5px;font-weight:700;">
                Secured by PlayNow. Do not share this email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

const sendPasswordResetEmail = async (email, resetToken) => {
  const resetUrl = `${getAppUrl()}/reset-password/${resetToken}`;
  const html = baseEmailShell({
    eyebrow: 'Password Reset',
    title: 'Reset your password',
    body: `
      <p style="margin:0 0 16px;font-size:15px;color:#d1d5db;line-height:1.6;">
        We received a request to reset your PlayNow password. Click the button below to set a new password.
      </p>
    `,
    buttonText: 'RESET PASSWORD',
    buttonUrl: resetUrl,
    footer: "This link expires in 15 minutes. If you didn't request a password reset, you can safely ignore this email.",
  });

  return sendResendEmail({
    to: email,
    subject: 'Reset your PlayNow password',
    html,
  });
};

const sendAccountLockedEmail = async (email, resetToken) => {
  const resetUrl = `${getAppUrl()}/reset-password/${resetToken}`;
  const html = baseEmailShell({
    eyebrow: 'Security Alert',
    title: 'Account temporarily locked',
    body: `
      <p style="margin:0 0 16px;font-size:15px;color:#d1d5db;line-height:1.6;">
        Your PlayNow account was temporarily locked due to repeated failed login attempts.
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#d1d5db;line-height:1.6;">
        If this wasn't you, reset your password using the button below.
      </p>
    `,
    buttonText: 'RESET PASSWORD',
    buttonUrl: resetUrl,
    footer: 'This password reset link expires in 15 minutes.',
  });

  return sendResendEmail({
    to: email,
    subject: 'Security Alert',
    html,
  });
};

const formatCurrency = (amount) => `Rs ${Number(amount || 0).toLocaleString('en-IN')}`;

const formatSlotDate = (slot) => {
  if (!slot?.date) return 'Date unavailable';
  return new Date(slot.date).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });
};

const formatTime = (time) => {
  if (!time) return '';
  const [hourValue, minute = '00'] = String(time).split(':');
  const hour = Number(hourValue);
  if (Number.isNaN(hour)) return time;
  const period = hour >= 12 ? 'PM' : 'AM';
  return `${hour % 12 || 12}:${minute} ${period}`;
};

const formatSlotRange = (slot) => (
  [formatTime(slot?.startTime), formatTime(slot?.endTime)].filter(Boolean).join(' - ')
);

const formatSlotsForEmail = (slots = []) => slots.map(slot => `
  <tr>
    <td style="padding:8px 0;color:#d1d5db;font-size:14px;">${formatSlotDate(slot)}</td>
    <td style="padding:8px 0;color:#d1d5db;font-size:14px;">${formatSlotRange(slot)}</td>
    <td style="padding:8px 0;color:#d1d5db;font-size:14px;">${slot.courtName || 'Court'}${slot.courtNumber ? ` #${slot.courtNumber}` : ''}</td>
  </tr>
`).join('');

const bookingDetailsTable = ({ booking, venue, slots, player }) => `
  <table width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0;background:#0a0f1c;border-radius:16px;padding:16px;border:1px solid rgba(255,255,255,0.08);">
    <tr><td style="padding:6px 0;color:#9ca3af;font-size:13px;">Booking ID</td><td align="right" style="padding:6px 0;color:#39FF14;font-size:13px;font-weight:800;">${booking.bookingCode || booking._id}</td></tr>
    <tr><td style="padding:6px 0;color:#9ca3af;font-size:13px;">Venue</td><td align="right" style="padding:6px 0;color:#ffffff;font-size:13px;font-weight:800;">${venue.name}</td></tr>
    <tr><td style="padding:6px 0;color:#9ca3af;font-size:13px;">Player</td><td align="right" style="padding:6px 0;color:#ffffff;font-size:13px;font-weight:800;">${player?.name || 'Player'}${player?.phone ? ` (${player.phone})` : ''}</td></tr>
    <tr><td style="padding:6px 0;color:#9ca3af;font-size:13px;">Total</td><td align="right" style="padding:6px 0;color:#ffffff;font-size:13px;font-weight:800;">${formatCurrency(booking.totalAmount)}</td></tr>
    <tr><td style="padding:6px 0;color:#9ca3af;font-size:13px;">Paid Online</td><td align="right" style="padding:6px 0;color:#39FF14;font-size:13px;font-weight:800;">${formatCurrency(booking.paidAmount)}</td></tr>
    <tr><td style="padding:6px 0;color:#9ca3af;font-size:13px;">Balance at Venue</td><td align="right" style="padding:6px 0;color:#facc15;font-size:13px;font-weight:800;">${formatCurrency(booking.remainingAmount)}</td></tr>
  </table>
  <table width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0;">
    <tr>
      <th align="left" style="padding-bottom:8px;color:#6b7280;font-size:11px;text-transform:uppercase;">Date</th>
      <th align="left" style="padding-bottom:8px;color:#6b7280;font-size:11px;text-transform:uppercase;">Time</th>
      <th align="left" style="padding-bottom:8px;color:#6b7280;font-size:11px;text-transform:uppercase;">Court</th>
    </tr>
    ${formatSlotsForEmail(slots)}
  </table>
`;

const sendBookingConfirmationEmail = async ({ to, booking, venue, slots, player }) => {
  if (!to) return { success: false, skipped: true };
  const html = baseEmailShell({
    eyebrow: 'Booking Confirmed',
    title: 'Your PlayNow booking is confirmed',
    body: `
      <p style="margin:0 0 16px;font-size:15px;color:#d1d5db;line-height:1.6;">
        Your slot has been booked successfully. Show this booking at the venue and pay any remaining balance before play.
      </p>
      ${bookingDetailsTable({ booking, venue, slots, player })}
    `,
    buttonText: 'VIEW MY BOOKINGS',
    buttonUrl: `${getAppUrl()}/dashboard`,
    footer: 'Need help? Contact PlayNow support at playnowsupport@gmail.com.',
  });

  return sendResendEmail({
    to,
    subject: `PlayNow booking confirmed - ${venue.name}`,
    html,
  });
};

const sendOwnerNewBookingEmail = async ({ to, booking, venue, slots, player }) => {
  if (!to) return { success: false, skipped: true };
  const html = baseEmailShell({
    eyebrow: 'New Booking',
    title: 'New booking received',
    body: `
      <p style="margin:0 0 16px;font-size:15px;color:#d1d5db;line-height:1.6;">
        A customer has booked a slot at your venue. Please prepare the court and collect any pending balance at the venue.
      </p>
      ${bookingDetailsTable({ booking, venue, slots, player })}
    `,
    buttonText: 'OPEN OWNER DASHBOARD',
    buttonUrl: `${getAppUrl()}/owner`,
    footer: 'This operational alert was generated automatically by PlayNow.',
  });

  return sendResendEmail({
    to,
    subject: `New booking received - ${venue.name}`,
    html,
  });
};

module.exports = {
  sendPasswordResetEmail,
  sendAccountLockedEmail,
  sendBookingConfirmationEmail,
  sendOwnerNewBookingEmail
};
