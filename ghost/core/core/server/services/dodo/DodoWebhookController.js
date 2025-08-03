const logging = require('@tryghost/logging');
const {BadRequestError} = require('@tryghost/errors');

/**
 * Dodo Payments Webhook Controller
 * Handles incoming webhooks from Dodo Payments
 * Replaces Stripe webhook handling
 */
class DodoWebhookController {
    constructor(deps) {
        this.dodoAPIService = deps.dodoAPIService;
        this.memberRepository = deps.memberRepository;
        this.tiersService = deps.tiersService;
        this.settingsCache = deps.settingsCache;
        this.webhookSecret = deps.webhookSecret; // Dodo webhook signing secret
    }

    /**
     * Handle incoming Dodo webhook
     * @param {object} req - Express request object
     * @param {object} res - Express response object
     */
    async handleWebhook(req, res) {
        const signature = req.headers['x-dodo-signature'];
        const payload = req.body;

        try {
            // Verify webhook signature for security
            const isValid = this.dodoAPIService.verifyWebhookSignature(
                JSON.stringify(payload),
                signature,
                this.webhookSecret
            );

            if (!isValid) {
                throw new BadRequestError({
                    message: 'Invalid webhook signature'
                });
            }

            // Parse the webhook event
            const event = this.dodoAPIService.parseWebhook(JSON.stringify(payload));
            
            logging.info(`Processing Dodo webhook: ${event.type}`);

            // Route webhook event to appropriate handler
            await this.routeWebhookEvent(event);

            res.status(200).json({received: true});

        } catch (error) {
            logging.error(`Dodo webhook error: ${error.message}`);
            res.status(400).json({error: error.message});
        }
    }

    /**
     * Route webhook events to specific handlers
     * @param {object} event - Dodo webhook event
     */
    async routeWebhookEvent(event) {
        switch (event.type) {
            case 'payment.succeeded':
                await this.handlePaymentSucceeded(event);
                break;
            
            case 'payment.failed':
                await this.handlePaymentFailed(event);
                break;
            
            case 'subscription.created':
                await this.handleSubscriptionCreated(event);
                break;
            
            case 'subscription.updated':
                await this.handleSubscriptionUpdated(event);
                break;
            
            case 'subscription.cancelled':
                await this.handleSubscriptionCancelled(event);
                break;
            
            case 'customer.created':
                await this.handleCustomerCreated(event);
                break;
            
            case 'customer.updated':
                await this.handleCustomerUpdated(event);
                break;
            
            case 'invoice.payment_succeeded':
                await this.handleInvoicePaymentSucceeded(event);
                break;
            
            case 'invoice.payment_failed':
                await this.handleInvoicePaymentFailed(event);
                break;
            
            default:
                logging.info(`Unhandled Dodo webhook event: ${event.type}`);
        }
    }

    /**
     * Handle successful payment
     * @param {object} event - Dodo webhook event
     */
    async handlePaymentSucceeded(event) {
        const payment = event.data.object;
        
        logging.info(`Payment succeeded: ${payment.id}`);
        
        try {
            // Find member by customer ID or email
            const member = await this.findMemberFromPayment(payment);
            
            if (member) {
                // Update member status to paid
                await this.memberRepository.update(member.id, {
                    status: 'paid'
                });
                
                logging.info(`Updated member ${member.id} status to paid`);
            }
        } catch (error) {
            logging.error(`Error processing payment success: ${error.message}`);
        }
    }

    /**
     * Handle failed payment
     * @param {object} event - Dodo webhook event
     */
    async handlePaymentFailed(event) {
        const payment = event.data.object;
        
        logging.info(`Payment failed: ${payment.id}`);
        
        try {
            const member = await this.findMemberFromPayment(payment);
            
            if (member) {
                // Handle payment failure (could send email notification, etc.)
                logging.info(`Payment failed for member ${member.id}`);
                
                // Optionally update member status or send notification
                // await this.sendPaymentFailedNotification(member);
            }
        } catch (error) {
            logging.error(`Error processing payment failure: ${error.message}`);
        }
    }

