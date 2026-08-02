#!/usr/bin/env node
/**
 * Compatibility shim. Portal 2.0 runs from dist/index.js (TypeScript build).
 * Prefer: npm run build && npm start
 */
'use strict';
require('dotenv').config();
try {
  require('./dist/index.js');
} catch (error) {
  console.error('[portal] Failed to load dist/index.js. Run `npm run build` first.');
  console.error(error);
  process.exit(1);
}
