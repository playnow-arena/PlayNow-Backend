const axios = require('axios');

/**
 * Service to handle n8n webhook integrations securely and asynchronously.
 */
class n8nService {
  /**
   * Send booking confirmation data to n8n webhook
   * @param {Object} bookingData - The formatted booking data
   */
  static async sendBookingConfirmation(bookingData) {
    const webhookUrl = process.env.N8N_WEBHOOK_URL;
    
    if (!webhookUrl) {
      console.warn('⚠️ N8N_WEBHOOK_URL is not defined in environment variables. Skipping webhook trigger.');
      return;
    }

    try {
      // Fire and forget - we don't await this in the main flow to avoid blocking
      axios.post(webhookUrl, bookingData, {
        headers: {
          'Content-Type': 'application/json',
          // 'Authorization': `Bearer ${process.env.N8N_AUTH_TOKEN}` // For future secure auth
        },
        timeout: 5000 // 5 seconds timeout so it doesn't hang indefinitely if awaited
      })
      .then(response => {
        console.log(`✅ [n8n Webhook Success] Booking ${bookingData.bookingId} sent to n8n.`);
      })
      .catch(error => {
        console.error(`❌ [n8n Webhook Error] Failed to send booking ${bookingData.bookingId} to n8n:`, error.message);
      });
      
    } catch (error) {
      console.error(`❌ [n8n Webhook Error] Unexpected error triggering webhook:`, error.message);
    }
  }
}

module.exports = n8nService;
