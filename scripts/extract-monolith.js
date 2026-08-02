#!/usr/bin/env node
/**
 * One-shot migrator: convert server.js into the TypeScript src/ layout.
 * Route handlers are grouped by path prefix; provider helpers by name prefix.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const lines = src.split('\n');

// Find the body after session middleware / requireAuth definitions and before listen
const startMarker = lines.findIndex((l) => l.includes('// ─── EMBY API HELPER'));
const endMarker = lines.findIndex((l) => l.includes('// ─── START ──'));
if (startMarker < 0 || endMarker < 0) {
  console.error('Could not locate monolith markers', { startMarker, endMarker });
  process.exit(1);
}

// Extract PORTAL_CONFIG_FIELDS block (lines ~39-159)
const configStart = lines.findIndex((l) => l.includes('const PORTAL_CONFIG_FIELDS'));
const configEnd = lines.findIndex((l, i) => i > configStart && l.includes('const PORTAL_CONFIG_BY_KEY'));
const configFieldsBlock = lines.slice(configStart, configEnd).join('\n');

// Helper functions between config and express middleware (settings helpers)
const helpersStart = configEnd;
const helpersEnd = lines.findIndex((l) => l.startsWith('app.use(express.json'));
const earlyHelpers = lines.slice(helpersStart, helpersEnd).join('\n');

// Auth middleware originals — we use src/middleware instead, but keep requireAuth refs working via imports
const bodyLines = lines.slice(startMarker, endMarker);

function routeGroup(routePath) {
  const p = String(routePath || '');
  if (p.startsWith('/auth') || p === '/logout' || p === '/no-account' || p === '/api/forgot-password' || p.startsWith('/api/reset-password') || p === '/reset-password') return 'auth';
  if (p.startsWith('/api/admin') || p === '/admin' || p === '/admin.html') return 'admin';
  if (p.startsWith('/api/seerr') || p === '/seerr') return 'seerr';
  if (p.startsWith('/api/libraries') || p.startsWith('/api/library') || p === '/libraries' || p.startsWith('/api/my-books') || p.startsWith('/api/shelfmark') || p.startsWith('/api/comicvine') || p.startsWith('/opds') || p.startsWith('/api/opds')) return 'libraries';
  if (p.startsWith('/api/reader') || p === '/reader' || p === '/audio-reader' || p.startsWith('/api/my-requests')) return 'readers';
  if (p.startsWith('/api/push') || p.startsWith('/api/server-status') || p.startsWith('/api/downtime')) return 'push';
  if (p === '/dashboard' || p.startsWith('/api/account') || p.startsWith('/api/') || p === '/' || p.startsWith('/speedtest')) return 'dashboard';
  return 'dashboard';
}

function serviceForFn(name) {
  const n = name.toLowerCase();
  if (n.startsWith('emby')) return 'emby';
  if (n.startsWith('silo')) return 'silo';
  if (n.startsWith('jellyfin')) return 'jellyfin';
  if (n.startsWith('plex')) return 'plex';
  if (n.startsWith('seerr') || n.includes('seerr')) return 'seerr';
  if (n.startsWith('kavita') || n.startsWith('opds') || n.startsWith('comic')) return 'kavita';
  if (n.includes('arr') || n.startsWith('radarr') || n.startsWith('sonarr') || n.includes('arrinstance') || n.includes('arrpolic')) return 'arr';
  if (n.includes('mail') || n.includes('kindle') || n.includes('resend') || n.includes('email')) return 'email';
  if (n.includes('discord')) return 'discord';
  return null;
}

// Build shared.ts with config + early helpers + all non-route function declarations from body
// Strategy: put ENTIRE body into shared registration via createPortalApp internals split by route files
// that each receive `(app, ctx)` where ctx has all helpers.

const HEADER = `/* eslint-disable */
// Auto-migrated from server.js — preserve /api contracts.
import type { Express, Request, Response, NextFunction } from 'express';
import axios from 'axios';
import fs from 'fs';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import zlib from 'zlib';
import { pipeline } from 'stream/promises';
import type { PortalDatabase } from '../db';
import { requireAuth, requireAdmin, requireLibraryAccess } from '../middleware';
import { featureEnabled } from '../config/env';

