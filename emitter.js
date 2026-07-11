'use strict';

// Shared in-process event bus.
// Lets jobs.js signal server.js without creating a circular require.
const { EventEmitter } = require('events');
module.exports = new EventEmitter();
