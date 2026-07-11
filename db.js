'use strict';

const fs   = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'db.json');

function readDB() {
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function getSession(id) {
  const db = readDB();
  if (!db.sessions[id]) {
    db.sessions[id] = {
      id,
      step: 'MAIN',
      context: {},
      cart: [],
      orders: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeDB(db);
  }
  return db.sessions[id];
}

function saveSession(session) {
  const db = readDB();
  session.updatedAt = new Date().toISOString();
  db.sessions[session.id] = session;
  writeDB(db);
}

function getAllSessions() {
  return Object.values(readDB().sessions);
}

module.exports = { getSession, saveSession, getAllSessions };