`;

// We'll generate one big shared module with all helpers + a register function per domain
// that contains the route handlers for that domain.

const routeBuckets = {
  auth: [],
  dashboard: [],
  seerr: [],
  libraries: [],
  admin: [],
  readers: [],
  push: [],
};

// Walk body lines; accumulate "chunks" that are either functions or route handlers
let i = 0;
const helperChunks = [];
const pending = [];

function flushPendingToHelpers() {
  if (pending.length) {
    helperChunks.push(pending.join('\n'));
    pending.length = 0;
  }
}

while (i < bodyLines.length) {
  const line = bodyLines[i];
  const routeMatch = line.match(/^app\.(get|post|put|delete|use|all)\((\[)/)
    || line.match(/^app\.(get|post|put|delete|use|all)\((['\`])([^'\`]+)\2/);

  // Multi-path app.use([...]) already handled in middleware — skip library gate if present
  if (line.startsWith('app.use([') && bodyLines[i + 1] && bodyLines[i + 1].includes('/api/library')) {
    // skip until closing ); of this use
    while (i < bodyLines.length && !bodyLines[i].includes('requireLibraryAccess')) i++;
    i++;
    continue;
  }

  if (routeMatch && !line.match(/^app\.use\(\[/)) {
    flushPendingToHelpers();
    // capture route block until line that is `});` at depth 0 matching this app.X
    let block = [line];
    let depth = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
    // Also handle single-line routes
    if (depth <= 0 && line.includes('});')) {
      // single line
    } else {
      i++;
      while (i < bodyLines.length) {
        block.push(bodyLines[i]);
        depth += (bodyLines[i].match(/{/g) || []).length - (bodyLines[i].match(/}/g) || []).length;
        if (depth <= 0) break;
        i++;
      }
    }
    const blockText = block.join('\n');
    const pathMatch = blockText.match(/app\.(?:get|post|put|delete|use|all)\(\s*(['\`])([^'\`]+)\1/)
      || blockText.match(/app\.(?:get|post|put|delete|use|all)\(\s*\[/);
    let group = 'dashboard';
    if (pathMatch && pathMatch[2]) group = routeGroup(pathMatch[2]);
    else if (blockText.includes('/api/library') || blockText.includes('/libraries')) group = 'libraries';
    routeBuckets[group].push(blockText);
    i++;
    continue;
  }

  pending.push(line);
  i++;
}
flushPendingToHelpers();

const sharedBody = helperChunks.join('\n')
  // Fix HMAC fallback
  .replace(/process\.env\.SESSION_SECRET\s*\|\|\s*'opds-cover-secret'/g, 'process.env.SESSION_SECRET')
  // __dirname for public assets — use process.cwd()
  .replace(/path\.join\(__dirname,\s*'public'/g, "path.join(process.cwd(), 'public'")
  .replace(/path\.join\(__dirname,\s*"public"/g, 'path.join(process.cwd(), "public"');

const earlyHelpersFixed = earlyHelpers
  .replace(/path\.join\(__dirname/g, 'path.join(process.cwd()');

fs.mkdirSync(path.join(root, 'src/portal'), { recursive: true });
fs.mkdirSync(path.join(root, 'src/routes'), { recursive: true });
fs.mkdirSync(path.join(root, 'src/services'), { recursive: true });
fs.mkdirSync(path.join(root, 'src/config'), { recursive: true });

// Write config fields
fs.writeFileSync(path.join(root, 'src/config/fields.ts'), `${configFieldsBlock}\n\nexport { PORTAL_CONFIG_FIELDS };\n`);

// Write shared portal module with helpers + settings state
const sharedModule = `${HEADER}
export type PortalContext = {
  db: PortalDatabase;
  app: Express;
};

${configFieldsBlock}
export const PORTAL_CONFIG_BY_KEY = new Map(PORTAL_CONFIG_FIELDS.map(field => [field.key, field]));
export const ARR_INSTANCES_KEY = 'ARR_INSTANCES_JSON';
export const ARR_POLICIES_KEY = 'ARR_REQUEST_POLICIES_JSON';
export let portalSettings = new Map<string, string>();
export let settingsReady: Promise<void> = Promise.resolve();

let webpush: any = null;
try {
  webpush = require('web-push');
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
      \`mailto:\${process.env.PORTAL_ADMIN_EMAIL || 'admin@example.invalid'}\`,
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
    console.log('[push] Web push enabled');
  } else {
    webpush = null;
  }
} catch (e) { webpush = null; }

export const EMBY_STATS_CACHE = new Map();

function authProviderEnabled(key: string, fallback = false) {
  return featureEnabled(key, fallback);
}

function configPresent(...keys: string[]) {
  return keys.every(key => Boolean(String(process.env[key] || portalSettings.get(key) || '').trim()));
}

${earlyHelpersFixed}

// Mutable legacy bindings refreshed after settings load
export let RESEND_API_KEY = process.env.RESEND_API_KEY || '';
export let PORTAL_URL = process.env.PORTAL_URL || '';
export let BW_BASE = process.env.BOOKWAREHOUSE_URL || '';
export let SM_URL = process.env.SHELFMARK_URL || '';
export let SM_USER = process.env.SHELFMARK_USER || '';
export let SM_PASS = process.env.SHELFMARK_PASS || '';
export let BOOKS_DIR = process.env.BOOKS_DIR || '';
export let HC_API_KEY = process.env.HARDCOVER_API_KEY || '';
export let CV_API_KEY = process.env.COMICVINE_API_KEY || '';
export let DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || '';
export let BOOKS_FINISH_THRESHOLD = 0.95;

${sharedBody}

export function bindSharedExports(ctx: PortalContext) {
  return {
    portalSettings,
    settingsReady,
    loadPortalSettings,
    webpush,
    requireAuth,
    requireAdmin,
    requireLibraryAccess,
  };
}
`;

// The early helpers already define loadPortalSettings etc. — but they reference `db` which won't exist.
// We need to change the approach: shared module exports a factory `createPortalShared(db)`.

console.log('Route bucket sizes:', Object.fromEntries(Object.entries(routeBuckets).map(([k, v]) => [k, v.length])));
console.log('Helper chunk chars:', sharedBody.length);
console.log('Early helpers chars:', earlyHelpersFixed.length);

// Write a debug dump of buckets for the next step
fs.writeFileSync(path.join(root, 'scripts/.route-buckets.json'), JSON.stringify({
  counts: Object.fromEntries(Object.entries(routeBuckets).map(([k, v]) => [k, v.length])),
  samples: Object.fromEntries(Object.entries(routeBuckets).map(([k, v]) => [k, v.slice(0, 2).map(s => s.slice(0, 120))])),
}, null, 2));

// Persist raw buckets for generate step 2
for (const [name, blocks] of Object.entries(routeBuckets)) {
  fs.writeFileSync(path.join(root, `scripts/.bucket-${name}.js.txt`), blocks.join('\n\n'));
}
fs.writeFileSync(path.join(root, 'scripts/.helpers.js.txt'), sharedBody);
fs.writeFileSync(path.join(root, 'scripts/.early-helpers.js.txt'), earlyHelpersFixed);
fs.writeFileSync(path.join(root, 'scripts/.config-fields.js.txt'), configFieldsBlock);

console.log('Wrote intermediate extraction artifacts to scripts/.');