    /**
     * Handle subscription creation
     * @param {object} event - Dodo webhook event
     */
    async handleSubscriptionCreated(event) {
        const subscription = event.data.object;
        
        logging.info(`Subscription created: ${subscription.id}`);
        
        try {
            const member = await this.findMemberFromSubscription(subscription);
            
            if (member) {
                // Update member with subscription details
                await this.memberRepository.update(member.id, {
                    status: 'paid',
                    subscribed: true
                });
                
                // Grant access to paid content
                await this.grantTierAccess(member, subscription);
                
                logging.info(`Granted subscription access to member ${member.id}`);
            }
        } catch (error) {
            logging.error(`Error processing subscription creation: ${error.message}`);
        }
    }

    /**
     * Handle subscription update
     * @param {object} event - Dodo webhook event
     */
    async handleSubscriptionUpdated(event) {
        const subscription = event.data.object;
        
        logging.info(`Subscription updated: ${subscription.id}`);
        
        try {
            const member = await this.findMemberFromSubscription(subscription);
            
            if (member) {
                // Update member subscription details
                await this.updateMemberSubscription(member, subscription);
                
                logging.info(`Updated subscription for member ${member.id}`);
            }
        } catch (error) {
            logging.error(`Error processing subscription update: ${error.message}`);
        }
    }

    /**
     * Handle subscription cancellation
     * @param {object} event - Dodo webhook event
     */
    async handleSubscriptionCancelled(event) {
        const subscription = event.data.object;
        
        logging.info(`Subscription cancelled: ${subscription.id}`);
        
        try {
            const member = await this.findMemberFromSubscription(subscription);
            
            if (member) {
                // Update member status
                await this.memberRepository.update(member.id, {
                    status: 'free',
                    subscribed: false
                });
                
                // Revoke access to paid content
                await this.revokeTierAccess(member);
                
                logging.info(`Revoked subscription access for member ${member.id}`);
            }
        } catch (error) {
            logging.error(`Error processing subscription cancellation: ${error.message}`);
        }
    }

    /**
     * Handle customer creation
     * @param {object} event - Dodo webhook event
     */
    async handleCustomerCreated(event) {
        const customer = event.data.object;
        
        logging.info(`Customer created: ${customer.id}`);
        
        // Customer creation is usually handled during member signup
        // This webhook can be used for additional processing if needed
    }

    /**
     * Handle customer update
     * @param {object} event - Dodo webhook event
     */
    async handleCustomerUpdated(event) {
        const customer = event.data.object;
        
        logging.info(`Customer updated: ${customer.id}`);
        
        try {
            // Update member details if customer information changed
            const member = await this.findMemberFromCustomer(customer);
            
            if (member && (member.email !== customer.email || member.name !== customer.name)) {
                await this.memberRepository.update(member.id, {
                    email: customer.email,
                    name: customer.name
                });
                
                logging.info(`Updated member ${member.id} from customer update`);
            }
        } catch (error) {
            logging.error(`Error processing customer update: ${error.message}`);
        }
    }

    /**
     * Handle successful invoice payment
     * @param {object} event - Dodo webhook event
     */
    async handleInvoicePaymentSucceeded(event) {
        const invoice = event.data.object;
        
        logging.info(`Invoice payment succeeded: ${invoice.id}`);
        
        // Handle recurring payment success
        await this.handlePaymentSucceeded({
            data: {
                object: {
                    id: invoice.payment_intent,
                    customer: invoice.customer,
                    amount: invoice.amount_paid
                }
            }
        });
    }

    /**
     * Handle failed invoice payment
     * @param {object} event - Dodo webhook event
     */
    async handleInvoicePaymentFailed(event) {
        const invoice = event.data.object;
        
        logging.info(`Invoice payment failed: ${invoice.id}`);
        
        // Handle recurring payment failure
        await this.handlePaymentFailed({
            data: {
                object: {
                    id: invoice.payment_intent,
                    customer: invoice.customer,
                    amount: invoice.amount_due
                }
            }
        });
    }

