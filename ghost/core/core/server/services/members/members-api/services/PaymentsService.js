const logging = require('@tryghost/logging');
const DomainEvents = require('@tryghost/domain-events');
const TierCreatedEvent = require('../../../../../../core/server/services/tiers/TierCreatedEvent');
const TierPriceChangeEvent = require('../../../../../../core/server/services/tiers/TierPriceChangeEvent');
const TierNameChangeEvent = require('../../../../../../core/server/services/tiers/TierNameChangeEvent');
const OfferCreatedEvent = require('../../../../../../core/server/services/offers/domain/events/OfferCreatedEvent');
const {BadRequestError} = require('@tryghost/errors');

class PaymentsService {
    /**
     * @param {object} deps
     * @param {import('bookshelf').Model} deps.Offer
     * @param {import('../../../offers/application/OffersAPI')} deps.offersAPI
     * @param {import('../../../dodo/DodoAPI')} deps.dodoAPIService - CHANGED from stripeAPIService
     * @param {{get(key: string): any}} deps.settingsCache
     */
    constructor(deps) {
        /** @private */
        this.OfferModel = deps.Offer;
        /** @private */
        this.DodoProductModel = deps.DodoProduct; // CHANGED from StripeProductModel
        /** @private */
        this.DodoPriceModel = deps.DodoPrice; // CHANGED from StripePriceModel
        /** @private */
        this.DodoCustomerModel = deps.DodoCustomer; // CHANGED from StripeCustomerModel
        /** @private */
        this.offersAPI = deps.offersAPI;
        /** @private */
        this.dodoAPIService = deps.dodoAPIService; // CHANGED from stripeAPIService
        /** @private */
        this.settingsCache = deps.settingsCache;

        DomainEvents.subscribe(OfferCreatedEvent, async (event) => {
            await this.getCouponForOffer(event.data.offer.id);
        });

        DomainEvents.subscribe(TierCreatedEvent, async (event) => {
            if (event.data.tier.type === 'paid') {
                await this.getPriceForTierCadence(event.data.tier, 'month');
                await this.getPriceForTierCadence(event.data.tier, 'year');
            }
        });

        DomainEvents.subscribe(TierPriceChangeEvent, async (event) => {
            if (event.data.tier.type === 'paid') {
                await this.getPriceForTierCadence(event.data.tier, 'month');
                await this.getPriceForTierCadence(event.data.tier, 'year');
            }
        });

        DomainEvents.subscribe(TierNameChangeEvent, async (event) => {
            if (event.data.tier.type === 'paid') {
                await this.updateNameForTierProducts(event.data.tier);
            }
        });
    }

    /**
     * @param {object} params
     * @param {import('../../../tiers/Tier')} params.tier
     * @param {Tier.Cadence} params.cadence
     * @param {Offer} [params.offer]
     * @param {Member} [params.member]
     * @param {Object.<string, any>} [params.metadata]
     * @param {string} params.successUrl
     * @param {string} params.cancelUrl
     * @param {string} [params.email]
     *
     * @returns {Promise<URL>}
     */
    async getPaymentLink({tier, cadence, offer, member, metadata, successUrl, cancelUrl, email}) {
        let coupon = null;
        let trialDays = null;
        if (offer) {
            if (!tier.id.equals(offer.tier.id)) {
                throw new BadRequestError({
                    message: 'This Offer is not valid for the Tier'
                });
            }
            if (offer.type === 'trial') {
                trialDays = offer.amount;
            } else {
                coupon = await this.getCouponForOffer(offer.id);
            }
        }

        let customer = null;
        if (member) {
            customer = await this.getCustomerForMember(member);
        }

        const price = await this.getPriceForTierCadence(tier, cadence);

        const data = {
            metadata,
            successUrl: successUrl,
            cancelUrl: cancelUrl,
            trialDays: trialDays ?? tier.trialDays,
            coupon: coupon?.id
        };

        // If we already have a coupon, we don't want to give trial days over it
        if (data.coupon) {
            delete data.trialDays;
        }

        if (!customer && email) {
            data.customerEmail = email;
        }

        // CHANGED: Use Dodo API instead of Stripe
        const session = await this.dodoAPIService.createCheckoutSession(price.id, customer, data);

        return session.url;
    }

