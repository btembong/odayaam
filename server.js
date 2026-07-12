'use strict';

/**
 * server.js — Express HTTP server
 *
 * Routes:
 *   GET  /api/session/init        — return MAIN menu for a new/returning session
 *   POST /api/chat                — main FSM message handler
 *   GET  /api/session/stream      — SSE: real-time payment confirmation to browser
 *   POST /api/session/reset       — reset step to MAIN (called by frontend after SSE)
 *   GET  /api/payment/callback    — browser redirect from TranZak (UX only)
 *   POST /api/payment/webhook     — TranZak server-to-server notification (authoritative)
 *   GET  /api/kitchen/orders      — all scheduled orders for initial board load
 *   GET  /api/kitchen/stream      — SSE: real-time kitchen notice board updates
 *
 * Payment confirmation flow:
 *   1. Customer pays on TranZak hosted checkout.
 *   2. TranZak POSTs to /api/payment/webhook (server-to-server, source of truth).
 *   3. Webhook re-verifies with TranZak, marks order paid, pushes SSE to browser.
 *   4. Browser redirect hits /api/payment/callback (UX only — not authoritative).
 *
 * Connects to MongoDB before starting the HTTP listener. If the DB connection
 * fails the process exits so the host (Render) restarts it.
 */

require('dotenv').config();

const express      = require('express');
const cookieParser = require('cookie-parser');
const path         = require('path');
const { v4: uuidv4 } = require('uuid');

const { handleMessage, getWelcome } = require('./bot');
const { connect, getSession, saveSession, getAllSessions } = require('./db');
const { verifyTransaction } = require('./tranzak');
const { startJobs } = require('./jobs');
const emitter = require('./emitter');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── SSE client registries ─────────────────────────────────────────────────────
// Each open browser tab holds a long-lived HTTP response object.
// When a payment webhook arrives, we look up the matching session's response
// and push a `payment_confirmed` event — no polling required.
const sseClients     = new Map(); // sessionId → res  (customer payment confirmations)
const kitchenClients = new Set(); // res[]             (kitchen notice board connections)

function pushSSE(sessionId, event, data) {
  const client = sseClients.get(sessionId);
  if (client) client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function pushKitchen(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of kitchenClients) res.write(msg);
}

// Forward job events to all open kitchen boards
emitter.on('kitchen:order_due', (order) => pushKitchen('order_due', order));

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cookieParser());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Session helper ────────────────────────────────────────────────────────────
function ensureSessionId(req, res) {
  let id = req.cookies.rc_session;
  if (!id) {
    id = uuidv4();
    res.cookie('rc_session', id, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 365 * 24 * 60 * 60 * 1000,
    });
  }
  return id;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Initial welcome message
app.get('/api/session/init', async (req, res) => {
  const sessionId = ensureSessionId(req, res);
  res.json(await getWelcome(sessionId));
});

// Chat message
app.post('/api/chat', async (req, res) => {
  try {
    const sessionId = ensureSessionId(req, res);
    const { message } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ reply: 'Invalid message.' });
    }

    const result = await handleMessage(sessionId, message.trim());
    res.json(result);
  } catch (err) {
    console.error('[/api/chat]', err);
    res.status(500).json({ reply: 'Something went wrong. Please try again.' });
  }
});

// SSE stream — keep-alive connection for real-time push
app.get('/api/session/stream', (req, res) => {
  const sessionId = req.cookies.rc_session;
  if (!sessionId) return res.status(401).end();

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  // Confirm connection
  res.write('event: connected\ndata: {}\n\n');

  // Heartbeat every 25 s to prevent proxy/browser timeouts
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25_000);

  sseClients.set(sessionId, res);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(sessionId);
  });
});