    /**
     * Find member from payment object
     * @param {object} payment - Dodo payment object
     * @returns {Promise<object|null>} Member object or null
     */
    async findMemberFromPayment(payment) {
        if (payment.customer) {
            return await this.findMemberFromCustomerId(payment.customer);
        }
        
        if (payment.customer_email) {
            return await this.memberRepository.get({email: payment.customer_email});
        }
        
        return null;
    }

    /**
     * Find member from subscription object
     * @param {object} subscription - Dodo subscription object
     * @returns {Promise<object|null>} Member object or null
     */
    async findMemberFromSubscription(subscription) {
        return await this.findMemberFromCustomerId(subscription.customer);
    }

    /**
     * Find member from customer object
     * @param {object} customer - Dodo customer object
     * @returns {Promise<object|null>} Member object or null
     */
    async findMemberFromCustomer(customer) {
        return await this.findMemberFromCustomerId(customer.id);
    }

    /**
     * Find member by Dodo customer ID
     * @param {string} customerId - Dodo customer ID
     * @returns {Promise<object|null>} Member object or null
     */
    async findMemberFromCustomerId(customerId) {
        const DodoCustomerModel = require('./models/DodoCustomer');
        
        const customerRecord = await DodoCustomerModel
            .where({customer_id: customerId})
            .query()
            .select('member_id')
            .first();
        
        if (customerRecord) {
            return await this.memberRepository.get({id: customerRecord.member_id});
        }
        
        return null;
    }

    /**
     * Grant tier access to member based on subscription
     * @param {object} member - Member object
     * @param {object} subscription - Dodo subscription object
     */
    async grantTierAccess(member, subscription) {
        try {
            // Find the tier associated with the subscription price
            const tier = await this.findTierFromSubscription(subscription);
            
            if (tier) {
                await this.memberRepository.update(member.id, {
                    tier_id: tier.id
                });
            }
        } catch (error) {
            logging.error(`Error granting tier access: ${error.message}`);
        }
    }

    /**
     * Revoke tier access from member
     * @param {object} member - Member object
     */
    async revokeTierAccess(member) {
        try {
            await this.memberRepository.update(member.id, {
                tier_id: null
            });
        } catch (error) {
            logging.error(`Error revoking tier access: ${error.message}`);
        }
    }

    /**
     * Update member subscription details
     * @param {object} member - Member object
     * @param {object} subscription - Dodo subscription object
     */
    async updateMemberSubscription(member, subscription) {
        try {
            const updates = {
                status: subscription.status === 'active' ? 'paid' : 'free'
            };

            if (subscription.status === 'active') {
                const tier = await this.findTierFromSubscription(subscription);
                if (tier) {
                    updates.tier_id = tier.id;
                }
            } else {
                updates.tier_id = null;
            }

            await this.memberRepository.update(member.id, updates);
        } catch (error) {
            logging.error(`Error updating member subscription: ${error.message}`);
        }
    }

    /**
     * Find tier from subscription price
     * @param {object} subscription - Dodo subscription object
     * @returns {Promise<object|null>} Tier object or null
     */
    async findTierFromSubscription(subscription) {
        try {
            const DodoPriceModel = require('./models/DodoPrice');
            
            const priceRecord = await DodoPriceModel
                .where({dodo_price_id: subscription.price_id})
                .query()
                .select('dodo_product_id')
                .first();
            
            if (priceRecord) {
                const DodoProductModel = require('./models/DodoProduct');
                
                const productRecord = await DodoProductModel
                    .where({dodo_product_id: priceRecord.dodo_product_id})
                    .query()
                    .select('product_id')
                    .first();
                
                if (productRecord) {
                    return await this.tiersService.get({id: productRecord.product_id});
                }
            }
            
            return null;
        } catch (error) {
            logging.error(`Error finding tier from subscription: ${error.message}`);
            return null;
        }
    }
}

module.exports = DodoWebhookController;