    /**
     * @param {object} params
     * @param {Member} [params.member]
     * @param {Object.<string, any>} [params.metadata]
     * @param {string} params.successUrl
     * @param {string} params.cancelUrl
     * @param {boolean} [params.isAuthenticated]
     * @param {string} [params.email]
     *
     * @returns {Promise<URL>}
     */
    async getDonationPaymentLink({member, metadata, successUrl, cancelUrl, email, isAuthenticated, personalNote}) {
        let customer = null;
        if (member && isAuthenticated) {
            customer = await this.getCustomerForMember(member);
        }

        const data = {
            priceId: (await this.getPriceForDonations()).id,
            metadata,
            successUrl: successUrl,
            cancelUrl: cancelUrl,
            customer,
            customerEmail: !customer && email ? email : null,
            personalNote: personalNote
        };

        // CHANGED: Use Dodo API instead of Stripe
        const session = await this.dodoAPIService.createDonationCheckoutSession(data);
        return session.url;
    }

    async getCustomerForMember(member) {
        // CHANGED: Query Dodo customers instead of Stripe customers
        const rows = await this.DodoCustomerModel.where({
            member_id: member.id
        }).query().select('customer_id');

        for (const row of rows) {
            try {
                // CHANGED: Use Dodo API instead of Stripe
                const customer = await this.dodoAPIService.getCustomer(row.customer_id);
                if (!customer.deleted) {
                    return customer;
                }
            } catch (err) {
                logging.warn(err);
            }
        }

        const customer = await this.createCustomerForMember(member);

        return customer;
    }

    async createCustomerForMember(member) {
        // CHANGED: Use Dodo API instead of Stripe
        const customer = await this.dodoAPIService.createCustomer({
            email: member.get('email'),
            name: member.get('name')
        });

        // CHANGED: Save to Dodo customers table instead of Stripe
        await this.DodoCustomerModel.add({
            member_id: member.id,
            customer_id: customer.id,
            email: customer.email,
            name: customer.name
        });

        return customer;
    }

    /**
     * @param {import('../../../tiers/Tier')} tier
     * @returns {Promise<{id: string}>}
     */
    async getProductForTier(tier) {
        // CHANGED: Query Dodo products instead of Stripe products
        const rows = await this.DodoProductModel
            .where({product_id: tier.id.toHexString()})
            .query()
            .select('dodo_product_id'); // CHANGED column name

        for (const row of rows) {
            try {
                // CHANGED: Use Dodo API instead of Stripe
                const product = await this.dodoAPIService.getProduct(row.dodo_product_id);
                if (product.active) {
                    return {id: product.id};
                }
            } catch (err) {
                logging.warn(err);
            }
        }

        const product = await this.createProductForTier(tier);

        return {
            id: product.id
        };
    }

    /**
     * @param {import('../../../tiers/Tier')} tier
     * @returns {Promise<{id: string, name: string}>}
     */
    async createProductForTier(tier) {
        // CHANGED: Use Dodo API instead of Stripe
        const product = await this.dodoAPIService.createProduct({name: tier.name});
        
        // CHANGED: Save to Dodo products table
        await this.DodoProductModel.add({
            product_id: tier.id.toHexString(),
            dodo_product_id: product.id // CHANGED column name
        });
        return product;
    }

    /**
     * @param {import('../../../tiers/Tier')} tier
     * @returns {Promise<void>}
     */
    async updateNameForTierProducts(tier) {
        // CHANGED: Query Dodo products instead of Stripe products
        const rows = await this.DodoProductModel
            .where({product_id: tier.id.toHexString()})
            .query()
            .select('dodo_product_id'); // CHANGED column name

        for (const row of rows) {
            // CHANGED: Use Dodo API instead of Stripe
            await this.dodoAPIService.updateProduct(row.dodo_product_id, {
                name: tier.name
            });
        }
    }

