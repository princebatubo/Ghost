const logging = require('@tryghost/logging');
const {BadRequestError} = require('@tryghost/errors');

/**
 * Dodo Payments API Service
 * Replaces Ghost's Stripe integration with Dodo Payments
 */
class DodoAPI {
    constructor(config) {
        this.apiKey = config.apiKey;
        this.mode = config.mode || 'test'; // 'test' or 'live'
        this.baseURL = this.mode === 'live' 
            ? 'https://live.dodopayments.com' 
            : 'https://test.dodopayments.com';
    }

    /**
     * Make authenticated API request to Dodo Payments
     */
    async makeRequest(endpoint, method = 'GET', data = null) {
        const url = `${this.baseURL}${endpoint}`;
        
        const options = {
            method,
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json'
            }
        };

        if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
            options.body = JSON.stringify(data);
        }

        try {
            const response = await fetch(url, options);
            const responseData = await response.json();

            if (!response.ok) {
                throw new BadRequestError({
                    message: `Dodo API Error: ${responseData.message || 'Unknown error'}`,
                    statusCode: response.status
                });
            }

            return responseData;
        } catch (error) {
            logging.error(`Dodo API request failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Create checkout session (replaces Stripe checkout)
     * @param {string} priceId - Product price ID
     * @param {object} customer - Customer data
     * @param {object} data - Session configuration
     * @returns {Promise<{url: string, id: string}>}
     */
    async createCheckoutSession(priceId, customer, data) {
        const sessionData = {
            price_id: priceId,
            success_url: data.successUrl,
            cancel_url: data.cancelUrl,
            metadata: data.metadata || {},
            mode: 'subscription' // or 'payment' for one-time
        };

        if (customer) {
            sessionData.customer_id = customer.id;
        } else if (data.customerEmail) {
            sessionData.customer_email = data.customerEmail;
        }

        if (data.trialDays) {
            sessionData.trial_period_days = data.trialDays;
        }

        if (data.coupon) {
            sessionData.coupon_id = data.coupon;
        }

        const session = await this.makeRequest('/api/v1/checkout/sessions', 'POST', sessionData);
        
        return {
            id: session.id,
            url: session.checkout_url
        };
    }

    /**
     * Create donation checkout session
     * @param {object} data - Donation session data
     * @returns {Promise<{url: string, id: string}>}
     */
    async createDonationCheckoutSession(data) {
        const sessionData = {
            price_id: data.priceId,
            success_url: data.successUrl,
            cancel_url: data.cancelUrl,
            metadata: data.metadata || {},
            mode: 'payment', // One-time payment for donations
            allow_custom_amount: true
        };

        if (data.customer) {
            sessionData.customer_id = data.customer.id;
        } else if (data.customerEmail) {
            sessionData.customer_email = data.customerEmail;
        }

        if (data.personalNote) {
            sessionData.metadata.personal_note = data.personalNote;
        }

        const session = await this.makeRequest('/api/v1/checkout/sessions', 'POST', sessionData);
        
        return {
            id: session.id,
            url: session.checkout_url
        };
    }

    /**
     * Create customer in Dodo Payments
     * @param {object} customerData - Customer information
     * @returns {Promise<{id: string, email: string, name: string}>}
     */
    async createCustomer(customerData) {
        const customer = await this.makeRequest('/api/v1/customers', 'POST', {
            email: customerData.email,
            name: customerData.name,
            metadata: customerData.metadata || {}
        });

        return {
            id: customer.id,
            email: customer.email,
            name: customer.name,
            deleted: false
        };
    }

    /**
     * Retrieve customer from Dodo Payments
     * @param {string} customerId - Customer ID
     * @returns {Promise<{id: string, email: string, name: string, deleted: boolean}>}
     */
    async getCustomer(customerId) {
        try {
            const customer = await this.makeRequest(`/api/v1/customers/${customerId}`);
            
            return {
                id: customer.id,
                email: customer.email,
                name: customer.name,
                deleted: customer.deleted || false
            };
        } catch (error) {
            if (error.statusCode === 404) {
                return { deleted: true };
            }
            throw error;
        }
    }

    /**
     * Create product in Dodo Payments
     * @param {object} productData - Product information
     * @returns {Promise<{id: string, name: string, active: boolean}>}
     */
    async createProduct(productData) {
        const product = await this.makeRequest('/api/v1/products', 'POST', {
            name: productData.name,
            description: productData.description || '',
            type: productData.type || 'service',
            metadata: productData.metadata || {}
        });

        return {
            id: product.id,
            name: product.name,
            active: product.active !== false
        };
    }

    /**
     * Retrieve product from Dodo Payments
     * @param {string} productId - Product ID
     * @returns {Promise<{id: string, name: string, active: boolean}>}
     */
    async getProduct(productId) {
        const product = await this.makeRequest(`/api/v1/products/${productId}`);
        
        return {
            id: product.id,
            name: product.name,
            active: product.active !== false
        };
    }

    /**
     * Update product in Dodo Payments
     * @param {string} productId - Product ID
     * @param {object} updateData - Data to update
     * @returns {Promise<{id: string, name: string}>}
     */
    async updateProduct(productId, updateData) {
        const product = await this.makeRequest(`/api/v1/products/${productId}`, 'PATCH', updateData);
        
        return {
            id: product.id,
            name: product.name
        };
    }

    /**
     * Create price in Dodo Payments
     * @param {object} priceData - Price information  
     * @returns {Promise<{id: string, currency: string, unit_amount: number, recurring?: object}>}
     */
    async createPrice(priceData) {
        const price = await this.makeRequest('/api/v1/prices', 'POST', {
            product_id: priceData.product,
            currency: priceData.currency.toLowerCase(),
            unit_amount: priceData.amount,
            recurring: priceData.type === 'recurring' ? {
                interval: priceData.interval // 'month' or 'year'
            } : null,
            nickname: priceData.nickname,
            active: priceData.active !== false,
            metadata: priceData.metadata || {}
        });

        return {
            id: price.id,
            currency: price.currency,
            unit_amount: price.unit_amount,
            active: price.active,
            nickname: price.nickname,
            recurring: price.recurring
        };
    }

    /**
     * Retrieve price from Dodo Payments
     * @param {string} priceId - Price ID
     * @returns {Promise<{id: string, currency: string, unit_amount: number, active: boolean, recurring?: object}>}
     */
    async getPrice(priceId) {
        const price = await this.makeRequest(`/api/v1/prices/${priceId}`);
        
        return {
            id: price.id,
            currency: price.currency,
            unit_amount: price.unit_amount,
            active: price.active,
            recurring: price.recurring
        };
    }

    /**
     * Update price in Dodo Payments
     * @param {string} priceId - Price ID
     * @param {object} updateData - Data to update
     * @returns {Promise<{id: string}>}
     */
    async updatePrice(priceId, updateData) {
        const price = await this.makeRequest(`/api/v1/prices/${priceId}`, 'PATCH', updateData);
        
        return {
            id: price.id
        };
    }

    /**
     * Create coupon in Dodo Payments
     * @param {object} couponData - Coupon information
     * @returns {Promise<{id: string, name: string}>}
     */
    async createCoupon(couponData) {
        const coupon = await this.makeRequest('/api/v1/coupons', 'POST', {
            name: couponData.name,
            discount_type: couponData.percent_off ? 'percentage' : 'fixed_amount',
            discount_value: couponData.percent_off || couponData.amount_off,
            currency: couponData.currency,
            duration: couponData.duration, // 'once', 'repeating', 'forever'
            duration_in_months: couponData.duration_in_months,
            metadata: couponData.metadata || {}
        });

        return {
            id: coupon.id,
            name: coupon.name
        };
    }

    /**
     * Verify webhook signature for security
     * @param {string} payload - Webhook payload
     * @param {string} signature - Webhook signature
     * @param {string} secret - Webhook secret
     * @returns {boolean}
     */
    verifyWebhookSignature(payload, signature, secret) {
        const crypto = require('crypto');
        const expectedSignature = crypto
            .createHmac('sha256', secret)
            .update(payload)
            .digest('hex');
        
        return crypto.timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(expectedSignature)
        );
    }

    /**
     * Parse webhook event
     * @param {string} payload - Raw webhook payload
     * @returns {object} Parsed webhook event
     */
    parseWebhook(payload) {
        try {
            return JSON.parse(payload);
        } catch (error) {
            throw new BadRequestError({
                message: 'Invalid webhook payload'
            });
        }
    }
}

module.exports = DodoAPI;
