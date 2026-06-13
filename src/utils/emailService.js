const nodemailer = require('nodemailer');

/**
 * Send a password reset email.
 *
 * Required .env variables:
 *   EMAIL_USER  – SMTP username (e.g. your-gmail@gmail.com)
 *   EMAIL_PASS  – SMTP password / app password
 *   EMAIL_FROM  – "From" address shown in inbox (defaults to EMAIL_USER)
 *   FRONTEND_URL – Base URL for the frontend (e.g. https://playnow.app)
 */

const createTransporter = () => {
  // If SMTP credentials are missing, return null (console fallback)
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn('[EMAIL] SMTP credentials not configured. Using console fallback.');
    return null;
  }

  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
};

const sendPasswordResetEmail = async (email, resetToken) => {
  const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
  const resetUrl = `${frontendUrl}/#/reset-password/${resetToken}`;

  const htmlContent = `
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
          <!-- Header -->
          <tr>
            <td style="padding:40px 40px 20px;text-align:center;">
              <h1 style="margin:0;font-size:28px;font-weight:900;color:#ffffff;letter-spacing:-0.5px;">
                Play<span style="color:#39FF14;">Now</span>
              </h1>
              <p style="margin:8px 0 0;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:2px;font-weight:700;">
                Password Reset
              </p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:20px 40px 30px;">
              <p style="margin:0 0 16px;font-size:15px;color:#d1d5db;line-height:1.6;">
                We received a request to reset your PlayNow password. Click the button below to set a new password:
              </p>
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding:16px 0;">
                    <a href="${resetUrl}"
                       style="display:inline-block;background:#39FF14;color:#000000;font-size:14px;font-weight:900;text-decoration:none;padding:14px 40px;border-radius:12px;letter-spacing:0.5px;">
                      RESET PASSWORD
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:16px 0 0;font-size:12px;color:#6b7280;line-height:1.5;">
                This link expires in <strong style="color:#ffffff;">30 minutes</strong>. If you didn't request a password reset, you can safely ignore this email.
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px;border-top:1px solid rgba(255,255,255,0.05);text-align:center;">
              <p style="margin:0;font-size:10px;color:#4b5563;text-transform:uppercase;letter-spacing:1.5px;font-weight:700;">
                Secured by PlayNow &bull; Do not share this email
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const transporter = createTransporter();

  if (!transporter) {
    // Console fallback for development
    console.log('═══════════════════════════════════════════');
    console.log('  [DEV] Password Reset Email');
    console.log(`  To: ${email}`);
    console.log(`  Reset URL: ${resetUrl}`);
    console.log('═══════════════════════════════════════════');
    return { success: true, dev: true };
  }

  const mailOptions = {
    from: `"PlayNow" <${process.env.EMAIL_FROM || process.env.EMAIL_USER}>`,
    to: email,
    subject: 'PlayNow — Reset Your Password',
    html: htmlContent,
  };

  const info = await transporter.sendMail(mailOptions);
  console.log(`[EMAIL] Password reset sent to ${email} | messageId: ${info.messageId}`);
  return { success: true, messageId: info.messageId };
};

module.exports = { sendPasswordResetEmail };
