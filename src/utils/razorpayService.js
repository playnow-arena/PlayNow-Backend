const crypto = require('crypto');

const RAZORPAY_API_URL = 'https://api.razorpay.com/v1';

const getCredentials = () => {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    throw new Error('Razorpay is not configured');
  }

  return { keyId, keySecret };
};

const getClientConfig = () => {
  const { keyId, keySecret } = getCredentials();
  return {
    auth: {
      username: keyId,
      password: keySecret
    }
  };
};

const createOrder = async ({ amount, receipt, notes = {} }) => {
  const axios = require('axios');
  const response = await axios.post(
    `${RAZORPAY_API_URL}/orders`,
    {
      amount,
      currency: 'INR',
      receipt,
      notes
    },
    getClientConfig()
  );

  return response.data;
};

const getPayment = async (paymentId) => {
  const axios = require('axios');
  const response = await axios.get(
    `${RAZORPAY_API_URL}/payments/${paymentId}`,
    getClientConfig()
  );
  return response.data;
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
