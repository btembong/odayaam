'use strict';

const cron = require('node-cron');
const { getAllSessions, saveSession } = require('./db');
const { verifyTransaction } = require('./tranzak');
const emitter = require('./emitter');

function startJobs() {
  // ── Payment reconciliation (every 5 min) ──────────────────────────────────
  // Re-verify any order still in "placed" state directly against TranZak.
  // Catches cases where the webhook was missed (network blip, deploy timing).
  cron.schedule('*/5 * * * *', async () => {
    try {
      const sessions = getAllSessions();
      for (const session of sessions) {
        if (!session.orders) continue;
        for (const order of session.orders) {
          if (order.status !== 'placed' || !order.transactionId) continue;

          // Only reconcile orders older than 5 min (give webhook a chance first)
          const ageMs = Date.now() - new Date(order.createdAt).getTime();
          if (ageMs < 5 * 60 * 1000) continue;

          try {
            const { paid } = await verifyTransaction(order.transactionId);
            if (paid) {
              order.status = 'paid';
              saveSession(session);
              console.log(`[reconciliation] Order ${order.reference} marked paid.`);
            }
          } catch (err) {
            console.error(`[reconciliation] Could not verify ${order.reference}:`, err.message);
          }
        }
      }
    } catch (err) {
      console.error('[reconciliation] Job error:', err.message);
    }
  });

  // ── Scheduled-order sweep (every 1 min) ───────────────────────────────────
  // Find paid orders whose scheduledAt time has arrived; emit to kitchen board.
  cron.schedule('* * * * *', () => {
    try {
      const sessions = getAllSessions();
      const now = Date.now();
      for (const session of sessions) {
        if (!session.orders) continue;
        for (const order of session.orders) {
          if (order.status !== 'paid' || !order.scheduledAt || order.notified) continue;

          const due = new Date(order.scheduledAt).getTime();
          if (now < due) continue; // not yet

          order.notified = true;
          saveSession(session);

          console.log(`[scheduled] Order ${order.reference} is due — notifying kitchen.`);
          emitter.emit('kitchen:order_due', {
            reference:    order.reference,
            items:        order.items,
            subtotal:     order.subtotal,
            scheduledFor: order.scheduledFor,
            scheduledAt:  order.scheduledAt,
          });
        }
      }
    } catch (err) {
      console.error('[scheduled] Job error:', err.message);
    }
  });

  // ── Stale-session cleanup (daily at midnight) ─────────────────────────────
  cron.schedule('0 0 * * *', () => {
    try {
      const sessions = getAllSessions();
      const cutoffMs = 30 * 24 * 60 * 60 * 1000; // 30 days
      let cleaned = 0;
      for (const session of sessions) {
        const age = Date.now() - new Date(session.updatedAt).getTime();
        if (age > cutoffMs && session.cart.length === 0 && (!session.orders || session.orders.every(o => o.status !== 'placed'))) {
          // Mark as expired (a real implementation would delete from db)
          session.expired = true;
          saveSession(session);
          cleaned++;
        }
      }
      if (cleaned > 0) console.log(`[cleanup] Marked ${cleaned} stale session(s).`);
    } catch (err) {
      console.error('[cleanup] Job error:', err.message);
    }
  });

  console.log('Background jobs started.');
}

module.exports = { startJobs };