    /**
     * @returns {Promise<{id: string}>}
     */
    async getProductForDonations({name}) {
        // CHANGED: Query Dodo prices instead of Stripe prices
        const existingDonationPrices = await this.DodoPriceModel
            .where({
                type: 'donation'
            })
            .query()
            .select('dodo_product_id'); // CHANGED column name

        for (const row of existingDonationPrices) {
            // CHANGED: Query Dodo products instead of Stripe products
            const product = await this.DodoProductModel
                .where({
                    dodo_product_id: row.dodo_product_id // CHANGED column name
                })
                .query()
                .select('dodo_product_id') // CHANGED column name
                .first();

            if (product) {
                // Check active in Dodo
                try {
                    // CHANGED: Use Dodo API instead of Stripe
                    const dodoProduct = await this.dodoAPIService.getProduct(row.dodo_product_id);
                    if (dodoProduct.active) {
                        return {id: dodoProduct.id};
                    }
                } catch (err) {
                    logging.warn(err);
                }
            }
        }

        const product = await this.createProductForDonations({name});

        return {
            id: product.id
        };
    }

    /**
     * Dodo's nickname field equivalent
     * @returns {string}
     */
    getDonationPriceNickname() {
        const nickname = 'Support ' + this.settingsCache.get('title');
        return nickname.substring(0, 250);
    }

    /**
     * @returns {Promise<{id: string}>}
     */
    async getPriceForDonations() {
        const nickname = this.getDonationPriceNickname();
        const currency = this.settingsCache.get('donations_currency');
        const suggestedAmount = this.settingsCache.get('donations_suggested_amount');

        // Dodo requires minimum charge amount (similar to Stripe)
        const amount = suggestedAmount && suggestedAmount >= 100 ? suggestedAmount : 0;

        // CHANGED: Query Dodo prices instead of Stripe prices
        const price = await this.DodoPriceModel
            .where({
                type: 'donation',
                active: true,
                amount,
                currency
            })
            .query()
            .select('dodo_price_id', 'dodo_product_id', 'id', 'nickname') // CHANGED column names
            .first();

        if (price) {
            if (price.nickname !== nickname) {
                // Rename it in Dodo (in case the publication name changed)
                try {
                    // CHANGED: Use Dodo API instead of Stripe
                    await this.dodoAPIService.updatePrice(price.dodo_price_id, {
                        nickname
                    });

                    // Update product too
                    await this.dodoAPIService.updateProduct(price.dodo_product_id, {
                        name: nickname
                    });

                    // CHANGED: Update Dodo price model
                    await this.DodoPriceModel.edit({
                        nickname
                    }, {id: price.id});
                } catch (err) {
                    logging.warn(err);
                }
            }
            return {
                id: price.dodo_price_id // CHANGED column name
            };
        }

        const newPrice = await this.createPriceForDonations({
            nickname,
            currency,
            amount
        });
        return {
            id: newPrice.id
        };
    }

    /**
     * @returns {Promise<{id: string}>}
     */
    async createPriceForDonations({currency, amount, nickname}) {
        const product = await this.getProductForDonations({name: nickname});

        const preset = amount ? amount : undefined;

        // CHANGED: Create the price in Dodo instead of Stripe
        const price = await this.dodoAPIService.createPrice({
            currency,
            product: product.id,
            custom_unit_amount: {
                enabled: true,
                preset
            },
            nickname,
            type: 'one-time',
            active: true
        });

        // CHANGED: Save to Dodo prices table
        await this.DodoPriceModel.add({
            dodo_price_id: price.id, // CHANGED column name
            dodo_product_id: product.id, // CHANGED column name
            active: price.active,
            nickname: price.nickname,
            currency: price.currency,
            amount,
            type: 'donation',
            interval: null
        });
        return price;
    }

    /**
     * @returns {Promise<{id: string, name: string}>}
     */
    async createProductForDonations({name}) {
        // CHANGED: Use Dodo API instead of Stripe
        const product = await this.dodoAPIService.createProduct({
            name
        });

        // CHANGED: Save to Dodo products table
        await this.DodoProductModel.add({
            product_id: null,
            dodo_product_id: product.id // CHANGED column name
        });
        return product;
    }

