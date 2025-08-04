    const errors = require('@tryghost/errors');
const tpl = require('@tryghost/tpl');
const {Buffer} = require('buffer');
const {randomBytes} = require('crypto');
const {URL} = require('url');

const config = require('../../../shared/config');
const urlUtils = require('../../../shared/url-utils');

const messages = {
    incorrectState: 'State did not match.'
};

const STATE_PROP = 'dodo-connect-state'; // CHANGED from 'stripe-connect-state'

// CHANGED: Dodo Payments OAuth configuration
// TODO: Replace these with actual Dodo OAuth client IDs when available
const liveClientID = 'dodo_live_client_id'; // Replace with actual Dodo Live client ID
const testClientID = 'dodo_test_client_id'; // Replace with actual Dodo Test client ID
const redirectURI = 'https://connect.dodopayments.com/redirect'; // Replace with actual Dodo redirect URI

/**
 * @function getDodoConnectOAuthUrl
 * @desc Returns a url for the auth endpoint for Dodo Connect, generates state and stores it on the session.
 *
 * @param {(prop: string, val: any) => Promise<void>} setSessionProp - A function to set data on the current session
 * @param {'live' | 'test'} mode - Which dodo mode to set up
 *
 * @returns {Promise<URL>}
 */
async function getDodoConnectOAuthUrl(setSessionProp, mode = 'live') {
    checkCanConnect();
    const randomState = randomBytes(16).toString('hex');
    const state = Buffer.from(JSON.stringify({
        mode,
        randomState
    })).toString('base64');

    await setSessionProp(STATE_PROP, state);

    const clientID = mode === 'live' ? liveClientID : testClientID;

    // CHANGED: Use Dodo OAuth URL instead of Stripe
    const authUrl = new URL('https://connect.dodopayments.com/oauth/authorize');
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'read_write'); // Adjust scope as needed for Dodo
    authUrl.searchParams.set('client_id', clientID);
    authUrl.searchParams.set('redirect_uri', redirectURI);
    authUrl.searchParams.set('state', state);

    return authUrl;
}

/**
 * @function getDodoConnectTokenData
 * @desc Returns the api keys and the livemode for a Dodo Connect integration after validating the state.
 *
 * @param {string} encodedData - A string encoding the response from Dodo Connect
 * @param {(prop: string) => Promise<any>} getSessionProp - A function to retrieve data from the current session
 *
 * @returns {Promise<{secret_key: string, public_key: string, livemode: boolean, display_name: string, account_id: string}>}
 */
async function getDodoConnectTokenData(encodedData, getSessionProp) {
    const data = JSON.parse(Buffer.from(encodedData, 'base64').toString());

    const state = await getSessionProp(STATE_PROP);

    if (state !== data.s) {
        throw new errors.NoPermissionError({message: tpl(messages.incorrectState)});
    }

    // CHANGED: Return Dodo API credentials instead of Stripe
    return {
        public_key: data.p, // Dodo public key
        secret_key: data.a, // Dodo secret key (API key)
        livemode: data.l,   // Live/test mode
        display_name: data.n, // Account display name