// Payment callback — browser redirect from TranZak after payment attempt
app.get('/api/payment/callback', async (req, res) => {
  const { ref } = req.query;
  const sessionId = req.cookies.rc_session;
  let flag = 'pending';

  if (ref && sessionId) {
    try {
      const session = await getSession(sessionId);
      const order   = session.orders?.find(o => o.reference === ref);
      if (order) {
        if (order.status === 'paid') {
          flag = 'success';
        } else if (order.transactionId) {
          // Webhook may not have arrived yet — verify directly
          const { paid } = await verifyTransaction(order.transactionId);
          if (paid) {
            order.status    = 'paid';
            session.step    = 'MAIN';
            session.context = {};
            await saveSession(session);
            pushSSE(sessionId, 'payment_confirmed', { reference: order.reference, amount: order.subtotal });
            flag = 'success';
          }
        }
      }
    } catch (err) {
      console.error('[callback] verify error:', err.message);
    }
  }

  res.redirect(`/?payment=${flag}&ref=${ref || ''}`);
});

// Payment webhook — TranZak server-to-server notification (source of truth)
// express.raw() is used instead of express.json() because TranZak may send
// a Content-Type that doesn't match `application/json`. We parse manually.
app.post('/api/payment/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  // Respond 200 immediately — TranZak retries on any non-2xx, so we must
  // acknowledge receipt before doing any async work.
  res.status(200).json({ received: true });

  try {
    const body = JSON.parse(req.body.toString('utf8'));
    const data          = body.data || body;
    // TranZak sends mchTransactionRef as the merchant reference field
    const merchantRef   = data.mchTransactionRef || data.merchantReference || data.merchant_reference;
    const transactionId = data.requestId         || data.request_id;
    const webhookStatus = (data.status || '').toUpperCase();

    if (webhookStatus !== 'SUCCESSFUL') return;

    // Find the matching order across all sessions
    const sessions = await getAllSessions();
    for (const session of sessions) {
      if (!session.orders) continue;
      const order = session.orders.find(o => o.reference === merchantRef && o.status === 'placed');
      if (!order) continue;

      // Re-verify directly with TranZak before marking paid.
      // This guards against spoofed webhook calls and makes the handler idempotent
      // (safe to call multiple times for the same transaction).
      try {
        const { paid } = await verifyTransaction(transactionId || order.transactionId);
        if (paid) {
          order.status    = 'paid';
          session.step    = 'MAIN';
          session.context = {};
          await saveSession(session);
          console.log(`[webhook] Order ${order.reference} marked paid.`);

          // Push real-time confirmation to any open browser tab for this session
          pushSSE(session.id, 'payment_confirmed', {
            reference: order.reference,
            amount:    order.subtotal,
          });
        }
      } catch (err) {
        console.error('[webhook] Verify error:', err.message);
      }

      break;
    }
  } catch (err) {
    console.error('[webhook] Parse error:', err.message);
  }
});

// Session step reset — called by frontend after payment_confirmed SSE
app.post('/api/session/reset', async (req, res) => {
  const sessionId = req.cookies.rc_session;
  if (!sessionId) return res.status(401).end();
  const session   = await getSession(sessionId);
  session.step    = 'MAIN';
  session.context = {};
  await saveSession(session);
  res.json({ ok: true });
});

// ── Kitchen notice board ──────────────────────────────────────────────────────

// All scheduled orders (paid, with a scheduledAt) — for initial board load
app.get('/api/kitchen/orders', async (req, res) => {
  const sessions = await getAllSessions();
  const orders = [];
  const now = Date.now();
  for (const session of sessions) {
    if (!session.orders) continue;
    for (const order of session.orders) {
      if (!order.scheduledAt) continue;
      orders.push({
        reference:    order.reference,
        items:        order.items,
        subtotal:     order.subtotal,
        scheduledFor: order.scheduledFor,
        scheduledAt:  order.scheduledAt,
        status:       order.status,
        notified:     order.notified || false,
        dueNow:       order.notified && now >= new Date(order.scheduledAt).getTime(),
      });
    }
  }
  orders.sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
  res.json(orders);
});

// SSE stream for kitchen board — pushes order_due events in real time
app.get('/api/kitchen/stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  res.write('event: connected\ndata: {}\n\n');
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25_000);

  kitchenClients.add(res);
  req.on('close', () => {
    clearInterval(heartbeat);
    kitchenClients.delete(res);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
connect()
  .then(() => {
    console.log('MongoDB connected.');
    startJobs();
    app.listen(PORT, () => console.log(`Odayam running → http://localhost:${PORT}`));
  })
  .catch(err => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });
