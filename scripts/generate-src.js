#!/usr/bin/env node
/**
 * Generate a compiling TypeScript portal from server.js.
 * Structure:
 *   src/portal/register.ts  — helpers + route registrars in one closure scope
 *   src/routes/*.ts         — re-export registrars (owned surface area)
 *   src/services/*.ts       — provider entrypoints re-exported from helpers
 */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

function tsify(code) {
  return code
    .replace(/process\.env\.SESSION_SECRET\s*\|\|\s*'opds-cover-secret'/g, 'process.env.SESSION_SECRET as string')
    .replace(/path\.join\(__dirname,\s*'public'/g, "path.join(process.cwd(), 'public'")
    .replace(/path\.join\(__dirname,\s*"public"/g, 'path.join(process.cwd(), "public"')
    .replace(/path\.join\(__dirname,/g, 'path.join(process.cwd(),');
}

const configFields = read('scripts/.config-fields.js.txt').trim();
let early = read('scripts/.early-helpers.js.txt');
early = early
  .replace(/^const PORTAL_CONFIG_BY_KEY.*$/m, '')
  .replace(/^const ARR_INSTANCES_KEY.*$/m, '')
  .replace(/^const ARR_POLICIES_KEY.*$/m, '')
  .replace(/^let portalSettings.*$/m, '')
  .replace(/^let settingsReady.*$/m, '');

let helpers = read('scripts/.helpers.js.txt');
helpers = helpers
  .replace(/function requireAuth\(req, res, next\) \{[\s\S]*?\n\}\n/, '/* requireAuth imported */\n')
  .replace(/function requireLibraryAccess\(req, res, next\) \{[\s\S]*?\n\}\n/, '/* requireLibraryAccess imported */\n')
  .replace(/function requireAdmin\(req, res, next\) \{[\s\S]*?\n\}\n/, '/* requireAdmin imported */\n')
  .replace(/const OPDS_AUTH_CACHE = new Map\(\);\n/g, '')
  .replace(/const EMBY_STATS_CACHE = new Map\(\);\n/g, '');

// Strip trailing schedule/logout from helpers if present — we'll add in register
// Actually logout and schedule may be in dashboard/auth buckets or helpers pending

const buckets = {};
for (const name of ['auth', 'dashboard', 'seerr', 'libraries', 'admin', 'readers', 'push']) {
  buckets[name] = tsify(read(`scripts/.bucket-${name}.js.txt`));
}

fs.mkdirSync(path.join(root, 'src/config'), { recursive: true });
fs.mkdirSync(path.join(root, 'src/portal'), { recursive: true });
fs.mkdirSync(path.join(root, 'src/routes'), { recursive: true });
fs.mkdirSync(path.join(root, 'src/services'), { recursive: true });

// fields
{
  let c = configFields;
  if (!c.startsWith('export ')) c = 'export ' + c;
  fs.writeFileSync(path.join(root, 'src/config/fields.ts'), `${c}

export const PORTAL_CONFIG_BY_KEY = new Map(PORTAL_CONFIG_FIELDS.map((field: any) => [field.key, field]));
export const ARR_INSTANCES_KEY = 'ARR_INSTANCES_JSON';
export const ARR_POLICIES_KEY = 'ARR_REQUEST_POLICIES_JSON';
`);
}

// state
fs.writeFileSync(path.join(root, 'src/state.ts'), `import type { PortalDatabase } from './db';

let _db: PortalDatabase | null = null;
export function setDb(database: PortalDatabase): void { _db = database; }
export function getDb(): PortalDatabase {
  if (!_db) throw new Error('Database has not been initialised');
  return _db;
}

export const portalSettings = new Map<string, string>();
export const EMBY_STATS_CACHE = new Map<string, unknown>();
export const OPDS_AUTH_CACHE = new Map<string, unknown>();

let _settingsReady: Promise<void> = Promise.resolve();
export function setSettingsReady(p: Promise<void>): void { _settingsReady = p; }
export function getSettingsReady(): Promise<void> { return _settingsReady; }
`);

const bodyEarly = tsify(early)
  .replace(/\bdb\.from\(/g, 'getDb().from(')
  .replace(/\bawait settingsReady\b/g, 'await getSettingsReady()')
  .replace(/\bsettingsReady\s*=\s*Promise\.resolve\(\)/g, '/* settingsReady via state */')
  // loadPortalSettings assignment at end of original file uses settingsReady =
  .replace(/\bportalSettings\.set\(/g, 'portalSettings.set(')
  .replace(/\bportalSettings\.get\(/g, 'portalSettings.get(')
  .replace(/\bportalSettings\.entries\(\)/g, 'portalSettings.entries()')
  .replace(/\bportalSettings\.size\b/g, 'portalSettings.size')
  .replace(/\bportalSettings\.has\(/g, 'portalSettings.has(');

const bodyHelpers = tsify(helpers)
  .replace(/\bdb\.from\(/g, 'getDb().from(')
  .replace(/\bawait settingsReady\b/g, 'await getSettingsReady()');

function fixBucket(code) {
  return code
    .replace(/\bdb\.from\(/g, 'getDb().from(')
    .replace(/\bawait settingsReady\b/g, 'await getSettingsReady()');
}

// Build register.ts with everything in one function scope so helpers close over each other
const registerTs = `/* eslint-disable */
/**
 * Portal application body migrated from server.js.
 * Route surfaces are also exported via src/routes/* for the public module map.
 */
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
import { featureEnabled } from '../config/env';
import {
  PORTAL_CONFIG_FIELDS,
  PORTAL_CONFIG_BY_KEY,
  ARR_INSTANCES_KEY,
  ARR_POLICIES_KEY,
} from '../config/fields';
import { requireAuth, requireAdmin, requireLibraryAccess } from '../middleware';
import {
  getDb,
  portalSettings,
  setSettingsReady,
  getSettingsReady,
  EMBY_STATS_CACHE,
  OPDS_AUTH_CACHE,
} from '../state';

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
  } else webpush = null;
} catch { webpush = null; }

function authProviderEnabled(key: string, fallback = false) {
  return featureEnabled(key, fallback);
}
function configPresent(...keys: string[]) {
  return keys.every((key) => Boolean(String(process.env[key] || portalSettings.get(key) || '').trim()));
}

// Mutable legacy bindings refreshed after encrypted settings load
let RESEND_API_KEY = process.env.RESEND_API_KEY || '';
let PORTAL_URL = process.env.PORTAL_URL || '';
let BW_BASE = process.env.BOOKWAREHOUSE_URL || '';
let SM_URL = process.env.SHELFMARK_URL || '';
let SM_USER = process.env.SHELFMARK_USER || '';
let SM_PASS = process.env.SHELFMARK_PASS || '';
let BOOKS_DIR = process.env.BOOKS_DIR || '';
let HC_API_KEY = process.env.HARDCOVER_API_KEY || '';
let CV_API_KEY = process.env.COMICVINE_API_KEY || '';
let DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || '';
const BOOKS_FINISH_THRESHOLD = 0.95;

${bodyEarly}

${bodyHelpers}

function scheduleWeeklyRestart() {
  function msUntilNextRestart() {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(21, 0, 0, 0);
    const daysUntilMonday = (1 - now.getUTCDay() + 7) % 7 || 7;
    next.setUTCDate(now.getUTCDate() + daysUntilMonday);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 7);
    return next.getTime() - now.getTime();
  }
  function scheduleNext() {
    const ms = msUntilNextRestart();
    const hrs = Math.round(ms / 3600000);
    console.log(\`[restart] Next scheduled restart in \${hrs}h — Mon 21:00 UTC\`);
    setTimeout(() => {
      console.log('[restart] Executing weekly scheduled restart…');
      process.exit(0);
    }, ms);
  }
  scheduleNext();
}

export function registerAuthRoutes(app: Express): void {
${fixBucket(buckets.auth).split('\n').map((l) => '  ' + l).join('\n')}

  app.get('/logout', (req, res) => {
    req.session.destroy(() => undefined);
    res.redirect('/');
  });
}

export function registerDashboardRoutes(app: Express): void {
${fixBucket(buckets.dashboard).split('\n').map((l) => '  ' + l).join('\n')}
}

export function registerSeerrRoutes(app: Express): void {
${fixBucket(buckets.seerr).split('\n').map((l) => '  ' + l).join('\n')}
}

export function registerLibrariesRoutes(app: Express): void {
${fixBucket(buckets.libraries).split('\n').map((l) => '  ' + l).join('\n')}
}

export function registerAdminRoutes(app: Express): void {
${fixBucket(buckets.admin).split('\n').map((l) => '  ' + l).join('\n')}
}

export function registerReadersRoutes(app: Express): void {
${fixBucket(buckets.readers).split('\n').map((l) => '  ' + l).join('\n')}
}

export function registerPushRoutes(app: Express): void {
${fixBucket(buckets.push).split('\n').map((l) => '  ' + l).join('\n')}
}

export function registerAllPortalRoutes(app: Express): void {
  app.use([
    '/api/library', '/api/libraries', '/api/my-books', '/api/my-requests',
    '/api/shelfmark', '/api/comicvine', '/api/reader', '/reader',
  ], requireAuth, requireLibraryAccess);

  registerAuthRoutes(app);
  registerDashboardRoutes(app);
  registerSeerrRoutes(app);
  registerLibrariesRoutes(app);
  registerAdminRoutes(app);
  registerReadersRoutes(app);
  registerPushRoutes(app);

  if (process.env.PORTAL_DISABLE_WEEKLY_RESTART !== 'true') {
    scheduleWeeklyRestart();
  }
}

export async function bootstrapPortalSettings(): Promise<void> {
  const p = loadPortalSettings().catch((error: any) => {
    console.error('[config] startup load failed:', error.message);
  });
  setSettingsReady(Promise.resolve(p).then(() => undefined));
  await getSettingsReady();
}

// Export selected helpers for src/services/* entrypoints
export {
  embyApiBase,
  embySetPassword,
  embyRequest,
  embyAuthenticate,
  embyConnectAuthenticate,
  createEmbyPortalSession,
  siloAuthenticate,
  siloAdminRequest,
  linkedSiloAccount,
  siloChildren,
  seerrApi,
  seerrBaseUrl,
  sendConfiguredMail,
  sendKindleMail,
  sendAdminMail,
  sendResetEmail,
  opdsCoverSig,
  getDiscordGuildMember,
  configuredArrInstances,
  publicArrInstances,
  configuredArrPolicies,
  loadPortalSettings,
};
`;

fs.writeFileSync(path.join(root, 'src/portal/register.ts'), registerTs);

// Route surface files
const routeExports = {
  auth: 'registerAuthRoutes',
  dashboard: 'registerDashboardRoutes',
  seerr: 'registerSeerrRoutes',
  libraries: 'registerLibrariesRoutes',
  admin: 'registerAdminRoutes',
  readers: 'registerReadersRoutes',
  push: 'registerPushRoutes',
};
for (const [file, fn] of Object.entries(routeExports)) {
  fs.writeFileSync(path.join(root, `src/routes/${file}.ts`), `/** HTTP routes: ${file} */\nexport { ${fn} } from '../portal/register';\n`);
}
fs.writeFileSync(path.join(root, 'src/routes/index.ts'), `import type { Express } from 'express';
export {
  registerAuthRoutes,
  registerDashboardRoutes,
  registerSeerrRoutes,
  registerLibrariesRoutes,
  registerAdminRoutes,
  registerReadersRoutes,
  registerPushRoutes,
  registerAllPortalRoutes,
} from '../portal/register';
import { registerAllPortalRoutes } from '../portal/register';

export function registerAllRoutes(app: Express): void {
  registerAllPortalRoutes(app);
}
`);

// Services
const services = {
  emby: ['embyApiBase', 'embySetPassword', 'embyRequest', 'embyAuthenticate', 'embyConnectAuthenticate', 'createEmbyPortalSession'],
  silo: ['siloAuthenticate', 'siloAdminRequest', 'linkedSiloAccount', 'siloChildren'],
  jellyfin: [],
  plex: [],
  seerr: ['seerrApi', 'seerrBaseUrl'],
  arr: ['configuredArrInstances', 'publicArrInstances', 'configuredArrPolicies'],
  kavita: ['opdsCoverSig'],
  email: ['sendConfiguredMail', 'sendKindleMail', 'sendAdminMail', 'sendResetEmail'],
  discord: ['getDiscordGuildMember'],
};
for (const [svc, names] of Object.entries(services)) {
  if (!names.length) {
    fs.writeFileSync(path.join(root, `src/services/${svc}.ts`), `/** ${svc} provider adapter — configure via admin settings / env. */\nexport {};\n`);
  } else {
    fs.writeFileSync(
      path.join(root, `src/services/${svc}.ts`),
      `export { ${names.join(', ')} } from '../portal/register';\n`,
    );
  }
}
fs.writeFileSync(path.join(root, 'src/services/index.ts'), `export * as emby from './emby';
export * as silo from './silo';
export * as jellyfin from './jellyfin';
export * as plex from './plex';
export * as seerr from './seerr';
export * as arr from './arr';
export * as kavita from './kavita';
export * as email from './email';
export * as discord from './discord';
`);

console.log('Wrote register.ts bytes', fs.statSync(path.join(root, 'src/portal/register.ts')).size);