    /**
     * @param {import('../../../tiers/Tier')} tier
     * @param {'month'|'year'} cadence
     * @returns {Promise<{id: string}>}
     */
    async getPriceForTierCadence(tier, cadence) {
        const product = await this.getProductForTier(tier);
        const currency = tier.currency.toLowerCase();
        const amount = tier.getPrice(cadence);
        
        // CHANGED: Query Dodo prices instead of Stripe prices
        const rows = await this.DodoPriceModel.where({
            dodo_product_id: product.id, // CHANGED column name
            currency,
            interval: cadence,
            amount,
            active: true,
            type: 'recurring'
        }).query().select('id', 'dodo_price_id'); // CHANGED column name

        for (const row of rows) {
            try {
                // CHANGED: Use Dodo API instead of Stripe
                const price = await this.dodoAPIService.getPrice(row.dodo_price_id);
                if (price.active && price.currency.toLowerCase() === currency && price.unit_amount === amount && price.recurring?.interval === cadence) {
                    return {
                        id: price.id
                    };
                } else {
                    // Update the database model to prevent future Dodo fetches when it is not needed
                    await this.DodoPriceModel.edit({
                        active: !!price.active
                    }, {id: row.id});
                }
            } catch (err) {
                logging.error(`Failed to lookup Dodo Price ${row.dodo_price_id}`);
                logging.error(err);
            }
        }

        const price = await this.createPriceForTierCadence(tier, cadence);

        return {
            id: price.id
        };
    }

    /**
     * @param {import('../../../tiers/Tier')} tier
     * @param {'month'|'year'} cadence
     * @returns {Promise<{id: string}>}
     */
    async createPriceForTierCadence(tier, cadence) {
        const product = await this.getProductForTier(tier);
        
        // CHANGED: Use Dodo API instead of Stripe
        const price = await this.dodoAPIService.createPrice({
            product: product.id,
            interval: cadence,
            currency: tier.currency,
            amount: tier.getPrice(cadence),
            nickname: cadence === 'month' ? 'Monthly' : 'Yearly',
            type: 'recurring',
            active: true
        });
        
        // CHANGED: Save to Dodo prices table
        await this.DodoPriceModel.add({
            dodo_price_id: price.id, // CHANGED column name
            dodo_product_id: product.id, // CHANGED column name
            active: price.active,
            nickname: price.nickname,
            currency: price.currency,
            amount: price.unit_amount,
            type: 'recurring',
            interval: cadence
        });
        return price;
    }

    /**
     * @param {string} offerId
     *
     * @returns {Promise<{id: string}>}
     */
    async getCouponForOffer(offerId) {
        // CHANGED: Look for dodo_coupon_id instead of stripe_coupon_id
        const row = await this.OfferModel.where({id: offerId}).query().select('dodo_coupon_id', 'discount_type').first();
        if (!row || row.discount_type === 'trial') {
            return null;
        }
        if (!row.dodo_coupon_id) {
            const offer = await this.offersAPI.getOffer({id: offerId});
            await this.createCouponForOffer(offer);
            return this.getCouponForOffer(offerId);
        }
        return {
            id: row.dodo_coupon_id // CHANGED column name
        };
    }

    /**
     * @param {import('@tryghost/members-offers/lib/application/OfferMapper').OfferDTO} offer
     */
    async createCouponForOffer(offer) {
        /** @type {object} */
        const couponData = {
            name: offer.name,
            duration: offer.duration
        };

        if (offer.duration === 'repeating') {
            couponData.duration_in_months = offer.duration_in_months;
        }

        if (offer.type === 'percent') {
            couponData.percent_off = offer.amount;
        } else {
            couponData.amount_off = offer.amount;
            couponData.currency = offer.currency;
        }

        // CHANGED: Use Dodo API instead of Stripe
        const coupon = await this.dodoAPIService.createCoupon(couponData);

        // CHANGED: Save dodo_coupon_id instead of stripe_coupon_id
        await this.OfferModel.edit({
            dodo_coupon_id: coupon.id // CHANGED column name
        }, {
            id: offer.id
        });
    }
}

module.exports = PaymentsService;
