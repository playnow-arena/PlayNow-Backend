const crypto = require('crypto');
const Razorpay = require('razorpay');

const getCredentials = () => {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    throw new Error('Razorpay is not configured');
  }

  return { keyId, keySecret };
};

const getClient = () => {
  const { keyId, keySecret } = getCredentials();
  return new Razorpay({
    key_id: keyId,
    key_secret: keySecret
  });
};

const createOrder = async ({ amount, currency = 'INR', receipt, notes = {} }) => {
  const client = getClient();
  return client.orders.create({
    amount,
    currency,
    receipt,
    notes
  });
};

const getPayment = async (paymentId) => {
  const client = getClient();
  return client.payments.fetch(paymentId);
};

const verifyPaymentSignature = ({ orderId, paymentId, signature }) => {
  const { keySecret } = getCredentials();
  const expectedSignature = crypto
    .createHmac('sha256', keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  const expectedBuffer = Buffer.from(expectedSignature);
  const receivedBuffer = Buffer.from(String(signature || ''));

  return expectedBuffer.length === receivedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
};

const getPublicKeyId = () => getCredentials().keyId;

module.exports = {
  createOrder,
  getPayment,
  verifyPaymentSignature,
  getPublicKeyId
};
