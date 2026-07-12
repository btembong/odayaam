'use strict';

const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME     = process.env.MONGODB_DB || 'odayam';

let _client = null;
let _db     = null;

async function connect() {
  if (_db) return _db;
  _client = new MongoClient(MONGODB_URI);
  await _client.connect();
  _db = _client.db(DB_NAME);
  // Ensure index on id field for fast lookups
  await _db.collection('sessions').createIndex({ id: 1 }, { unique: true });
  return _db;
}

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

async function saveSession(session) {
  const db  = await connect();
  session.updatedAt = new Date().toISOString();
  await db.collection('sessions').updateOne(
    { id: session.id },
    { $set: session },
    { upsert: true }
  );
}

async function getAllSessions() {
  const db = await connect();
  return db.collection('sessions').find({}, { projection: { _id: 0 } }).toArray();
}

module.exports = { connect, getSession, saveSession, getAllSessions };
