'use strict';

/**
 * tranzak.js — TranZak payment adapter
 *
 * Thin wrapper around the TranZak REST API (xp021 — hosted checkout).
 * Only two functions are exported; a second provider would implement the same
 * two functions and drop in without touching bot.js or server.js.
 *
 * API docs: https://docs.developer.tranzak.me
 *
 * Required env vars:
 *   TRANZAK_APP_ID  — App ID from the TranZak developer dashboard
 *   TRANZAK_APP_KEY — API key (note: field name is `appKey`, not `apiKey`)
 *   TRANZAK_ENV     — "sandbox" | "production"
 *
 * Base URLs:
 *   sandbox    → https://sandbox.dsapi.tranzak.me
 *   production → https://dsapi.tranzak.me
 */

const axios = require('axios');

const BASE_URL = process.env.TRANZAK_ENV === 'production'
  ? 'https://dsapi.tranzak.me'
  : 'https://sandbox.dsapi.tranzak.me';

// ── Token cache ───────────────────────────────────────────────────────────────
// TranZak tokens expire after `expiresIn` seconds. We cache the token in
// memory and refresh it 60 s before expiry to avoid mid-request failures.
let _token   = null;
let _expires = 0;

/**
 * Obtain a bearer token, reusing the cached one if still valid.
 * @returns {Promise<string>}
 */
async function getToken() {
  if (_token && Date.now() < _expires) return _token;

  const res = await axios.post(`${BASE_URL}/auth/token`, {
    appId:  process.env.TRANZAK_APP_ID,
    appKey: process.env.TRANZAK_APP_KEY, // field is `appKey`, NOT `apiKey`
  });

  const { token, expiresIn } = res.data.data;
  _token   = token;
  _expires = Date.now() + expiresIn * 1000 - 60_000; // refresh 60 s early
  return _token;
}

/**
 * Create a hosted payment request (TranZak xp021 flow).
 * Returns the URL the customer taps to pay, and the TranZak request ID used
 * to verify the payment later.
 *
 * TranZak field notes:
 *   mchTransactionRef — our order reference (join key between our DB and TranZak)
 *   notificationUrl   — server-to-server webhook (source of truth for payment status)
 *   returnUrl         — browser redirect after checkout (UX only, not authoritative)
 *   paymentAuthUrl    — the hosted checkout URL in the response (not `paymentUrl`)
 *
 * @param {object} params
 * @param {string} params.reference          — unique order reference (e.g. ORD-XXXXXXXX)
 * @param {number} params.amount             — amount in XAF
 * @param {string} params.description        — shown on the TranZak payment page
 * @param {string} params.callbackUrl        — webhook URL (POST on payment success)
 * @param {string} params.returnUrl          — browser redirect URL after payment
 * @param {string} [params.mobileWalletNumber] — pre-fills the customer's MoMo number
 * @returns {Promise<{ transactionId: string, paymentUrl: string }>}
 */
async function createPaymentRequest({ reference, amount, description, callbackUrl, returnUrl, mobileWalletNumber }) {
  const token = await getToken();

  const payload = {
    amount,
    currencyCode:      'XAF',
    description,
    mchTransactionRef: reference,   // our reference — echoed back in the webhook
    notificationUrl:   callbackUrl, // webhook endpoint (server-to-server)
    returnUrl,                      // browser redirect (UX only)
  };
  if (mobileWalletNumber) payload.mobileWalletNumber = mobileWalletNumber;

  const res = await axios.post(
    `${BASE_URL}/xp021/v1/request/create`,
    payload,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  return {
    transactionId: res.data.data.requestId,           // TranZak's internal request ID
    paymentUrl:    res.data.data.links.paymentAuthUrl, // hosted checkout URL
  };
}

/**
 * Verify a payment request by its TranZak request ID.
 * Used in two places:
 *   1. Payment callback (browser redirect) — verify before showing success page
 *   2. Reconciliation cron — re-check any order stuck in "placed" after 5 min
 *
 * Endpoint: GET /xp021/v1/request/details?requestId=...
 * (Not /xp021/v1/request/{id} — that 404s.)
 *
 * @param {string} transactionId — TranZak requestId
 * @returns {Promise<{ paid: boolean }>}
 */
async function verifyTransaction(transactionId) {
  const token = await getToken();

  const res = await axios.get(
    `${BASE_URL}/xp021/v1/request/details`,
    {
      params:  { requestId: transactionId },
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  return { paid: res.data.data.status === 'SUCCESSFUL' };
}

module.exports = { createPaymentRequest, verifyTransaction };
