'use strict';

/**
 * TranZak payment adapter.
 * Docs: https://docs.developer.tranzak.me
 *
 * Set in your .env:
 *   TRANZAK_APP_ID  — your App ID from the TranZak dashboard
 *   TRANZAK_APP_KEY — your API key
 *   TRANZAK_ENV     — "sandbox" | "production"
 */

const axios = require('axios');

const BASE_URL = process.env.TRANZAK_ENV === 'production'
  ? 'https://dsapi.tranzak.me'
  : 'https://sandbox.dsapi.tranzak.me';

// Simple in-memory token cache
let _token   = null;
let _expires = 0;

async function getToken() {
  if (_token && Date.now() < _expires) return _token;

  const res = await axios.post(`${BASE_URL}/auth/token`, {
    appId:  process.env.TRANZAK_APP_ID,
    appKey: process.env.TRANZAK_APP_KEY,
  });

  const { token, expiresIn } = res.data.data;
  _token   = token;
  _expires = Date.now() + expiresIn * 1000 - 60_000;
  return _token;
}

/**
 * Create a hosted payment request.
 * Returns { transactionId, paymentUrl }
 */
async function createPaymentRequest({ reference, amount, description, callbackUrl, returnUrl, mobileWalletNumber }) {
  const token = await getToken();

  const payload = {
    amount,
    currencyCode:      'XAF',
    description,
    mchTransactionRef: reference,
    notificationUrl:   callbackUrl,
    returnUrl,
  };
  if (mobileWalletNumber) payload.mobileWalletNumber = mobileWalletNumber;

  const res = await axios.post(
    `${BASE_URL}/xp021/v1/request/create`,
    payload,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  return {
    transactionId: res.data.data.requestId,
    paymentUrl:    res.data.data.links.paymentAuthUrl,
  };
}

/**
 * Verify a transaction by ID.
 * Returns { paid: boolean }
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
