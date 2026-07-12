'use strict';

/**
 * db.js — MongoDB persistence layer
 *
 * Abstracts all database access behind three functions so the rest of the
 * codebase never imports `mongodb` directly. Swapping the store (e.g. to
 * Postgres) only requires changing this file.
 *
 * Collection: `sessions`
 * Document shape:
 *   { id, step, context, cart, orders, customerInfo?, createdAt, updatedAt }
 *
 * Required env vars:
 *   MONGODB_URI — full connection string (URL-encode special chars in password)
 *   MONGODB_DB  — database name (default: "odayam")
 */

const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME     = process.env.MONGODB_DB || 'odayam';

let _client = null;
let _db     = null;

/**
 * Open (or reuse) the MongoDB connection and return the db handle.
 * Called once at startup in server.js; subsequent calls return the cached handle.
 *
 * @returns {Promise<import('mongodb').Db>}
 */
async function connect() {
  if (_db) return _db;
  _client = new MongoClient(MONGODB_URI);
  await _client.connect();
  _db = _client.db(DB_NAME);
  // Unique index on `id` ensures fast lookups and prevents duplicate documents.
  await _db.collection('sessions').createIndex({ id: 1 }, { unique: true });
  return _db;
}

/**
 * Return an existing session by ID, or create a new blank one.
 * A blank session starts at step MAIN with an empty cart and no orders.
 *
 * @param {string} id — UUID cookie value from the browser
 * @returns {Promise<object>} session document (without MongoDB's `_id`)
 */
async function getSession(id) {
  const db  = await connect();
  const col = db.collection('sessions');
  let session = await col.findOne({ id }, { projection: { _id: 0 } });
  if (!session) {
    session = {
      id,
      step:      'MAIN',
      context:   {},
      cart:      [],
      orders:    [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await col.insertOne({ ...session });
  }
  return session;
}

/**
 * Persist (upsert) a session document.
 * Always stamps `updatedAt` so staleness checks in jobs.js are accurate.
 *
 * @param {object} session — full session object (must have `.id`)
 * @returns {Promise<void>}
 */
async function saveSession(session) {
  const db  = await connect();
  session.updatedAt = new Date().toISOString();
  await db.collection('sessions').updateOne(
    { id: session.id },
    { $set: session },
    { upsert: true }
  );
}

/**
 * Return all session documents.
 * Used by the webhook handler (to find which session owns an order) and by
 * background jobs (reconciliation, scheduled-order sweep, stale cleanup).
 *
 * @returns {Promise<object[]>}
 */
async function getAllSessions() {
  const db = await connect();
  return db.collection('sessions').find({}, { projection: { _id: 0 } }).toArray();
}

module.exports = { connect, getSession, saveSession, getAllSessions };
