require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { createDatabase } = require('./db');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

// Web Push (optional — only active if VAPID keys are set)
let webpush = null;
try {
  webpush = require('web-push');
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
      `mailto:${process.env.PORTAL_ADMIN_EMAIL || 'admin@example.invalid'}`,
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
    console.log('[push] Web push enabled');
  } else {
    webpush = null;
  }
} catch(e) { webpush = null; }

const app = express();
const db = createDatabase();
const EMBY_STATS_CACHE = new Map();

// Provider configuration is intentionally allow-listed and stored outside the
// source tree. Secrets are encrypted before they are written to PostgreSQL.
// CONFIG_ENCRYPTION_KEY is a bootstrap secret and must remain an environment
// variable (it is never exposed by the admin API).
const PORTAL_CONFIG_FIELDS = [
  { key: 'PORTAL_NAME', label: 'Server name', category: 'Core', type: 'text', secret: false },
  { key: 'PORTAL_WELCOME_MESSAGE', label: 'Welcome message', category: 'Core', type: 'text', secret: false },
  { key: 'PORTAL_LOGO_URL', label: 'Server logo', category: 'Core', type: 'text', secret: false },
  { key: 'PORTAL_FAVICON_URL', label: 'Favicon', category: 'Core', type: 'text', secret: false },
  { key: 'PORTAL_URL', label: 'Base URL (Portal URL)', category: 'Core', type: 'url', secret: false },
  { key: 'EMBYLINK_PUBLIC_URL', label: 'EmbyLink public URL', category: 'Core', type: 'url', secret: false },
  { key: 'AUTH_FORCE_OAUTH_LOGIN', label: 'Force OAuth login', category: 'Authentication & Access', type: 'toggle', secret: false },
  { key: 'AUTH_DISCORD_ENABLED', label: 'Enable Discord login', category: 'Authentication & Access', type: 'toggle', secret: false },
  { key: 'AUTH_WHMCS_ENABLED', label: 'Enable WHMCS login', category: 'Authentication & Access', type: 'toggle', secret: false },
  { key: 'AUTH_WHMCS_URL', label: 'WHMCS login URL', category: 'Authentication & Access', type: 'url', secret: false },
  { key: 'AUTH_WHMCS_CLIENT_ID', label: 'WHMCS client ID', category: 'Authentication & Access', type: 'text', secret: false },
  { key: 'AUTH_WHMCS_CLIENT_SECRET', label: 'WHMCS client secret', category: 'Authentication & Access', type: 'password', secret: true },
  { key: 'AUTH_EMBY_CONNECT_ENABLED', label: 'Enable Emby Connect login', category: 'Authentication & Access', type: 'toggle', secret: false },
  { key: 'AUTH_EMBY_CONNECT_URL', label: 'Emby Connect login URL', category: 'Authentication & Access', type: 'url', secret: false },
  { key: 'DISCORD_CLIENT_ID', label: 'Discord client ID', category: 'Discord', type: 'text', secret: false },
  { key: 'DISCORD_CLIENT_SECRET', label: 'Discord client secret', category: 'Discord', type: 'password', secret: true },
  { key: 'DISCORD_REDIRECT_URI', label: 'Discord redirect URI', category: 'Discord', type: 'url', secret: false },
  { key: 'DISCORD_GUILD_ID', label: 'Discord guild ID', category: 'Discord', type: 'text', secret: false },
  { key: 'DISCORD_ALLOWED_ROLE_IDS', label: 'Allowed role IDs (comma separated)', category: 'Discord', type: 'text', secret: false },
  { key: 'DISCORD_BOT_PRICING', label: 'Discord bot media-server pricing template', category: 'Discord', type: 'textarea', secret: false },
  { key: 'DISCORD_BOT_IDENTITY', label: 'Discord bot identity template', category: 'Discord', type: 'textarea', secret: false },
  { key: 'DISCORD_BOT_DEPLOYMENT', label: 'Discord bot deployment template', category: 'Discord', type: 'textarea', secret: false },
  { key: 'DISCORD_BOT_TOKEN', label: 'Discord bot token', category: 'Discord', type: 'password', secret: true },
  { key: 'DISCORD_BOT_CLIENT_ID', label: 'Discord bot application/client ID', category: 'Discord', type: 'text', secret: false },
  { key: 'DISCORD_BOT_GUILD_ID', label: 'Discord bot guild/server ID', category: 'Discord', type: 'text', secret: false },
  { key: 'DISCORD_BOT_PUBLIC_KEY', label: 'Discord application public key', category: 'Discord', type: 'text', secret: false },
  { key: 'DISCORD_BOT_DATABASE_URL', label: 'Discord bot PostgreSQL URL', category: 'Discord', type: 'url', secret: false },
  { key: 'EMBY_URL', label: 'Emby server URL', category: 'Media servers', type: 'url', secret: false },
  { key: 'EMBY_DIRECT_URL', label: 'Emby direct URL', category: 'Media servers', type: 'url', secret: false },
  { key: 'EMBY_API_KEY', label: 'Emby API key', category: 'Media servers', type: 'password', secret: true },
  { key: 'EMBY_TEMPLATE_USER_ID', label: 'Emby template user ID', category: 'Media servers', type: 'text', secret: false },
  { key: 'EMBY_HEALTH_URL', label: 'Emby health endpoint', category: 'Media server health', type: 'url', secret: false },
  { key: 'SILO_HEALTH_URL', label: 'Silo health endpoint', category: 'Media server health', type: 'url', secret: false },
  { key: 'PLEX_HEALTH_URL', label: 'Plex health endpoint', category: 'Media server health', type: 'url', secret: false },
  { key: 'JELLYFIN_HEALTH_URL', label: 'Jellyfin health endpoint', category: 'Media server health', type: 'url', secret: false },
  { key: 'EMBY_ROLE_IDS', label: 'Emby Discord role IDs (optional)', category: 'Media servers', type: 'text', secret: false },
  { key: 'JELLYFIN_URL', label: 'Jellyfin server URL', category: 'Media servers', type: 'url', secret: false },
  { key: 'JELLYFIN_API_KEY', label: 'Jellyfin API key', category: 'Media servers', type: 'password', secret: true },
  { key: 'JELLYFIN_ROLE_IDS', label: 'Jellyfin Discord role IDs (optional)', category: 'Media servers', type: 'text', secret: false },
  { key: 'PLEX_URL', label: 'Plex server URL', category: 'Media servers', type: 'url', secret: false },
  { key: 'PLEX_TOKEN', label: 'Plex token', category: 'Media servers', type: 'password', secret: true },
  { key: 'PLEX_ROLE_IDS', label: 'Plex Discord role IDs (optional)', category: 'Media servers', type: 'text', secret: false },
  { key: 'SILO_URL', label: 'Silo server URL', category: 'Media servers', type: 'url', secret: false },
  { key: 'SILO_API_KEY', label: 'Silo API key', category: 'Media servers', type: 'password', secret: true },
  { key: 'SILO_ROLE_IDS', label: 'Silo Discord role IDs (optional)', category: 'Media servers', type: 'text', secret: false },
  { key: 'LIBRARY_ACCESS_EMBY', label: 'Emby members can view Library', category: 'Permissions', type: 'toggle', secret: false },
  { key: 'LIBRARY_ACCESS_SILO', label: 'Silo members can view Library', category: 'Permissions', type: 'toggle', secret: false },
  { key: 'LIBRARY_ACCESS_PLEX', label: 'Plex members can view Library', category: 'Permissions', type: 'toggle', secret: false },
  { key: 'LIBRARY_ACCESS_JELLYFIN', label: 'Jellyfin members can view Library', category: 'Permissions', type: 'toggle', secret: false },
  { key: 'ANNOUNCEMENTS_CHANNEL_ID', label: 'Announcements Discord channel ID (optional)', category: 'Permissions', type: 'text', secret: false },
  { key: 'ANNOUNCEMENTS_CHANNELS', label: 'Announcement channels and role IDs', category: 'Permissions', type: 'text', secret: false },
  { key: 'ANNOUNCEMENTS_EMBY_ENABLED', label: 'Emby members receive announcements', category: 'Permissions', type: 'toggle', secret: false },
  { key: 'ANNOUNCEMENTS_SILO_ENABLED', label: 'Silo members receive announcements', category: 'Permissions', type: 'toggle', secret: false },
  { key: 'ANNOUNCEMENTS_PLEX_ENABLED', label: 'Plex members receive announcements', category: 'Permissions', type: 'toggle', secret: false },
  { key: 'ANNOUNCEMENTS_JELLYFIN_ENABLED', label: 'Jellyfin members receive announcements', category: 'Permissions', type: 'toggle', secret: false },
  { key: 'TMDB_API_KEY', label: 'TMDB API key', category: 'Requests & metadata', type: 'password', secret: true },
  { key: 'SEERR_URL', label: 'Seerr URL', category: 'Requests & metadata', type: 'url', secret: false },
  { key: 'SEERR_API_KEY', label: 'Seerr API key', category: 'Requests & metadata', type: 'password', secret: true },
  { key: 'RADARR_URL', label: 'Radarr URL', category: 'Requests & metadata', type: 'url', secret: false },
  { key: 'RADARR_API_KEY', label: 'Radarr API key', category: 'Requests & metadata', type: 'password', secret: true },
  { key: 'SONARR_URL', label: 'Sonarr URL', category: 'Requests & metadata', type: 'url', secret: false },
  { key: 'SONARR_API_KEY', label: 'Sonarr API key', category: 'Requests & metadata', type: 'password', secret: true },
  { key: 'SEERR_ACCESS_EMBY', label: 'Allow Emby members to use Seerr', category: 'Requests & metadata', type: 'toggle', secret: false },
  { key: 'SEERR_ACCESS_SILO', label: 'Allow Silo members to use Seerr', category: 'Requests & metadata', type: 'toggle', secret: false },
  { key: 'SEERR_ACCESS_PLEX', label: 'Allow Plex members to use Seerr', category: 'Requests & metadata', type: 'toggle', secret: false },
  { key: 'SEERR_ACCESS_JELLYFIN', label: 'Allow Jellyfin members to use Seerr', category: 'Requests & metadata', type: 'toggle', secret: false },
  { key: 'BOOKWAREHOUSE_URL', label: 'BookWarehouse API URL', category: 'Library', type: 'url', secret: false },
  { key: 'BOOKWAREHOUSE_API_KEY', label: 'BookWarehouse API key', category: 'Library', type: 'password', secret: true },
  { key: 'SHELFMARK_URL', label: 'Shelfmark URL', category: 'Library', type: 'url', secret: false },
  { key: 'SHELFMARK_USER', label: 'Shelfmark username', category: 'Library', type: 'text', secret: false },
  { key: 'SHELFMARK_PASS', label: 'Shelfmark password', category: 'Library', type: 'password', secret: true },
  { key: 'HARDCOVER_API_KEY', label: 'Hardcover API key', category: 'Library', type: 'password', secret: true },
  { key: 'COMICVINE_API_KEY', label: 'ComicVine API key', category: 'Library', type: 'password', secret: true },
  { key: 'GOOGLE_BOOKS_API_KEY', label: 'Google Books API key', category: 'Library', type: 'password', secret: true },
  { key: 'NYT_BOOKS_API_KEY', label: 'New York Times Books API key', category: 'Library', type: 'password', secret: true },
  { key: 'BOOKS_DIR', label: 'Books directory', category: 'Library', type: 'text', secret: false },
  { key: 'KAVITA_URL', label: 'Kavita URL', category: 'Library', type: 'url', secret: false },
  { key: 'KAVITA_API_KEY', label: 'Kavita API key', category: 'Library', type: 'password', secret: true },
  { key: 'KAVITA_OPDS_URL', label: 'Kavita OPDS URL (optional)', category: 'Library', type: 'url', secret: true },
  // Kindle delivery is deliberately independent from portal administration
  // email.  Members never see these credentials; they only see the sender
  // address they need to approve in Amazon.
  { key: 'KINDLE_EMAIL_PROVIDER', label: 'Kindle delivery provider', category: 'Kindle delivery', type: 'text', secret: false },
  { key: 'KINDLE_RESEND_API_KEY', label: 'Resend API key', category: 'Kindle delivery', type: 'password', secret: true },
  { key: 'KINDLE_RESEND_FROM_EMAIL', label: 'Resend sender email (also approve for Kindle)', category: 'Kindle delivery', type: 'email', secret: false },
  { key: 'KINDLE_SMTP_HOST', label: 'SMTP host', category: 'Kindle delivery', type: 'text', secret: false },
  { key: 'KINDLE_SMTP_PORT', label: 'SMTP port', category: 'Kindle delivery', type: 'number', secret: false },
  { key: 'KINDLE_SMTP_SECURE', label: 'Use SSL/TLS (port 465)', category: 'Kindle delivery', type: 'toggle', secret: false },
  { key: 'KINDLE_SMTP_USERNAME', label: 'SMTP username', category: 'Kindle delivery', type: 'text', secret: false },
  { key: 'KINDLE_SMTP_PASSWORD', label: 'SMTP password', category: 'Kindle delivery', type: 'password', secret: true },
  { key: 'KINDLE_SMTP_FROM_EMAIL', label: 'SMTP sender email (also approve for Kindle)', category: 'Kindle delivery', type: 'email', secret: false },
  // Admin mail is used only for password recovery, expiry reminders and
  // private portal support notifications. It does not affect Kindle sends.
  { key: 'ADMIN_EMAIL_PROVIDER', label: 'Admin email provider', category: 'Admin email', type: 'text', secret: false },
  { key: 'ADMIN_RESEND_API_KEY', label: 'Admin Resend API key', category: 'Admin email', type: 'password', secret: true },
  { key: 'ADMIN_FROM_EMAIL', label: 'Admin Resend sender email', category: 'Admin email', type: 'email', secret: false },
  { key: 'ADMIN_SMTP_HOST', label: 'Admin SMTP host', category: 'Admin email', type: 'text', secret: false },
  { key: 'ADMIN_SMTP_PORT', label: 'Admin SMTP port', category: 'Admin email', type: 'number', secret: false },
  { key: 'ADMIN_SMTP_SECURE', label: 'Admin SMTP SSL/TLS', category: 'Admin email', type: 'toggle', secret: false },
  { key: 'ADMIN_SMTP_USERNAME', label: 'Admin SMTP username', category: 'Admin email', type: 'text', secret: false },
  { key: 'ADMIN_SMTP_PASSWORD', label: 'Admin SMTP password', category: 'Admin email', type: 'password', secret: true },
  { key: 'ADMIN_SMTP_FROM_EMAIL', label: 'Admin SMTP sender email', category: 'Admin email', type: 'email', secret: false },
  { key: 'ADMIN_SUPPORT_INBOX', label: 'Private support inbox', category: 'Admin email', type: 'email', secret: true },
  // Legacy values are retained for existing installations. They are used as a
  // safe fallback until an administrator fills in the two new email cards.
  { key: 'RESEND_API_KEY', label: 'Legacy Resend API key', category: 'Legacy email', type: 'password', secret: true },
  { key: 'RESEND_FROM_EMAIL', label: 'Legacy Resend sender email', category: 'Legacy email', type: 'email', secret: false },
  { key: 'VAPID_PUBLIC_KEY', label: 'Web Push public key', category: 'Email & notifications', type: 'text', secret: false },
  { key: 'VAPID_PRIVATE_KEY', label: 'Web Push private key', category: 'Email & notifications', type: 'password', secret: true },
  { key: 'LIBRARY_ENABLED', label: 'Library features enabled', category: 'Feature switches', type: 'toggle', secret: false },
  { key: 'EBOOKS_ENABLED', label: 'eBooks enabled', category: 'Feature switches', type: 'toggle', secret: false },
  { key: 'AUDIOBOOKS_ENABLED', label: 'Audiobooks enabled', category: 'Feature switches', type: 'toggle', secret: false },
  { key: 'COMICS_ENABLED', label: 'Comics enabled', category: 'Feature switches', type: 'toggle', secret: false },
  { key: 'REQUESTS_ENABLED', label: 'Requests enabled', category: 'Feature switches', type: 'toggle', secret: false },
  { key: 'SEERR_ENABLED', label: 'Seerr integration enabled', category: 'Feature switches', type: 'toggle', secret: false },
  { key: 'REQUESTS_MOVIES_ENABLED', label: 'Movie requests enabled', category: 'Feature switches', type: 'toggle', secret: false },
  { key: 'REQUESTS_SHOWS_ENABLED', label: 'TV show requests enabled', category: 'Feature switches', type: 'toggle', secret: false },
  { key: 'REQUESTS_MY_ENABLED', label: 'My requests enabled', category: 'Feature switches', type: 'toggle', secret: false },
  { key: 'REQUESTS_ISSUES_ENABLED', label: 'Portal Issues enabled', category: 'Feature switches', type: 'toggle', secret: false },
]; 
const PORTAL_CONFIG_BY_KEY = new Map(PORTAL_CONFIG_FIELDS.map(field => [field.key, field]));
const ARR_INSTANCES_KEY = 'ARR_INSTANCES_JSON';
const ARR_POLICIES_KEY = 'ARR_REQUEST_POLICIES_JSON';
let portalSettings = new Map();
let settingsReady = Promise.resolve();

function configPresent(...keys) {
  return keys.every(key => Boolean(String(process.env[key] || portalSettings.get(key) || '').trim()));
}
function featureEnabled(key, defaultValue = true) {
  const raw = String(process.env[key] ?? '').trim().toLowerCase();
  return raw ? !['false', '0', 'off', 'disabled'].includes(raw) : defaultValue;
}
function authProviderEnabled(key, fallback = false) {
  return featureEnabled(key, fallback);
}

function parseJsonSetting(key, fallback) {
  try {
    const value = portalSettings.get(key) || process.env[key];
    const parsed = JSON.parse(String(value || ''));
    return parsed;
  } catch (_) { return fallback; }
}

function configuredArrInstances() {
  const stored = parseJsonSetting(ARR_INSTANCES_KEY, null);
  if (Array.isArray(stored)) return stored;
  const legacy = [];
  for (const service of ['radarr', 'sonarr']) {
    const url = String(process.env[`${service.toUpperCase()}_URL`] || portalSettings.get(`${service.toUpperCase()}_URL`) || '').trim();
    const apiKey = String(process.env[`${service.toUpperCase()}_API_KEY`] || portalSettings.get(`${service.toUpperCase()}_API_KEY`) || '').trim();
    if (url || apiKey) legacy.push({ id: `${service}-legacy`, name: service[0].toUpperCase() + service.slice(1), service, url, apiKey, enabled: true, categories: service === 'radarr' ? ['movies'] : ['shows'], roleIds: [] });
  }
  return legacy;
}

function publicArrInstances() {
  return configuredArrInstances().map(item => ({
    id: String(item.id || '').trim(), name: String(item.name || item.service || 'Instance').trim(),
    service: String(item.service || '').toLowerCase(), url: String(item.url || '').trim(),
    enabled: item.enabled !== false, categories: Array.isArray(item.categories) ? item.categories.map(String) : [],
    roleIds: Array.isArray(item.roleIds) ? item.roleIds.map(String) : [], apiKeyConfigured: Boolean(String(item.apiKey || '').trim()),
    seerrServerId: String(item.seerrServerId || '').trim(), qualityProfileId: String(item.qualityProfileId || '').trim(), rootFolder: String(item.rootFolder || '').trim(),
  }));
}

function configuredArrPolicies() {
  const stored = parseJsonSetting(ARR_POLICIES_KEY, null);
  const defaults = [
    { id: 'movies', label: 'Movies', enabled: true, roleIds: [], instanceId: '' },
    { id: 'shows', label: 'TV Shows', enabled: true, roleIds: [], instanceId: '' },
    { id: 'movies-4k', label: 'Movies 4K', enabled: false, roleIds: [], instanceId: '' },
    { id: 'movies-4kdv', label: 'Movies 4K DV', enabled: false, roleIds: [], instanceId: '' },
    { id: 'shows-4k', label: 'TV Shows 4K', enabled: false, roleIds: [], instanceId: '' },
    { id: 'anime', label: 'Anime', enabled: false, roleIds: [], instanceId: '' },
    { id: 'international', label: 'International', enabled: false, roleIds: [], instanceId: '' },
    { id: 'sports', label: 'Sports', enabled: false, roleIds: [], instanceId: '' },
  ];
  return Array.isArray(stored) ? stored : defaults;
}

function arrPolicyAllowed(req, category) {
  const policy = configuredArrPolicies().find(item => String(item.id) === String(category));
  if (!policy || policy.enabled === false) return false;
  const roleIds = Array.isArray(policy.roleIds) ? policy.roleIds.map(String).filter(Boolean) : [];
  if (!roleIds.length) return true;
  const user = req.session?.user || {};
  const memberRoles = new Set([...(user.discord_role_ids || []), ...(user.discord_roles || []), ...(user.role_ids || [])].map(String));
  return roleIds.some(role => memberRoles.has(role));
}

function embyConnectCallbackUrl() {
  const raw = String(process.env.EMBY_DIRECT_URL || process.env.EMBY_URL || '').trim();
  if (!raw) return '';
  return `${raw.replace(/\/+$/, '').replace(/\/emby$/i, '')}/api/auth/embyconnect/callback`;
}
function getLoginOptions() {
  const discordConfigured = Boolean(String(process.env.DISCORD_CLIENT_ID || '').trim() && String(process.env.DISCORD_CLIENT_SECRET || '').trim());
  // The Authentication card is authoritative: an unset or false toggle must
  // not expose Discord merely because client credentials exist.
  const discordEnabled = authProviderEnabled('AUTH_DISCORD_ENABLED', false);
  const whmcsUrl = String(process.env.AUTH_WHMCS_URL || '').trim();
  const embyConnectUrl = embyConnectCallbackUrl();
  const embyConfigured = Boolean(String(process.env.EMBY_DIRECT_URL || process.env.EMBY_URL || '').trim());
  const providers = [];
  if (discordEnabled && discordConfigured) providers.push({ id: 'discord', label: 'Continue with Discord', href: '/auth/discord', icon: '🎮' });
  if (authProviderEnabled('AUTH_WHMCS_ENABLED') && whmcsUrl) providers.push({ id: 'whmcs', label: 'Continue with WHMCS', href: '/auth/whmcs', icon: '💳' });
  if (authProviderEnabled('AUTH_EMBY_CONNECT_ENABLED') && embyConfigured && embyConnectUrl) providers.push({ id: 'emby-connect', label: 'Continue with Emby Connect', href: '/auth/emby-connect', icon: '📺' });
  return { forceOAuth: authProviderEnabled('AUTH_FORCE_OAUTH_LOGIN'), providers };
}
function getPortalFeatures() {
  const ebooks = featureEnabled('EBOOKS_ENABLED') && configPresent('BOOKWAREHOUSE_URL', 'BOOKWAREHOUSE_API_KEY');
  const audiobooks = featureEnabled('AUDIOBOOKS_ENABLED') && configPresent('BOOKWAREHOUSE_URL', 'BOOKWAREHOUSE_API_KEY');
  const comics = featureEnabled('COMICS_ENABLED') && (configPresent('COMICVINE_API_KEY') || configPresent('BOOKWAREHOUSE_URL', 'BOOKWAREHOUSE_API_KEY'));
  const library = featureEnabled('LIBRARY_ENABLED') && (ebooks || audiobooks || comics);
  const seerr = featureEnabled('SEERR_ENABLED', false) && configPresent('SEERR_URL', 'SEERR_API_KEY');
  const seerrServices = {
    emby: seerr && featureEnabled('SEERR_ACCESS_EMBY', false) && configPresent('EMBY_URL', 'EMBY_API_KEY'),
    silo: seerr && featureEnabled('SEERR_ACCESS_SILO', false) && configPresent('SILO_URL', 'SILO_API_KEY'),
    plex: seerr && featureEnabled('SEERR_ACCESS_PLEX', false) && configPresent('PLEX_URL', 'PLEX_TOKEN'),
    jellyfin: seerr && featureEnabled('SEERR_ACCESS_JELLYFIN', false) && configPresent('JELLYFIN_URL', 'JELLYFIN_API_KEY'),
  };
  const requests = featureEnabled('REQUESTS_ENABLED', false) && Object.values(seerrServices).some(Boolean);
  return {
    ebooks, audiobooks, comics, library, seerr, seerrServices, requests,
    seerrUrl: seerr ? String(process.env.SEERR_URL || '').replace(/\/$/, '') : '',
    movies: requests && featureEnabled('REQUESTS_MOVIES_ENABLED'),
    shows: requests && featureEnabled('REQUESTS_SHOWS_ENABLED'),
    myRequests: requests && featureEnabled('REQUESTS_MY_ENABLED'),
    issues: requests && featureEnabled('REQUESTS_ISSUES_ENABLED'),
  };
}

// Existing Emby/Silo members already have Library access in the portal. Keep
// that access visible unless an administrator explicitly disables the Library
// area or one of its individual sections in Feature switches. Provider keys
// control the underlying integration, not whether the existing member nav is
// silently removed.
function getMemberPortalFeatures(baseFeatures, hasStreamingMembership, service = 'emby') {
  if (!hasStreamingMembership) return baseFeatures;
  const libraryAllowed = featureEnabled(`LIBRARY_ACCESS_${String(service).toUpperCase()}`);
  const ebooks = featureEnabled('EBOOKS_ENABLED');
  const audiobooks = featureEnabled('AUDIOBOOKS_ENABLED');
  const comics = featureEnabled('COMICS_ENABLED');
  return {
    ...baseFeatures,
    ebooks,
    audiobooks,
    comics,
    library: libraryAllowed && featureEnabled('LIBRARY_ENABLED') && (ebooks || audiobooks || comics),
    requests: baseFeatures.requests && (Array.isArray(service) ? service : [service]).some(item => baseFeatures.seerrServices?.[String(item).toLowerCase()] === true),
    movies: baseFeatures.requests && (Array.isArray(service) ? service : [service]).some(item => baseFeatures.seerrServices?.[String(item).toLowerCase()] === true) && featureEnabled('REQUESTS_MOVIES_ENABLED'),
    shows: baseFeatures.requests && (Array.isArray(service) ? service : [service]).some(item => baseFeatures.seerrServices?.[String(item).toLowerCase()] === true) && featureEnabled('REQUESTS_SHOWS_ENABLED'),
    myRequests: baseFeatures.requests && (Array.isArray(service) ? service : [service]).some(item => baseFeatures.seerrServices?.[String(item).toLowerCase()] === true) && featureEnabled('REQUESTS_MY_ENABLED'),
    issues: baseFeatures.requests && (Array.isArray(service) ? service : [service]).some(item => baseFeatures.seerrServices?.[String(item).toLowerCase()] === true) && featureEnabled('REQUESTS_ISSUES_ENABLED'),
  };
}

function configEncryptionKey() {
  const raw = String(process.env.CONFIG_ENCRYPTION_KEY || '');
  if (!raw) throw new Error('CONFIG_ENCRYPTION_KEY is not configured');
  return crypto.createHash('sha256').update(raw).digest();
}

function encryptConfigValue(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', configEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptConfigValue(value) {
  if (!value) return '';
  const [version, iv64, tag64, data64] = String(value).split(':');
  if (version !== 'v1' || !iv64 || !tag64 || !data64) throw new Error('Unsupported encrypted config value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', configEncryptionKey(), Buffer.from(iv64, 'base64'));
  decipher.setAuthTag(Buffer.from(tag64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data64, 'base64')), decipher.final()]).toString('utf8');
}

function applyRuntimeSettings() {
  for (const [key, value] of portalSettings.entries()) process.env[key] = value;
}

async function loadPortalSettings() {
  if (!process.env.DATABASE_URL || !process.env.DATABASE_URL) return;
  const { data, error } = await db.from('portal_settings').select('key_name,value_encrypted');
  if (error) {
    console.warn(`[config] portal_settings unavailable: ${error.message}`);
    return;
  }
  for (const row of data || []) {
    if (!PORTAL_CONFIG_BY_KEY.has(row.key_name) && ![ARR_INSTANCES_KEY, ARR_POLICIES_KEY].includes(row.key_name)) continue;
    try { portalSettings.set(row.key_name, decryptConfigValue(row.value_encrypted)); }
    catch (e) { console.error(`[config] could not decrypt ${row.key_name}: ${e.message}`); }
  }
  applyRuntimeSettings();
  // Refresh legacy module-level values after encrypted settings are loaded.
  if (typeof RESEND_API_KEY !== 'undefined') RESEND_API_KEY = process.env.RESEND_API_KEY || '';
  if (typeof PORTAL_URL !== 'undefined') PORTAL_URL = process.env.PORTAL_URL || PORTAL_URL;
  if (typeof BW_BASE !== 'undefined') BW_BASE = normaliseBookWarehouseBase(process.env.BOOKWAREHOUSE_URL || BW_BASE);
  if (typeof SM_URL !== 'undefined') SM_URL = process.env.SHELFMARK_URL || SM_URL;
  if (typeof SM_USER !== 'undefined') SM_USER = process.env.SHELFMARK_USER || SM_USER;
  if (typeof SM_PASS !== 'undefined') SM_PASS = process.env.SHELFMARK_PASS || SM_PASS;
  if (typeof BOOKS_DIR !== 'undefined') BOOKS_DIR = process.env.BOOKS_DIR || BOOKS_DIR;
  if (typeof HC_API_KEY !== 'undefined') HC_API_KEY = process.env.HARDCOVER_API_KEY || '';
  if (typeof CV_API_KEY !== 'undefined') CV_API_KEY = process.env.COMICVINE_API_KEY || '';
  DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || DISCORD_GUILD_ID;
  console.log(`[config] loaded ${portalSettings.size} provider setting(s)`);
}

app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true, limit: '4mb' }));
app.get('/admin.html', (req, res) => res.redirect('/dashboard#administration'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// ─── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.user) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
    return res.redirect('/');
  }
  next();
}

function requireLibraryAccess(req, res, next) {
  const user = req.session?.user;
  const hasStreamingMembership = user?.has_emby === true || user?.has_silo === true || !!user?.emby_user_id;
  if (!hasStreamingMembership) {
    if (req.originalUrl.startsWith('/api/')) return res.status(403).json({ error: 'Emby membership required' });
    return res.redirect('/dashboard');
  }
  next();
}
// accounts must not be able to reveal these resources by calling APIs directly.
app.use([
  '/api/library', '/api/libraries', '/api/my-books', '/api/my-requests',
  '/api/shelfmark', '/api/comicvine', '/api/reader', '/reader'
], requireAuth, requireLibraryAccess);

// ─── EMBY API HELPER ──────────────────────────────────────────────────────────
function embyApiBase() {
  const base = String(process.env.EMBY_URL || '').replace(/\/+$/, '');
  return /\/emby$/i.test(base) ? base : `${base}/emby`;
}

// Two-step Emby password reset (clear then set — required by Emby API)
async function embySetPassword(userId, newPassword) {
  const headers = { 'X-Emby-Token': process.env.EMBY_API_KEY, 'Content-Type': 'application/json' };
  const url = `${embyApiBase()}/Users/${userId}/Password`;
  let setOk = false;
  // Step 1: clear existing password
  await axios.post(url, { Id: userId, ResetPassword: true }, { headers, timeout: 10000 })
    .catch(e => console.error('[embySetPassword] clear step:', e.message));
  // Step 2: set new password
  await axios.post(url, { Id: userId, CurrentPw: '', NewPw: newPassword }, { headers, timeout: 10000 })
    .then(() => { setOk = true; })
    .catch(e => console.error('[embySetPassword] set step:', e.response?.status, e.response?.data?.Message || e.message));
  return setOk;
}

async function embyRequest(method, endpoint, data = null) {
  try {
    const response = await axios({
      method,
      url: `${embyApiBase()}${endpoint}`,
      headers: {
        'X-Emby-Token': process.env.EMBY_API_KEY,
        'Content-Type': 'application/json'
      },
      data,
      timeout: 8000
    });
    return response.data;
  } catch (e) {
    console.error('Emby API error:', e.message);
    return null;
  }
}

// ─── EMBY AUTHENTICATE USER ───────────────────────────────────────────────────
async function embyAuthenticate(username, password) {
  const base = String(process.env.EMBY_URL || '').trim();
  if (!base) {
    return { data: null, failure: { kind: 'configuration', message: 'Emby is not configured.' } };
  }
  try {
    const response = await axios({
      method: 'POST',
      url: `${embyApiBase()}/Users/AuthenticateByName`,
      headers: {
        'X-Emby-Authorization': 'MediaBrowser Client="Portal v1", Device="Portal", DeviceId="portal-001", Version="1.0.0"',
        'Content-Type': 'application/json'
      },
      data: { Username: username, Pw: password },
      timeout: 8000
    });
    return { data: response.data, failure: null };
  } catch (e) {
    const status = Number(e.response?.status || 0);
    const message = e.response?.data?.Message || e.message || 'Unknown Emby error';
    // Never log the password. The status and server response are enough to
    // distinguish an incorrect login from a portal/server availability issue.
    console.error('[emby auth failed]', status || 'network', message);
    return {
      data: null,
      failure: {
        kind: status === 401 ? 'credentials' : (status ? 'server' : 'network'),
        status,
        message,
      },
    };
  }
}

// Emby Connect authenticates the user's Connect identity; it does not return
// the local Emby account used by this portal. The portal therefore uses the
// verified Connect email only to find the administrator-linked emby_accounts
// row. No Connect password or upstream token is stored.
async function embyConnectAuthenticate(email, password) {
  try {
    const response = await axios({
      method: 'POST',
      url: 'https://connect.emby.media/service/user/authenticate',
      headers: {
        'Content-Type': 'application/json',
        'X-Application': 'Portal v1/1.0'
      },
      data: { nameOrEmail: email, rawpw: password },
      timeout: 8000
    });
    return { data: response.data, failure: null };
  } catch (e) {
    const status = Number(e.response?.status || 0);
    console.error('[Emby Connect auth failed]', status || 'network', e.response?.data?.Message || e.message);
    return { data: null, failure: { kind: status === 401 ? 'credentials' : 'server', status } };
  }
}

function embyConnectIdentityEmails(inputEmail, responseData) {
  const values = [
    inputEmail,
    responseData?.Email,
    responseData?.email,
    responseData?.User?.Email,
    responseData?.user?.email,
  ];
  return [...new Set(values.map(value => String(value || '').trim().toLowerCase()).filter(value => value.includes('@')))];
}

async function createEmbyPortalSession(req, account) {
  const isSub = Boolean(account?.parent_emby_user_id);
  req.session.user = markPortalOwner({
    discord_id: isSub ? null : (account?.discord_user_id || null),
    discord_username: null,
    discord_avatar: null,
    emby_user_id: account?.emby_user_id || null,
    emby_username: account?.username || null,
    is_sub: isSub,
    parent_emby_user_id: account?.parent_emby_user_id || null,
    has_emby: true,
  });
}

// Silo uses its normal user login endpoint. The portal only creates a session
// after the credentials are also matched to a row provisioned by Portal.
async function siloAuthenticate(username, password) {
  const base = String(process.env.SILO_URL || '').replace(/\/+$/, '');
  if (!base) return { data: null, failure: { kind: 'configuration', message: 'Silo is not configured.' } };
  try {
    const response = await axios.post(`${base}/api/v1/auth/login`, {
      username,
      password,
    }, {
      headers: { 'Content-Type': 'application/json', 'X-Silo-Device-Name': 'Portal v1 Portal' },
      timeout: 8000,
    });
    return { data: response.data, failure: null };
  } catch (e) {
    const status = Number(e.response?.status || 0);
    const message = e.response?.data?.message || e.message || 'Unknown Silo error';
    console.error('[silo auth failed]', status || 'network', message);
    return {
      data: null,
      failure: {
        kind: status === 401 ? 'credentials' : (status ? 'server' : 'network'),
        status,
        message,
      },
    };
  }
}

async function siloAdminRequest(method, endpoint, data = null) {
  const base = String(process.env.SILO_URL || '').replace(/\/+$/, '');
  if (!process.env.SILO_API_KEY) throw new Error('SILO_API_KEY is not configured');
  const response = await axios({
    method,
    url: `${base}${endpoint}`,
    headers: {
      Authorization: `Bearer ${process.env.SILO_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'Portal/1.0',
    },
    data,
    timeout: 10000,
  });
  return response.data;
}

async function linkedSiloAccount(req) {
  const session = req.session.user || {};
  if (session.silo_user_id) {
    const { data } = await db.from('silo_accounts').select('*').eq('silo_user_id', String(session.silo_user_id)).maybeSingle();
    if (data) return data;
  }
  if (!session.discord_id) return null;
  const { data } = await db.from('silo_accounts').select('*')
    .eq('discord_user_id', String(session.discord_id))
    .is('parent_silo_user_id', null)
    .maybeSingle();
  return data || null;
}

async function siloChildren(parentId) {
  if (!parentId) return [];
  const { data } = await db.from('silo_accounts').select('*').eq('parent_silo_user_id', String(parentId)).order('created_at', { ascending: true });
  return data || [];
}

// ─── HOME PAGE ────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── DISCORD OAUTH ────────────────────────────────────────────────────────────
// ─── ALLOWED DISCORD ROLES ────────────────────────────────────────────────────
let DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || '';

// Administration is owner-based, never role-based. A publisher sets one of
// these values during first deployment; there is deliberately no public
// default that could make a random member an administrator.
function isConfiguredPortalOwner(user = {}) {
  // Service logins and Discord logins are always member sessions. The only
  // administrator session is the separate portal-admin credential below.
  return user.admin_login === true;
}

function markPortalOwner(user) {
  user.is_admin = isConfiguredPortalOwner(user);
  return user;
}

const DEFAULT_PORTAL_ADMIN_HASH = '5fb15e573c6d025ca2c6d997f8159142f5a1156005d7a70bfd81557c90672b6a35a62d7e5517ee1e21a470d6d7d803104992965e932af88b00488a5ebc90fc24';
function portalAdminPasswordMatches(password) {
  const salt = String(process.env.PORTAL_ADMIN_PASSWORD_SALT || 'portal-admin-bootstrap');
  const expected = String(process.env.PORTAL_ADMIN_PASSWORD_HASH || DEFAULT_PORTAL_ADMIN_HASH).trim();
  const actual = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

async function getPortalAdminAccounts() {
  const { data, error } = await db.from('portal_settings').select('value_encrypted').eq('key_name', 'PORTAL_ADMIN_ACCOUNTS').maybeSingle();
  if (error || !data?.value_encrypted) return [];
  try {
    const parsed = JSON.parse(decryptConfigValue(data.value_encrypted));
    return Array.isArray(parsed) ? parsed.filter(item => item && item.username && item.password_hash && item.salt) : [];
  } catch (e) { return []; }
}

async function getPortalDesignatedAdmin() {
  const { data, error } = await db.from('portal_settings').select('value_encrypted').eq('key_name', 'PORTAL_DESIGNATED_ADMIN').maybeSingle();
  if (error || !data?.value_encrypted) return null;
  try {
    const parsed = JSON.parse(decryptConfigValue(data.value_encrypted));
    return parsed?.username && parsed?.password_hash && parsed?.salt ? parsed : null;
  } catch (e) { return null; }
}

function hashPortalAdminPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, password_hash: crypto.scryptSync(String(password), salt, 64).toString('hex') };
}

function matchesPortalAdminHash(password, record) {
  const actual = crypto.scryptSync(String(password), String(record.salt), 64).toString('hex');
  const expected = String(record.password_hash || '');
  return actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

async function portalAdminLoginMatches(username, password) {
  const designated = await getPortalDesignatedAdmin();
  // The environment bootstrap account is only valid until the first primary
  // administrator is saved into encrypted PostgreSQL settings. This prevents
  // an old .env credential from remaining a second hidden admin login.
  if (designated) {
    if (String(designated.username).toLowerCase() === username.toLowerCase() && matchesPortalAdminHash(password, designated)) return true;
  } else {
    const configured = String(process.env.PORTAL_ADMIN_USERNAME || 'admin').trim();
    if (username.toLowerCase() === configured.toLowerCase() && portalAdminPasswordMatches(password)) return true;
  }
  const accounts = await getPortalAdminAccounts();
  const account = accounts.find(item => String(item.username).toLowerCase() === username.toLowerCase());
  return Boolean(account && matchesPortalAdminHash(password, account));
}

async function savePortalAdminAccounts(accounts) {
  configEncryptionKey();
  const { error } = await db.from('portal_settings').upsert({
    key_name: 'PORTAL_ADMIN_ACCOUNTS',
    value_encrypted: encryptConfigValue(JSON.stringify(accounts)),
    is_secret: true,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'key_name' });
  if (error) throw error;
}

async function savePortalDesignatedAdmin(record) {
  configEncryptionKey();
  const { error } = await db.from('portal_settings').upsert({
    key_name: 'PORTAL_DESIGNATED_ADMIN',
    value_encrypted: encryptConfigValue(JSON.stringify(record)),
    is_secret: true,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'key_name' });
  if (error) throw error;
}

function withTimeout(promise, fallback, timeoutMs = 3000) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), timeoutMs)),
  ]);
}

async function getAdminLinkedServices() {
  const keys = ['ADMIN_SERVICE_EMBY_USERNAME','ADMIN_SERVICE_EMBY_PASSWORD','ADMIN_SERVICE_EMBY_USER_ID','ADMIN_SERVICE_SILO_USERNAME','ADMIN_SERVICE_SILO_PASSWORD','ADMIN_SERVICE_SILO_USER_ID'];
  const { data, error } = await db.from('portal_settings').select('key_name,value_encrypted').in('key_name', keys);
  if (error) return {};
  const values = {};
  for (const row of data || []) { try { values[row.key_name] = decryptConfigValue(row.value_encrypted); } catch (e) {} }
  return {
    emby: values.ADMIN_SERVICE_EMBY_USERNAME ? { username: values.ADMIN_SERVICE_EMBY_USERNAME, password: values.ADMIN_SERVICE_EMBY_PASSWORD || '', user_id: values.ADMIN_SERVICE_EMBY_USER_ID || null } : null,
    silo: values.ADMIN_SERVICE_SILO_USERNAME ? { username: values.ADMIN_SERVICE_SILO_USERNAME, password: values.ADMIN_SERVICE_SILO_PASSWORD || '', user_id: values.ADMIN_SERVICE_SILO_USER_ID || null } : null,
  };
}

async function getAdminLinkedServiceRecords(linked) {
  const result = { emby: null, silo: null };
  if (linked?.emby?.username) {
    const { data } = linked.emby.user_id
      ? await db.from('emby_accounts').select('*').eq('emby_user_id', String(linked.emby.user_id)).maybeSingle()
      : await db.from('emby_accounts').select('*').ilike('username', linked.emby.username).is('parent_emby_user_id', null).maybeSingle();
    result.emby = data || null;
  }
  if (linked?.silo?.username) {
    const { data } = linked.silo.user_id
      ? await db.from('silo_accounts').select('*').eq('silo_user_id', String(linked.silo.user_id)).maybeSingle()
      : await db.from('silo_accounts').select('*').ilike('username', linked.silo.username).is('parent_silo_user_id', null).maybeSingle();
    result.silo = data || null;
  }
  return result;
}

async function saveAdminLinkedService(service, username, password, metadata = {}) {
  const prefix = `ADMIN_SERVICE_${String(service).toUpperCase()}`;
  const entries = [[`${prefix}_USERNAME`, username], [`${prefix}_PASSWORD`, password]];
  if (metadata.user_id != null) entries.push([`${prefix}_USER_ID`, String(metadata.user_id)]);
  for (const [key, value] of entries) {
    const { error } = await db.from('portal_settings').upsert({ key_name: key, value_encrypted: encryptConfigValue(value), is_secret: true, updated_at: new Date().toISOString() }, { onConflict: 'key_name' });
    if (error) throw error;
  }
}

async function deleteAdminLinkedService(service) {
  const prefix = `ADMIN_SERVICE_${String(service).toUpperCase()}`;
  const { error } = await db.from('portal_settings').delete().in('key_name', [`${prefix}_USERNAME`, `${prefix}_PASSWORD`, `${prefix}_USER_ID`]);
  if (error) throw error;
}

// v1 has no owner-specific role defaults. Configure role IDs in Admin →
// Authentication & Access for the installation that owns this repository.
const ALLOWED_ROLE_IDS = new Set();
const PORTAL_ROLE_DEFAULTS = Object.freeze({ allowed: [] });

function splitDiscordRoleIds(value) {
  return String(value || '').split(',').map(id => id.trim()).filter(id => /^\d{15,25}$/.test(id));
}

async function getDiscordGuildMember(accessToken, guildId) {
  if (!accessToken || !/^\d{15,25}$/.test(String(guildId || ''))) return null;
  const response = await axios.get(`https://discord.com/api/users/@me/guilds/${encodeURIComponent(guildId)}/member`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 8000,
  });
  return response.data || null;
}

app.get('/auth/discord', async (req, res) => {
  await settingsReady;
  if (!getLoginOptions().providers.some(provider => provider.id === 'discord')) return res.redirect('/?error=provider_disabled');
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify email guilds.members.read'
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

// WHMCS and Emby Connect are configured as provider entry URLs by the
// administrator. Keeping these redirects server-side prevents private config
// values from being embedded in the login page.
app.get('/auth/whmcs', async (req, res) => {
  await settingsReady;
  const options = getLoginOptions();
  const provider = options.providers.find(item => item.id === 'whmcs');
  res.redirect(provider ? String(process.env.AUTH_WHMCS_URL).trim() : '/?error=provider_disabled');
});

app.get('/auth/emby-connect', async (req, res) => {
  await settingsReady;
  const options = getLoginOptions();
  const provider = options.providers.find(item => item.id === 'emby-connect');
  if (!provider) return res.redirect('/?error=provider_disabled');
  res.sendFile(path.join(__dirname, 'public', 'emby-connect-login.html'));
});

app.post('/auth/emby-connect/login', async (req, res) => {
  await settingsReady;
  if (!getLoginOptions().providers.some(provider => provider.id === 'emby-connect')) {
    return res.json({ error: 'Emby Connect login is currently unavailable.' });
  }

  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email || !email.includes('@') || !password) return res.json({ error: 'Enter your Emby Connect email and password.' });

  const attempt = await embyConnectAuthenticate(email, password);
  if (!attempt.data) return res.json({ error: attempt.failure?.kind === 'server' ? 'Emby Connect could not be reached right now.' : 'Invalid Emby Connect email or password.' });

  const candidateEmails = embyConnectIdentityEmails(email, attempt.data);
  let account = null;
  for (const candidate of candidateEmails) {
    const { data, error } = await db
      .from('emby_accounts')
      .select('*')
      .ilike('connect_email', candidate)
      .maybeSingle();
    if (error) {
      console.error('[Emby Connect login] account lookup failed:', error.message);
      return res.json({ error: 'The linked portal account could not be checked.' });
    }
    if (data) { account = data; break; }
  }
  if (!account) return res.json({ error: 'This Emby Connect email is not linked yet. Link it from your Emby profile first.' });
  if (account.is_disabled) return res.json({ error: 'Your portal account has been disabled.' });

  await createEmbyPortalSession(req, account);
  res.json({ success: true, redirect: '/dashboard' });
});

app.get('/auth/callback', async (req, res) => {
  const __login_t0 = Date.now();
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');

  try {
    await settingsReady;
    if (!getLoginOptions().providers.some(provider => provider.id === 'discord')) return res.redirect('/?error=provider_disabled');
    const tokenRes = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.DISCORD_REDIRECT_URI
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 8000 });

    const { access_token } = tokenRes.data;
    console.log(`[login timing] discord token exchange: ${Date.now() - __login_t0}ms`);

    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` },
      timeout: 8000
    });

    const discordUser = userRes.data;
    console.log(`[login timing] discord user fetch: ${Date.now() - __login_t0}ms`);

    // When the administrator has saved a guild and allowed-role list, require
    // the member to hold at least one of those Portal membership roles. The role
    // list is intentionally optional so existing account-linked installations
    // can continue using Discord identity-only login until it is configured.
    const oauthGuildId = String(process.env.DISCORD_GUILD_ID || '').trim();
    const allowedRoleIds = splitDiscordRoleIds(process.env.DISCORD_ALLOWED_ROLE_IDS);
    let discordRoleIds = [];
    if (oauthGuildId) {
      let guildMember;
      try {
        guildMember = await getDiscordGuildMember(access_token, oauthGuildId);
      } catch (roleError) {
        console.error('[Discord OAuth] guild member lookup failed:', roleError.response?.status || roleError.message);
        return res.redirect('/?error=discord_guild_access');
      }
      discordRoleIds = Array.isArray(guildMember?.roles) ? guildMember.roles.map(String) : [];
      const memberRoleIds = new Set(discordRoleIds);
      if (allowedRoleIds.length && !allowedRoleIds.some(roleId => memberRoleIds.has(roleId))) return res.redirect('/?error=discord_role_required');
    }

    // Discord identifies the parent/owner account. Sub-users intentionally
    // share that ownership ID and sign in with their own media-server or
    // Emby Connect credentials instead of Discord OAuth.
    const [{ data: account }, { data: siloAccount }] = await Promise.all([
      db
        .from('emby_accounts')
        .select('*')
        .eq('discord_user_id', discordUser.id)
        .is('parent_emby_user_id', null)
        .maybeSingle(),
      db
        .from('silo_accounts')
        .select('*')
        .eq('discord_user_id', discordUser.id)
        .is('parent_silo_user_id', null)
        .maybeSingle(),
    ]);

    console.log(`[login timing] db lookups: ${Date.now() - __login_t0}ms`);
    // Must have either Emby or Silo account
    if (!account && !siloAccount) return res.redirect('/no-account');

    req.session.user = markPortalOwner({
      discord_id: discordUser.id,
      discord_username: discordUser.username,
      discord_avatar: discordUser.avatar,
      discord_role_ids: discordRoleIds,
      emby_user_id: account?.emby_user_id || null,
      emby_username: account?.username || null,
      silo_user_id: siloAccount?.silo_user_id || null,
      silo_username: siloAccount?.username || null,
      is_sub: false,
      has_emby: !!account,
      has_silo: !!siloAccount,
    });

    res.redirect('/dashboard');
  } catch (e) {
    console.error('Discord OAuth error:', e.message);
    res.redirect('/?error=auth_failed');
  }
});

// ─── EMBY LOGIN ───────────────────────────────────────────────────────────────
app.post('/auth/login', async (req, res) => {
  // Provider URLs and keys may be loaded from the encrypted settings table at
  // startup. Do not race a member login against that initial load.
  await settingsReady;
  const __emby_login_t0 = Date.now();
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const preferredService = String(req.body.service || 'emby').toLowerCase() === 'silo' ? 'silo' : 'emby';
  if (!username || !password) return res.json({ error: 'Username and password required' });

  // The portal administrator is a separate credential.  It must never be
  // confused with an Emby/Silo account called "admin".
  const portalAdminUsername = String(process.env.PORTAL_ADMIN_USERNAME || 'admin').trim();
  if (await portalAdminLoginMatches(username, password)) {
    req.session.user = {
      admin_login: true,
      is_admin: true,
      admin_username: username,
      discord_id: null,
      discord_username: username,
      discord_avatar: null,
      emby_user_id: null,
      emby_username: null,
      silo_user_id: null,
      silo_username: null,
      is_sub: false,
      has_emby: false,
      has_silo: false,
    };
    return res.json({ success: true, redirect: '/dashboard' });
  }

  const embyAttempt = preferredService === 'silo'
    ? { data: null, failure: null }
    : await embyAuthenticate(username, password);
  const auth = embyAttempt.data;
  console.log(`[emby login timing] embyAuthenticate: ${Date.now() - __emby_login_t0}ms`);
  if (!auth || !auth.User) {
    // Fall back to Silo credentials so the same portal login form works for
    // members who only have Silo access (or who prefer Silo credentials).
    const siloAttempt = await siloAuthenticate(username, password);
    const siloAuth = siloAttempt.data;
    const siloUser = siloAuth?.user || siloAuth?.User || null;
    const siloUserId = siloUser?.id ?? siloUser?.user_id ?? null;
    if (siloUser && siloUserId != null) {
      let { data: siloAccount } = await db
        .from('silo_accounts')
        .select('*')
        .eq('silo_user_id', String(siloUserId))
        .maybeSingle();
      if (!siloAccount) {
        const { data: byName } = await db
          .from('silo_accounts')
          .select('*')
          .ilike('username', username)
          .maybeSingle();
        siloAccount = byName || null;
      }
      if (siloAccount) {
        const { data: embyAccount } = !siloAccount.parent_silo_user_id && siloAccount.discord_user_id
          ? await db.from('emby_accounts').select('emby_user_id, username').eq('discord_user_id', siloAccount.discord_user_id).is('parent_emby_user_id', null).maybeSingle()
          : { data: null };
        req.session.user = markPortalOwner({
          discord_id: siloAccount.parent_silo_user_id ? null : (siloAccount.discord_user_id || null),
          discord_username: null,
          discord_avatar: null,
          emby_user_id: embyAccount?.emby_user_id || null,
          emby_username: embyAccount?.username || null,
          silo_user_id: siloAccount.silo_user_id,
          silo_username: siloAccount.username,
          is_sub: !!siloAccount.parent_silo_user_id,
          parent_silo_user_id: siloAccount.parent_silo_user_id || null,
          has_emby: !siloAccount.parent_silo_user_id && !!embyAccount,
          has_silo: true,
        });
        return res.json({ success: true, redirect: '/dashboard' });
      }
    }

    // Check if account exists but is disabled
    const { data: disabledCheck } = await db
      .from('emby_accounts')
      .select('is_disabled, username')
      .ilike('username', username)
      .maybeSingle();
    if (disabledCheck?.is_disabled) {
      return res.json({ error: 'Your account has been disabled. Please login with Discord to view your account status or contact support.' });
    }
    const upstreamFailure = [embyAttempt.failure, siloAttempt.failure]
      .find(failure => failure && failure.kind !== 'credentials' && failure.kind !== 'configuration');
    if (upstreamFailure) {
      console.error('[auth/login] media-server check unavailable:', upstreamFailure.status || 'network', upstreamFailure.message);
      return res.status(503).json({ error: 'Your Media Server could not be reached right now. Please try again shortly.' });
    }
    return res.json({ error: 'Invalid Media Server username or password.' });
  }

  const embyUserId = auth.User.Id;
  const embyUsername = auth.User.Name;

  let { data: account, error: accountLookupError } = await db
    .from('emby_accounts')
    .select('*')
    .eq('emby_user_id', embyUserId)
    .maybeSingle();

  if (accountLookupError) console.error('[auth/login] PostgreSQL account lookup failed:', accountLookupError.message);

  if (!account) {
    console.log(`Auto-creating PostgreSQL record for Emby user ${embyUsername}`);

    let streamLimit = 1;
    try {
      const embyUserRes = await axios.get(`${process.env.EMBY_URL}/emby/Users/${embyUserId}`, {
        headers: { 'X-Emby-Token': process.env.EMBY_API_KEY },
        timeout: 8000
      });
      const limit = embyUserRes.data.Policy?.SimultaneousStreamLimit;
      if (limit && limit > 0) streamLimit = limit;
    } catch(e) {
      console.error('Stream fetch error:', e.message);
    }

    const { data: newAccount, error } = await db
      .from('emby_accounts')
      .insert({
        emby_user_id: embyUserId,
        username: embyUsername,
        password: password,
        is_trial: false,
        is_lifetime: false,
        connections: streamLimit,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      console.error('Auto-create error:', error.message);
      return res.json({ error: 'Account not found. Please contact support.' });
    }
    account = newAccount;
    console.log(`Auto-created account for ${embyUsername} with ${streamLimit} streams`);
  }

  const isSub = !!account.parent_emby_user_id;

  await createEmbyPortalSession(req, account);

  res.json({ success: true, redirect: '/dashboard' });
});

// ─── NO ACCOUNT PAGE ──────────────────────────────────────────────────────────
app.get('/no-account', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'no-account.html'));
});

app.post('/api/report-issue', requireAuth, async (req, res) => {
  if (!getPortalFeatures().issues) return res.status(403).json({ error: 'Issue reports are currently disabled.' });
  const subject = String(req.body?.subject || '').trim();
  const details = String(req.body?.details || '').trim();
  if (!subject || !details) return res.status(400).json({ error: 'Subject and details are required.' });
  const { error } = await db.from('portal_issue_reports').insert({
    discord_user_id: req.session.user.discord_id || null,
    username: req.session.user.discord_username || req.session.user.emby_username || 'Member',
    subject, details, status: 'open'
  });
  if (error) return res.status(500).json({ error: 'Could not save the issue report. Ask the administrator to run the PostgreSQL setup SQL.' });
  // The private support inbox is an admin-only configuration value.  A member
  // submits this form without ever seeing that address.
  const adminMail = getAdminMailConfig();
  if (adminMail.apiKey && adminMail.fromEmail && adminMail.supportInbox) {
    let replyTo = '';
    if (req.session.user.emby_user_id) {
      const { data: member } = await db.from('emby_accounts').select('recovery_email').eq('emby_user_id', req.session.user.emby_user_id).maybeSingle();
      replyTo = String(member?.recovery_email || '').trim();
    }
    sendAdminMail({
      label: 'Portal v1 Support', to: adminMail.supportInbox,
      subject: `Portal issue: ${subject}`,
      text: `From: ${req.session.user.discord_username || req.session.user.emby_username || 'Member'}\n\n${details}`,
      replyTo,
    }).catch(mailError => console.error('[support notification]', mailError.message));
  }
  res.json({ success: true });
});

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
app.get('/dashboard', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/seerr', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'seerr.html'));
});

// ─── API: Get account data ─────────────────────────────────────────────────────
app.get('/api/account', requireAuth, async (req, res) => {
  const __t0 = Date.now();
  const features = getPortalFeatures();
  const { emby_user_id, is_sub, parent_emby_user_id, has_emby, discord_id } = req.session.user;

  // A portal-admin session starts empty and can selectively link service
  // accounts.  It is deliberately separate from the normal member lookup so
  // Emby/Silo credentials can never grant administration access.
  if (req.session.user.admin_login === true) {
    const linked = await withTimeout(getAdminLinkedServices(), {}, 3000);
    const records = await withTimeout(getAdminLinkedServiceRecords(linked), { emby: null, silo: null }, 3000);
    const emby = records.emby;
    const silo = records.silo;
    const hasLinkedEmby = Boolean(linked.emby);
    const hasLinkedSilo = Boolean(linked.silo);
    const lifetime = Boolean(emby?.is_lifetime || silo?.is_lifetime);
    const account = emby || silo || {};
    req.session.user.is_lifetime = lifetime;
    req.session.user.has_emby = hasLinkedEmby || hasLinkedSilo;
    req.session.user.has_silo = hasLinkedSilo;
    req.session.user.emby_user_id = emby?.emby_user_id || linked.emby?.user_id || null;
    const expiresAt = emby?.expires_at || silo?.expires_at || null;
    let timeRemaining = null;
    if (expiresAt && !lifetime) {
      const diff = new Date(expiresAt) - new Date();
      timeRemaining = { days: Math.max(0, Math.floor(diff / 86400000)), hours: Math.max(0, Math.floor((diff % 86400000) / 3600000)), expires_at: expiresAt };
    }
    const adminFeatures = (hasLinkedEmby || hasLinkedSilo)
      ? { ...features, library: true, ebooks: true, audiobooks: true, comics: true }
      : features;
    return res.json({
      isAdmin: true,
      adminLogin: true,
      kindleSenderEmail: getKindleSenderEmail(),
      adminServices: {
        emby: linked.emby ? { username: linked.emby.username, linked: true } : null,
        silo: linked.silo ? { username: linked.silo.username, linked: true } : null,
      },
      linkedServices: {
        emby: linked.emby ? { username: linked.emby.username, linked: true } : null,
        silo: linked.silo ? { username: linked.silo.username, linked: true } : null,
      },
      account: {
        username: req.session.user.admin_username || 'admin',
        is_trial: !!account.is_trial,
        is_lifetime: lifetime,
        is_sub: false,
        total_pool: emby?.total_pool || silo?.total_pool || emby?.connections || silo?.connections || 0,
        expires_at: expiresAt,
        emby_user_id: emby?.emby_user_id || linked.emby?.user_id || null,
      },
      silo: silo ? {
        username: silo.username,
        password: silo.password,
        expires_at: silo.expires_at,
        connections: silo.connections,
        is_trial: !!silo.is_trial,
        is_lifetime: !!silo.is_lifetime,
        server_url: process.env.SILO_URL || '${process.env.SILO_URL || ""}',
      } : null,
      timeRemaining,
      subUsers: [],
      parentAccount: null,
      discord: { id: null, username: req.session.user.admin_username || 'admin', avatar: null },
      features: adminFeatures,
      capabilities: {
        library: adminFeatures.library && (hasLinkedEmby || hasLinkedSilo),
        requests: adminFeatures.requests,
        emby: hasLinkedEmby,
        silo: hasLinkedSilo,
        manageUsers: hasLinkedEmby || hasLinkedSilo,
        manageLibraries: hasLinkedEmby || hasLinkedSilo,
        isSubUser: false,
        isAdmin: true,
      },
    });
  }

  // Silo accounts are kept in their own table by the Portal bot. Load the
  // primary account alongside Emby so a member can use either service.
  let siloAccount = null;
  if (req.session.user.silo_user_id) {
    const { data } = await db
      .from('silo_accounts')
      .select('*')
      .eq('silo_user_id', String(req.session.user.silo_user_id))
      .maybeSingle();
    siloAccount = data || null;
  } else if (discord_id && !is_sub) {
    const { data } = await db
      .from('silo_accounts')
      .select('*')
      .eq('discord_user_id', String(discord_id))
      .is('parent_silo_user_id', null)
      .maybeSingle();
    siloAccount = data || null;
  }

  if (req.session.user.is_admin === true) {
    // The owner still has a normal member account.  Do not return a blank
    // admin-only profile here: the dashboard uses this response to decide
    let adminAccount = null;
    if (emby_user_id) {
      const { data } = await db
        .from('emby_accounts')
        .select('*')
        .eq('emby_user_id', emby_user_id)
        .maybeSingle();
      adminAccount = data || null;
    }
    if (!adminAccount && discord_id) {
      const { data } = await db
        .from('emby_accounts')
        .select('*')
        .eq('discord_user_id', String(discord_id))
        .is('parent_emby_user_id', null)
        .maybeSingle();
      adminAccount = data || null;
    }

    // Direct Emby owner login may not carry Discord's id in the session.
    const adminDiscordId = String(discord_id || adminAccount?.discord_user_id || '').trim();
    if (!siloAccount && adminDiscordId) {
      const { data } = await db.from('silo_accounts').select('*').eq('discord_user_id', adminDiscordId).is('parent_silo_user_id', null).maybeSingle();
      siloAccount = data || null;
    }

    const adminHasEmby = Boolean(adminAccount?.emby_user_id || emby_user_id);
    const adminHasSilo = Boolean(siloAccount);
    const adminIsSub = Boolean(adminAccount?.parent_emby_user_id);
    const adminFeatures = getMemberPortalFeatures(
      features,
      adminHasEmby || adminHasSilo,
      adminHasEmby && adminHasSilo ? ['emby', 'silo'] : (adminHasSilo ? 'silo' : 'emby'),
    );
    return res.json({
      isAdmin: true,
      kindleSenderEmail: getKindleSenderEmail(),
      linkedServices: {
        emby: adminHasEmby ? { username: adminAccount?.username || req.session.user.emby_username || 'Emby account', linked: true } : null,
        silo: siloAccount ? { username: siloAccount.username, linked: true } : null,
      },
      account: {
        username: adminAccount?.username || req.session.user.discord_username || req.session.user.emby_username || 'Owner',
        is_trial: !!adminAccount?.is_trial,
        is_lifetime: adminAccount?.is_lifetime !== false,
        is_sub: adminIsSub,
        connections: adminAccount?.connections || 0,
        total_pool: adminAccount?.total_pool || adminAccount?.connections || 0,
        expires_at: adminAccount?.expires_at || null,
        created_at: adminAccount?.created_at || null,
        emby_user_id: adminAccount?.emby_user_id || emby_user_id || null,
        password: adminAccount?.password || null,
        connect_email: adminAccount?.connect_email || null,
        recovery_email: adminAccount?.recovery_email || siloAccount?.recovery_email || null,
        kindle_email: adminAccount?.kindle_email || null,
      },
      silo: siloAccount ? {
        username: siloAccount.username,
        password: siloAccount.password,
        expires_at: siloAccount.expires_at,
        connections: siloAccount.connections,
        is_trial: !!siloAccount.is_trial,
        is_lifetime: !!siloAccount.is_lifetime,
        server_url: process.env.SILO_URL || '${process.env.SILO_URL || ""}',
      } : null,
      timeRemaining: null,
      subUsers: [],
      parentAccount: null,
      discord: { id: adminDiscordId || req.session.user.discord_id, username: req.session.user.discord_username, avatar: req.session.user.discord_avatar },
      features: adminFeatures,
      capabilities: {
        library: adminFeatures.library && (adminHasEmby || adminHasSilo),
        requests: adminFeatures.requests,
        emby: adminHasEmby,
        silo: adminHasSilo,
        manageUsers: true,
        manageLibraries: adminHasEmby || adminHasSilo,
        isSubUser: adminIsSub,
        isAdmin: true,
      },
    });
  }

  if (!emby_user_id && !has_emby && !siloAccount) return res.status(404).json({ error: 'No linked provider account.' });

  // Silo-only members still receive a complete portal account response.
  if (!emby_user_id && siloAccount) {
    const memberFeatures = getMemberPortalFeatures(features, true, 'silo');
    const siloIsSub = !!siloAccount.parent_silo_user_id;
    req.session.user.is_lifetime = siloAccount.is_lifetime || false;
    let timeRemaining = null;
    if (siloAccount.expires_at && !siloAccount.is_lifetime) {
      const diff = new Date(siloAccount.expires_at) - new Date();
      timeRemaining = {
        days: Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24))),
        hours: Math.max(0, Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))),
        expires_at: siloAccount.expires_at,
      };
    }
    const siloSubUsers = !siloAccount.parent_silo_user_id && siloAccount.is_lifetime ? await siloChildren(siloAccount.silo_user_id) : [];
    const siloParent = siloAccount.parent_silo_user_id ? await db.from('silo_accounts').select('username,silo_user_id,connections,total_pool').eq('silo_user_id', siloAccount.parent_silo_user_id).maybeSingle().then(result => result.data || null) : null;
    return res.json({
      isAdmin: req.session.user.is_admin === true,
      kindleSenderEmail: getKindleSenderEmail(),
      linkedServices: {
        emby: null,
        silo: { username: siloAccount.username, linked: true },
      },
      account: {
        username: siloAccount.username,
        is_trial: !!siloAccount.is_trial,
        is_lifetime: !!siloAccount.is_lifetime,
        is_disabled: !!siloAccount.disabled_at,
        is_sub: !!siloAccount.parent_silo_user_id,
        connections: siloAccount.connections,
        expires_at: siloAccount.expires_at,
        created_at: siloAccount.created_at,
        connect_email: null,
        total_pool: siloAccount.total_pool,
        emby_user_id: null,
        password: siloAccount.password,
        recovery_email: siloAccount.recovery_email || null,
        profile_pic_url: req.session.user.profile_pic_url || null,
        kindle_email: null,
      },
      silo: {
        username: siloAccount.username,
        password: siloAccount.password,
        expires_at: siloAccount.expires_at,
        connections: siloAccount.connections,
        is_trial: !!siloAccount.is_trial,
        is_lifetime: !!siloAccount.is_lifetime,
        server_url: process.env.SILO_URL || '${process.env.SILO_URL || ""}',
      },
      timeRemaining,
      subUsers: siloSubUsers,
      parentAccount: null,
      discord: { id: req.session.user.discord_id, username: req.session.user.discord_username, avatar: req.session.user.discord_avatar },
      features: memberFeatures,
      capabilities: { library: memberFeatures.library, requests: memberFeatures.requests, emby: false, silo: true, manageUsers: !siloIsSub && siloAccount.is_lifetime === true, manageLibraries: memberFeatures.library, isSubUser: siloIsSub },
    });
  }

  const { data: account } = await db
    .from('emby_accounts')
    .select('*')
    .eq('emby_user_id', emby_user_id)
    .maybeSingle();
  console.log(`[account timing] main query: ${Date.now() - __t0}ms`);

  if (!account) return res.json({ error: 'Account not found' });

  const memberDiscordId = String(discord_id || account.discord_user_id || '').trim();

  let parentAccount = null;
  if (is_sub && parent_emby_user_id) {
    const { data: p } = await db
      .from('emby_accounts')
      .select('username, emby_user_id, connections, total_pool')
      .eq('emby_user_id', parent_emby_user_id)
      .maybeSingle();
    parentAccount = p;
  }

  let subUsers = [];
  if (!is_sub && account.is_lifetime) {
    const { data: subs } = await db
      .from('emby_accounts')
      .select('*')
      .eq('parent_emby_user_id', emby_user_id);
    subUsers = subs || [];
  }
  const siloSubUsers = siloAccount && !siloAccount.parent_silo_user_id && siloAccount.is_lifetime
    ? await siloChildren(siloAccount.silo_user_id)
    : [];
  console.log(`[account timing] after subUsers: ${Date.now() - __t0}ms`);

  // Use the cached connect_email from PostgreSQL — kept in sync by the Save/Remove
  // actions directly, so no need for a live Emby round-trip on every page load.
  const connectEmail = account.connect_email || null;
  const memberFeatures = getMemberPortalFeatures(features, true, !is_sub && siloAccount ? ['emby', 'silo'] : 'emby');
  const visibleSiloAccount = is_sub ? null : siloAccount;

  // Update session with lifetime status so announcements filter works correctly
  req.session.user.is_lifetime = account.is_lifetime || false;

  let timeRemaining = null;
  if (account.expires_at && !account.is_lifetime) {
    const expires = new Date(account.expires_at);
    const now = new Date();
    const diff = expires - now;
    const days = Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)));
    const hours = Math.max(0, Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)));
    timeRemaining = { days, hours, expires_at: account.expires_at };
  }

  console.log(`[account timing] TOTAL before response: ${Date.now() - __t0}ms`);
  res.json({
    isAdmin: req.session.user.is_admin === true,
    kindleSenderEmail: getKindleSenderEmail(),
    linkedServices: {
      emby: { username: account.username, linked: true },
      silo: visibleSiloAccount ? { username: visibleSiloAccount.username, linked: true } : null,
    },
    account: {
      username: account.username,
      is_trial: account.is_trial,
      is_lifetime: account.is_lifetime,
      is_disabled: account.is_disabled || false,
      is_sub,
      connections: account.connections,
      expires_at: account.expires_at,
      created_at: account.created_at,
      connect_email: connectEmail,
      total_pool: account.total_pool,
      emby_user_id: account.emby_user_id,
      password: account.password,
      recovery_email: account.recovery_email || null,
      profile_pic_url: account.profile_pic_url || null,
      kindle_email: account.kindle_email || null
    },
    silo: visibleSiloAccount ? {
      username: visibleSiloAccount.username,
      password: visibleSiloAccount.password,
      expires_at: visibleSiloAccount.expires_at,
      connections: visibleSiloAccount.connections,
      is_trial: !!visibleSiloAccount.is_trial,
      is_lifetime: !!visibleSiloAccount.is_lifetime,
      server_url: process.env.SILO_URL || '${process.env.SILO_URL || ""}',
    } : null,
    timeRemaining,
    subUsers,
    siloSubUsers: is_sub ? [] : siloSubUsers,
    parentAccount: null,
    discord: {
      id: req.session.user.discord_id,
      username: req.session.user.discord_username,
      avatar: req.session.user.discord_avatar
    },
    services: {
      hasEmby: req.session.user.has_emby !== false && !!emby_user_id,
      hasSilo: !!visibleSiloAccount,
    },
    features: memberFeatures,
    capabilities: {
      library: memberFeatures.library,
      requests: memberFeatures.requests,
      emby: true,
      silo: !!visibleSiloAccount,
      manageUsers: !is_sub && ((account.is_lifetime === true) || (!siloAccount?.parent_silo_user_id && siloAccount?.is_lifetime === true)),
      manageLibraries: !is_sub,
      isSubUser: is_sub,
    }
  });

  // Background: sync Emby profile image URL to portal
  if (account.emby_user_id) {
    (async () => {
      try {
        const userRes = await axios.get(`${process.env.EMBY_DIRECT_URL || process.env.EMBY_URL || ""}/emby/Users/${account.emby_user_id}`, {
          headers: { 'X-Emby-Token': process.env.EMBY_API_KEY }, timeout: 5000
        });
        if (userRes.data?.PrimaryImageTag) {
          // Store the Emby image URL directly — serves fast, always current
          const embyImgUrl = `${process.env.EMBY_URL || ""}/emby/Users/${account.emby_user_id}/Images/Primary?tag=${userRes.data.PrimaryImageTag}&api_key=${process.env.EMBY_API_KEY}`;
          const currentStored = account.profile_pic_url || '';
          // Only update if no custom upload or if it's still an Emby URL
          if (!currentStored || currentStored.includes('example.invalid') || currentStored.includes('example.invalid')) {
            await db.from('emby_accounts')
              .update({ profile_pic_url: embyImgUrl })
              .eq('emby_user_id', account.emby_user_id);
          }
        }
      } catch(e) { /* silent */ }
    })();
  }
});

// The sender address is public configuration shown in Kindle setup guidance.
// Keeping this small endpoint separate lets already-open member pages update
// when the administrator changes the Resend sender address.
app.get('/api/kindle-sender', requireAuth, async (req, res) => {
  await settingsReady;
  res.json({ senderEmail: getKindleSenderEmail() });
});

// ─── API: Announcements ───────────────────────────────────────────────────────
const EMBY_ONLY_CHANNELS = ['000000000000000000', '000000000000000000'];

function splitDiscordRoleIds(value) {
  return String(value || '').split(',').map(id => id.trim()).filter(id => /^\d+$/.test(id));
}

function announcementChannelRules() {
  let configured = [];
  try {
    const raw = JSON.parse(String(process.env.ANNOUNCEMENTS_CHANNELS || '[]'));
    if (Array.isArray(raw)) configured = raw;
  } catch (_) { /* fall back to the legacy single-channel setting */ }
  if (!configured.length) {
    const legacyChannel = String(process.env.ANNOUNCEMENTS_CHANNEL_ID || '').trim();
    if (legacyChannel) configured = [{ channelId: legacyChannel, roleIds: [] }];
  }
  return configured.map(item => ({
    channelId: String(item?.channelId || item?.channel_id || '').trim(),
    roleIds: [...new Set(splitDiscordRoleIds(item?.roleIds || item?.role_ids))],
  })).filter(item => item.channelId);
}

function configuredMemberAnnouncementRoleIds({ hasEmby, hasSilo }) {
  const roleIds = new Set();
  if (hasEmby) splitDiscordRoleIds(process.env.EMBY_ROLE_IDS).forEach(id => roleIds.add(id));
  if (hasSilo) splitDiscordRoleIds(process.env.SILO_ROLE_IDS).forEach(id => roleIds.add(id));
  return roleIds;
}

function announcementRoleIds(value) {
  return String(value || '').split(',').map(raw => {
    const role = raw.trim();
    const id = role.match(/^<@&(\d+)>$/) || role.match(/^(\d+)$/);
    return id ? id[1] : role.toLowerCase();
  }).filter(Boolean);
}

app.get('/api/announcements', requireAuth, async (req, res) => {
  const __ann_t0 = Date.now();
  try {
    let linkedAdminServices = null;
    // Refresh linked admin service state here as well as in /api/account. The
    // announcement request can be made independently after a page refresh.
    if (req.session.user.admin_login === true) {
      linkedAdminServices = await getAdminLinkedServices();
      const records = await getAdminLinkedServiceRecords(linkedAdminServices);
      req.session.user.has_emby = Boolean(linkedAdminServices.emby);
      req.session.user.has_silo = Boolean(linkedAdminServices.silo);
      req.session.user.is_lifetime = Boolean(records.emby?.is_lifetime || records.silo?.is_lifetime);
      req.session.user.emby_user_id = records.emby?.emby_user_id || linkedAdminServices.emby?.user_id || null;
    }
    const hasEmby = req.session.user.has_emby === true || !!req.session.user.emby_user_id;
    const hasSilo = req.session.user.has_silo === true;
    const canReceiveAnnouncements =
      (hasEmby && featureEnabled('ANNOUNCEMENTS_EMBY_ENABLED'))
      || (hasSilo && featureEnabled('ANNOUNCEMENTS_SILO_ENABLED'));
    if (!canReceiveAnnouncements) return res.json({ announcements: [] });
    const channelRules = announcementChannelRules();
    const channelRuleMap = new Map(channelRules.map(rule => [rule.channelId, rule]));
    const configuredMemberRoles = configuredMemberAnnouncementRoleIds({ hasEmby, hasSilo });
    // Exclude server status messages at query level so they don't eat announcement slots
    const STATUS_CHANNEL = '000000000000000000';
    let query = db
      .from('announcements')
      .select('*')
      .not('channel_id', 'eq', STATUS_CHANNEL)
      .order('posted_at', { ascending: false })
      .limit(50);
    if (channelRules.length) query = query.in('channel_id', channelRules.map(rule => rule.channelId));

    const { data, error } = await query;
    console.log(`[announcements timing] after main query: ${Date.now() - __ann_t0}ms`);
    if (error) return res.json({ announcements: [] });



    // Filter announcements by role_mention (supports comma-separated, raw IDs, and <@&ID> format)
    const isLifetime = req.session.user.is_lifetime === true;

    // Map role IDs → subscription type
    const ROLE_ID_MAP = {
      '000000000000000000': 'emby',      // Emby
      '000000000000000000': 'emby',      // Emby Trial
      '000000000000000000': 'lifetime',  // Lifetime
    };
    // Role IDs that should never show in portal (unrelated roles)
    const BLOCKED_ROLE_IDS = new Set([
      '000000000000000000', // @avax — unrelated to subscriptions
    ]);

    const filtered = (data || []).filter(a => {
      const channelRule = channelRuleMap.get(String(a.channel_id || '').trim());
      const taggedRoles = announcementRoleIds(a.role_mention);

      // A channel's configured audience is mandatory. This keeps a member
      // with another service role from seeing a channel they were not assigned.
      if (channelRule?.roleIds?.length && !channelRule.roleIds.some(role => configuredMemberRoles.has(role))) return false;
      if (!a.role_mention) return true;

      // Parse comma-separated role mentions — strip <@&ID> wrapper if present
      const roles = taggedRoles;

      // If ALL mentions are blocked roles → never show
      const allBlocked = roles.every(r => BLOCKED_ROLE_IDS.has(r));
      if (allBlocked) return false;

      return roles.some(role => {
        // Blocked role ID — skip this mention, check others
        if (BLOCKED_ROLE_IDS.has(role)) return false;
        // Everyone/here — show to all
        if (role === 'everyone' || role === 'here') return true;
        if (configuredMemberRoles.has(role)) return true;
        // Numeric role ID — map to subscription type
        if (/^\d+$/.test(role)) {
          const type = ROLE_ID_MAP[role];
          if (!type) return false; // Unknown role ID — don't show
          if (type === 'emby') return hasEmby && featureEnabled('ANNOUNCEMENTS_EMBY_ENABLED');
          if (type === 'lifetime') return hasEmby && isLifetime;
          return false;
        }
        // Text label fallback
        if (role === 'emby') return hasEmby && featureEnabled('ANNOUNCEMENTS_EMBY_ENABLED');
        if (role === 'lifetime') return hasEmby && isLifetime;
        // Any other unknown text label — don't show
        return false;
      });
    });
    res.json({ announcements: filtered.slice(0, 10) });
  } catch (e) {
    res.json({ announcements: [] });
  }
});

app.post('/api/silo/subuser/add', requireAuth, async (req, res) => {
  const parent = await linkedSiloAccount(req);
  const subUsername = String(req.body?.subUsername || '').trim();
  const requested = Math.max(1, Number(req.body?.connections) || 1);
  if (!subUsername) return res.json({ error: 'Username required' });
  if (!parent) return res.json({ error: 'Silo account not found' });
  if (parent.parent_silo_user_id || !parent.is_lifetime) return res.json({ error: 'Only lifetime Silo parent accounts can create sub-users' });
  const children = await siloChildren(parent.silo_user_id);
  if (children.length >= 5) return res.json({ error: 'Maximum of 5 Silo sub-users reached' });
  const pool = Math.max(1, Number(parent.total_pool || parent.connections || 1));
  const allocated = children.reduce((sum, child) => sum + Math.max(0, Number(child.connections) || 0), 0);
  if (allocated + requested > pool) return res.json({ error: `Only ${Math.max(0, pool - allocated)} stream(s) remain in your pool` });
  const password = String(req.body?.password || '').trim() || generatedServicePassword();
  try {
    const created = await siloAdminRequest('POST', '/api/v1/admin/users', {
      username: subUsername,
      email: `${subUsername.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'subuser'}@portal.invalid`,
      password,
      role: 'user',
      max_streams: requested,
      max_transcodes: 0,
      create_default_profile: true,
    });
    const userId = created?.id || created?.user?.id || created?.data?.id;
    if (!userId) throw new Error('Silo did not return a user ID');
    const { error } = await db.from('silo_accounts').insert({
      discord_user_id: parent.discord_user_id || req.session.user.discord_id || null,
      friend_of_discord_id: parent.friend_of_discord_id || parent.discord_user_id || req.session.user.discord_id || null,
      silo_user_id: String(userId), username: subUsername, password, connections: requested, total_pool: requested,
      parent_silo_user_id: parent.silo_user_id, is_friend_account: true, is_lifetime: false, is_trial: false,
    });
    if (error) throw error;
    res.json({ success: true, username: subUsername, password });
  } catch (error) {
    console.error('[silo/subuser/add]', error.response?.data || error.message);
    res.status(502).json({ error: 'Silo rejected the sub-user or the portal record could not be saved' });
  }
});

app.post('/api/subuser/add', requireAuth, async (req, res) => {
  const { subUsername } = req.body;
  if (!subUsername) return res.json({ error: 'Username required' });

  if (req.session.user.is_sub) return res.json({ error: 'Sub-users cannot create sub-users' });

  const { data: parent } = await db
    .from('emby_accounts')
    .select('*')
    .eq('emby_user_id', req.session.user.emby_user_id)
    .maybeSingle();

  if (!parent) return res.json({ error: 'Account not found' });
  if (!parent.is_lifetime) return res.json({ error: 'Sub-users are only available on Lifetime plans' });

  const { data: existingSubs } = await db
    .from('emby_accounts')
    .select('id')
    .eq('parent_emby_user_id', parent.emby_user_id);

  if (existingSubs && existingSubs.length >= 5) {
    return res.json({ error: 'Maximum of 5 sub-users reached. Contact support to increase your limit.' });
  }

  const password = Math.random().toString(36).slice(2, 10);
  const newUser = await embyRequest('POST', '/Users/New', { Name: subUsername });

  if (!newUser || !newUser.Id) return res.json({ error: 'Failed to create Emby account' });

  const passwordSet = await embySetPassword(newUser.Id, password);
  if (!passwordSet) return res.json({ error: 'Emby created the sub-account, but its password could not be set. Please delete it and try again.' });

  const TEMPLATE_USER_ID = '965a2b14611741bd9d98252806d06b35';

  // Step 1: Clone Policy from template user, override stream limit
  try {
    const templateRes = await axios.get(`${process.env.EMBY_URL}/emby/Users/${TEMPLATE_USER_ID}`, {
      headers: { 'X-Emby-Token': process.env.EMBY_API_KEY },
      timeout: 8000
    });
    const templatePolicy = templateRes.data.Policy;
    await axios.post(`${process.env.EMBY_URL}/emby/Users/${newUser.Id}/Policy`, {
      ...templatePolicy,
      IsAdministrator: false,
      IsDisabled: false,
      InvalidLoginAttemptCount: 0,
      SimultaneousStreamLimit: 1
    }, {
      headers: { 'X-Emby-Token': process.env.EMBY_API_KEY, 'Content-Type': 'application/json' },
      timeout: 8000
    });
    console.log(`Cloned policy from template to sub-user ${subUsername}`);
  } catch(e) {
    console.error('Failed to clone policy from template:', e.message);
  }

  // Step 2: Clone Configuration from template user (library order etc)
  try {
    const templateRes = await axios.get(`${process.env.EMBY_URL}/emby/Users/${TEMPLATE_USER_ID}`, {
      headers: { 'X-Emby-Token': process.env.EMBY_API_KEY },
      timeout: 8000
    });
    if (templateRes.data?.Configuration) {
      await axios.post(`${process.env.EMBY_URL}/emby/Users/${newUser.Id}/Configuration`, templateRes.data.Configuration, {
        headers: { 'X-Emby-Token': process.env.EMBY_API_KEY, 'Content-Type': 'application/json' },
        timeout: 8000
      });
      console.log(`Cloned configuration from template to sub-user ${subUsername}`);
    }
  } catch(e) {
    console.error('Failed to clone configuration from template:', e.message);
  }

  // Step 3: Clone DisplayPreferences (library layout/sections) from template user
  try {
    const dpRes = await axios.get(`${process.env.EMBY_URL}/emby/DisplayPreferences/usersettings`, {
      headers: { 'X-Emby-Token': process.env.EMBY_API_KEY },
      params: { userId: TEMPLATE_USER_ID, client: 'emby' },
      timeout: 8000
    });
    if (dpRes.data) {
      await axios.post(`${process.env.EMBY_URL}/emby/DisplayPreferences/usersettings`, dpRes.data, {
        headers: { 'X-Emby-Token': process.env.EMBY_API_KEY, 'Content-Type': 'application/json' },
        params: { userId: newUser.Id, client: 'emby' },
        timeout: 8000
      });
      console.log(`Cloned display preferences from template to sub-user ${subUsername}`);
    }
  } catch(e) {
    console.error('Failed to clone display preferences from template:', e.message);
  }

  // Verify the credentials against Emby before saving the portal mapping.
  const verified = await embyAuthenticate(subUsername, password);
  if (!verified?.User?.Id || String(verified.User.Id) !== String(newUser.Id)) {
    console.error(`[subuser] Emby credential verification failed for ${subUsername}`);
    return res.json({ error: 'The sub-account was created but Emby rejected the generated credentials. Please delete it and try again.' });
  }

  const { error } = await db.from('emby_accounts').insert({
    discord_user_id: parent.discord_user_id,
    emby_user_id: newUser.Id,
    username: subUsername,
    password,
    is_lifetime: false,
    is_trial: false,
    is_friend_account: true,
    friend_of_discord_id: parent.discord_user_id,
    parent_emby_user_id: parent.emby_user_id,
    connections: 1,
    created_at: new Date().toISOString()
  });

  if (error) {
    console.error(`[subuser] PostgreSQL mapping failed for ${subUsername}:`, error.message);
    return res.json({ error: 'Emby account created, but the portal account link could not be saved. Please contact support before trying to log in.' });
  }

  res.json({ success: true, username: subUsername, password });
});

// ─── API: Reset a sub-user password ──────────────────────────────────────────
app.post('/api/subuser/:emby_user_id/reset-password', requireAuth, async (req, res) => {
  const { emby_user_id } = req.params;
  const parentId = req.session.user.emby_user_id;
  if (req.session.user.is_sub) return res.json({ error: 'Not authorized' });

  const { data: sub } = await db
    .from('emby_accounts')
    .select('emby_user_id, username, parent_emby_user_id')
    .eq('emby_user_id', emby_user_id)
    .eq('parent_emby_user_id', parentId)
    .maybeSingle();
  if (!sub) return res.json({ error: 'Sub-user not found or not yours' });

  const newPassword = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
  const passwordSet = await embySetPassword(emby_user_id, newPassword);
  if (!passwordSet) return res.json({ error: 'Emby rejected the password update. The portal password was not changed.' });

  const verified = await embyAuthenticate(sub.username, newPassword);
  if (!verified?.User?.Id || String(verified.User.Id) !== String(emby_user_id)) {
    return res.json({ error: 'Emby did not accept the new password, so the portal password was not changed.' });
  }

  const { error } = await db.from('emby_accounts')
    .update({ password: newPassword })
    .eq('emby_user_id', emby_user_id)
    .eq('parent_emby_user_id', parentId);
  if (error) return res.json({ error: 'Emby password changed, but PostgreSQL could not save it. Contact support.' });
  res.json({ success: true, username: sub.username, password: newPassword });
});

// ─── API: Delete sub-user ─────────────────────────────────────────────────────
app.delete('/api/subuser/:emby_user_id', requireAuth, async (req, res) => {
  const { emby_user_id } = req.params;

  if (req.session.user.is_sub) return res.json({ error: 'Not authorized' });

  const { data: sub } = await db
    .from('emby_accounts')
    .select('*')
    .eq('emby_user_id', emby_user_id)
    .eq('parent_emby_user_id', req.session.user.emby_user_id)
    .maybeSingle();

  if (!sub) return res.json({ error: 'Sub-user not found or not yours' });

  try {
    await axios({
      method: 'DELETE',
      url: `${process.env.EMBY_URL}/emby/Users/${emby_user_id}`,
      headers: { 'X-Emby-Token': process.env.EMBY_API_KEY },
      timeout: 8000
    });
    console.log(`Deleted Emby user ${emby_user_id} (${sub.username})`);
  } catch(e) {
    console.error('Emby delete error:', e.response?.status, e.response?.data?.Message || e.message);
    return res.json({ error: 'Failed to delete from Emby: ' + (e.response?.data?.Message || e.message) });
  }

  try {
    const parentRes = await axios.get(`${process.env.EMBY_URL}/emby/Users/${req.session.user.emby_user_id}`, {
      headers: { 'X-Emby-Token': process.env.EMBY_API_KEY },
      timeout: 8000
    });
    const parentUser = parentRes.data;
    const currentLimit = parentUser.Policy.SimultaneousStreamLimit || 0;
    parentUser.Policy.SimultaneousStreamLimit = currentLimit + (sub.connections || 1);
    await axios.post(`${process.env.EMBY_URL}/emby/Users/${req.session.user.emby_user_id}/Policy`, parentUser.Policy, {
      headers: { 'X-Emby-Token': process.env.EMBY_API_KEY, 'Content-Type': 'application/json' },
      timeout: 8000
    });
  } catch(e) {
    console.error('Failed to restore parent streams:', e.message);
  }

  await db.from('emby_accounts').delete().eq('emby_user_id', emby_user_id);
  res.json({ success: true });
});

// ─── API: Reset & sync password ───────────────────────────────────────────────
// ─── EMAIL DELIVERY ────────────────────────────────────────────────────────────
let RESEND_API_KEY = process.env.RESEND_API_KEY || '';
let PORTAL_URL = process.env.PORTAL_URL || '';
function mailFrom(label, email) {
  return `${label} <${String(email || '').trim()}>`;
}

function getKindleMailConfig(overrides = {}) {
  const provider = String(overrides.provider || process.env.KINDLE_EMAIL_PROVIDER || 'resend').trim().toLowerCase();
  if (provider === 'smtp') return {
    provider: 'smtp',
    host: String(overrides.host || process.env.KINDLE_SMTP_HOST || '').trim(),
    port: Number(overrides.port || process.env.KINDLE_SMTP_PORT || 587),
    secure: String(overrides.secure ?? process.env.KINDLE_SMTP_SECURE ?? '').toLowerCase() === 'true',
    username: String(overrides.username || process.env.KINDLE_SMTP_USERNAME || '').trim(),
    password: String(overrides.password || process.env.KINDLE_SMTP_PASSWORD || ''),
    fromEmail: String(overrides.fromEmail || process.env.KINDLE_SMTP_FROM_EMAIL || '').trim(),
  };
  return {
    provider: 'resend',
    apiKey: String(overrides.apiKey || process.env.KINDLE_RESEND_API_KEY || process.env.RESEND_API_KEY || '').trim(),
    fromEmail: String(overrides.fromEmail || process.env.KINDLE_RESEND_FROM_EMAIL || process.env.RESEND_FROM_EMAIL || '').trim(),
  };
}

function getAdminMailConfig(overrides = {}) {
  const provider = String(overrides.provider || process.env.ADMIN_EMAIL_PROVIDER || 'resend').trim().toLowerCase() === 'smtp' ? 'smtp' : 'resend';
  if (provider === 'smtp') return {
    provider,
    host: String(overrides.host || process.env.ADMIN_SMTP_HOST || '').trim(),
    port: Number(overrides.port || process.env.ADMIN_SMTP_PORT || 587),
    secure: String(overrides.secure ?? process.env.ADMIN_SMTP_SECURE ?? 'false').toLowerCase() === 'true',
    username: String(overrides.username || process.env.ADMIN_SMTP_USERNAME || '').trim(),
    password: String(overrides.password || process.env.ADMIN_SMTP_PASSWORD || ''),
    fromEmail: String(overrides.fromEmail || process.env.ADMIN_SMTP_FROM_EMAIL || '').trim(),
    supportInbox: String(overrides.supportInbox || process.env.ADMIN_SUPPORT_INBOX || '').trim(),
  };
  return {
    provider,
    apiKey: String(overrides.apiKey || process.env.ADMIN_RESEND_API_KEY || process.env.RESEND_API_KEY || '').trim(),
    fromEmail: String(overrides.fromEmail || process.env.ADMIN_FROM_EMAIL || process.env.RESEND_FROM_EMAIL || '').trim(),
    supportInbox: String(overrides.supportInbox || process.env.ADMIN_SUPPORT_INBOX || '').trim(),
  };
}

function kindleMailConfigured() {
  const config = getKindleMailConfig();
  return config.provider === 'smtp'
    ? Boolean(config.host && config.fromEmail)
    : Boolean(config.apiKey && config.fromEmail);
}

function getKindleSenderEmail() {
  return String(getKindleMailConfig().fromEmail || '').trim();
}

async function sendConfiguredMail(config, { label = 'Portal v1', to, subject = '', text = '', html = '', attachments = [], replyTo = '' }) {
  if (!to) throw new Error('No recipient email was supplied.');
  if (!config.fromEmail) throw new Error('The sender email is not configured.');
  if (config.provider === 'smtp') {
    if (!config.host) throw new Error('The SMTP host is not configured.');
    if (!nodemailer) throw new Error('SMTP support is unavailable because nodemailer is not installed.');
    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port || 587,
      secure: Boolean(config.secure),
      auth: config.username ? { user: config.username, pass: config.password } : undefined,
    });
    return transporter.sendMail({
      from: mailFrom(label, config.fromEmail), to, subject, text, html,
      replyTo: replyTo || undefined,
      attachments: attachments.map(item => ({ filename: item.filename, content: Buffer.from(item.content, 'base64') })),
    });
  }
  if (!config.apiKey) throw new Error('The Resend API key is not configured.');
  const response = await axios.post('https://api.resend.com/emails', {
    from: mailFrom(label, config.fromEmail), to, subject, text, html,
    reply_to: replyTo || undefined,
    attachments: attachments.map(item => ({ filename: item.filename, content: item.content })),
  }, {
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    timeout: 30000,
  });
  return response.data;
}

async function sendKindleMail(message) {
  return sendConfiguredMail(getKindleMailConfig(), message);
}

async function sendAdminMail(message) {
  return sendConfiguredMail(getAdminMailConfig(), message);
}

async function sendResetEmail(toEmail, resetUrl, serviceLabel = 'Media Server') {
  const config = getAdminMailConfig();
  const missingDeliveryConfig = config.provider === 'smtp' ? (!config.host || !config.fromEmail) : (!config.apiKey || !config.fromEmail);
  if (missingDeliveryConfig) { console.error('[admin email] Configure the Admin email card first'); return false; }
  try {
    await sendAdminMail({
      label: 'Portal v1',
      to: toEmail,
      subject: `Reset your ${serviceLabel} Portal password`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#0d0d0d;color:#e2e8f0;padding:2rem;border-radius:12px">
          <img src="${process.env.PORTAL_URL || ""}/logo.png" alt="Portal v1" style="height:48px;margin-bottom:1.5rem">
          <h2 style="margin:0 0 0.75rem;color:#fff">Reset your password</h2>
          <p style="color:#94a3b8;margin:0 0 1.5rem">Click the button below to set a new password for your ${serviceLabel} account. This link expires in <strong style="color:#e2e8f0">30 minutes</strong>.</p>
          <a href="${resetUrl}" style="display:inline-block;background:#6366f1;color:#fff;padding:0.75rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:600;margin-bottom:1.5rem">Reset Password</a>
          <p style="color:#64748b;font-size:0.8rem;margin:0">If you didn't request this, ignore this email. Your password won't change.</p>
          <hr style="border:none;border-top:1px solid #1e293b;margin:1.5rem 0">
          <p style="color:#475569;font-size:0.75rem;margin:0">Portal v1 · Streaming Portal</p>
        </div>
      `,
    });
    return true;
  } catch (e) {
    console.error('[admin email] Reset email error:', e.response?.data || e.message);
    return false;
  }
}

// ─── API: Test Emby avatar upload ─────────────────────────────────────────────
// ─── API: Generate ChillLink (per-user, follows subscription automatically) ──
app.get('/api/chilllink', requireAuth, async (req, res) => {
  const { emby_user_id } = req.session.user;
  if (!emby_user_id) return res.json({ error: 'ChillLink is only available for Emby accounts.' });

  try {
    const { data: account } = await db
      .from('emby_accounts')
      .select('username, password, is_disabled')
      .eq('emby_user_id', emby_user_id)
      .maybeSingle();

    if (!account) return res.json({ error: 'Account not found.' });
    if (account.is_disabled) return res.json({ error: 'Your account is currently disabled.' });
    if (!account.password) return res.json({ error: 'No password on file for this account yet — ask the account owner to set one, or use Reset & Sync Password above, then try again.' });

    // Re-authenticate against Emby to get a fresh per-user AccessToken.
    // This naturally fails if the account is disabled/expired, since Emby
    // itself rejects login for those — same enforcement the apps get.
    const authRes = await axios.post(
      `${process.env.EMBY_URL}/emby/Users/AuthenticateByName`,
      { Username: account.username, Pw: account.password },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Emby-Authorization': 'MediaBrowser Client="Portal v1", Device="Portal", DeviceId="portal-v1", Version="1.0.0"',
        },
        timeout: 10000,
      }
    );

    const { AccessToken, User } = authRes.data;
    if (!AccessToken || !User?.Id) return res.json({ error: 'Could not generate link — try again shortly.' });

    const base = (process.env.EMBYLINK_PUBLIC_URL || '${process.env.EMBYLINK_PUBLIC_URL || ""}').replace(/\/+$/, '');
    const link = `${base}/u/${encodeURIComponent(User.Id)}/t/${encodeURIComponent(AccessToken)}`;
    res.json({ success: true, link });
  } catch (e) {
    console.error('[chilllink] generation failed:', e.response?.status, e.response?.data || e.message);
    res.json({ error: 'Could not generate link — try again shortly.' });
  }
});

app.get('/api/avatar-test/:userId', requireAuth, async (req, res) => {
  const { userId } = req.params;
  try {
    // 1. Check current user image status
    const userRes = await axios.get(`${process.env.EMBY_DIRECT_URL || process.env.EMBY_URL || ""}/emby/Users/${userId}`, {
      headers: { 'X-Emby-Token': process.env.EMBY_API_KEY }, timeout: 8000
    });
    const user = userRes.data;

    // 2. Try downloading the existing image
    let downloadStatus = null, downloadSize = null;
    if (user.PrimaryImageTag) {
      try {
        const imgRes = await axios.get(
          `${process.env.EMBY_DIRECT_URL || process.env.EMBY_URL || ""}/emby/Users/${userId}/Images/Primary?api_key=${process.env.EMBY_API_KEY}`,
          { responseType: 'arraybuffer', timeout: 8000 }
        );
        downloadStatus = imgRes.status;
        downloadSize = imgRes.data.byteLength;
      } catch(e) { downloadStatus = e.response?.status || e.message; }
    }

    // 3. Try a minimal test upload (1x1 white JPEG)
    const testJpegB64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APvV/9k=';
    let uploadStatus = null, uploadResponse = null;
    try {
      const https = require('https');
      const result = await new Promise((resolve) => {
        const opts = {
          hostname: 'example.invalid', port: 443,
          path: `/emby/Users/${userId}/Images/Primary`,
          method: 'POST',
          headers: {
            'X-Emby-Token': process.env.EMBY_API_KEY,
            'Content-Type': 'image/jpeg',
            'Content-Length': Buffer.byteLength(testJpegB64, 'utf8'),
          },
        };
        const req = https.request(opts, (res) => {
          let body = '';
          res.on('data', d => body += d);
          res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', e => resolve({ status: null, body: e.message }));
        req.write(testJpegB64);
        req.end();
      });
      uploadStatus = result.status;
      uploadResponse = result.body || '(empty)';
    } catch(e) {
      uploadStatus = null;
      uploadResponse = e.message;
    }

    res.json({
      userId,
      name: user.Name,
      hasPrimaryImage: !!user.PrimaryImageTag,
      primaryImageTag: user.PrimaryImageTag || null,
      downloadStatus,
      downloadSize,
      testUploadStatus: uploadStatus,
      testUploadResponse: uploadResponse,
      embyApiKey: process.env.EMBY_API_KEY ? '✅ set' : '❌ missing',
    });
  } catch(e) {
    res.json({ error: e.response?.status + ' ' + e.message });
  }
});

// ─── API: Upload avatar (base64, stored in PostgreSQL + synced to Emby) ──────────
app.post('/api/upload-avatar', requireAuth, async (req, res) => {
  const { dataUrl } = req.body;
  if (!dataUrl || !dataUrl.startsWith('data:image/')) return res.json({ error: 'Invalid image data' });

  const { emby_user_id, discord_id } = req.session.user;

  // Convert base64 to buffer
  const matches = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!matches) return res.json({ error: 'Invalid image format' });
  const mimeType = `image/${matches[1]}`;
  const imageBuffer = Buffer.from(matches[2], 'base64');

  // Emby expects base64 string body + Content-Type: image/jpeg
  // Use native https to avoid any axios serialization interference
  if (emby_user_id) {
    try {
      const https = require('https');
      const base64Body = matches[2]; // pure base64, no data: prefix
      await new Promise((resolve, reject) => {
        const options = {
          hostname: 'example.invalid',
          port: 443,
          path: `/emby/Users/${emby_user_id}/Images/Primary`,
          method: 'POST',
          headers: {
            'X-Emby-Token': process.env.EMBY_API_KEY,
            'Content-Type': mimeType,
            'Content-Length': Buffer.byteLength(base64Body, 'utf8'),
          },
        };
        const req = https.request(options, (res) => {
          console.log('[avatar] Emby upload status:', res.statusCode);
          res.resume();
          resolve(res.statusCode);
        });
        req.on('error', (e) => { console.error('[avatar] Emby upload error:', e.message); resolve(null); });
        req.write(base64Body);
        req.end();
      });
    } catch(e) {
      console.error('[avatar] Emby upload exception:', e.message);
    }

    // Save to emby_accounts
    const { error } = await db.from('emby_accounts')
      .update({ profile_pic_url: dataUrl })
      .eq('emby_user_id', emby_user_id);
    if (error) return res.json({ error: 'Failed to save avatar' });

  } else {
    return res.json({ error: 'No account found' });
  }

  res.json({ success: true, url: dataUrl });
});

// ─── API: Set recovery email (authenticated — first-time prompt) ───────────────
app.post('/api/set-recovery-email', requireAuth, async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.json({ error: 'Valid email required' });
  const cleanEmail = email.toLowerCase().trim();
  const targets = [];
  if (req.session.user.emby_user_id) targets.push({ table: 'emby_accounts', column: 'emby_user_id', id: req.session.user.emby_user_id });
  const siloAccount = await linkedSiloAccount(req);
  if (siloAccount?.silo_user_id) targets.push({ table: 'silo_accounts', column: 'silo_user_id', id: siloAccount.silo_user_id });
  if (!targets.length) return res.json({ error: 'No supported media-server account linked' });
  for (const target of targets) {
    const { error } = await db.from(target.table)
      .update({ recovery_email: cleanEmail })
      .eq(target.column, target.id);
    if (error) return res.json({ error: 'Failed to save email' });
  }
  req.session.user.has_recovery_email = true;
  res.json({ success: true });
});

// ─── API: Forgot password — request reset link ─────────────────────────────────
app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.json({ error: 'Please enter a valid email address.' });
  const cleanEmail = email.trim().toLowerCase();
  try {
    // Match the member-owned recovery address across the active public
    // provider tables. Never reveal whether an address exists.
    const [{ data: embyAccounts }, { data: siloAccounts }] = await Promise.all([
      db.from('emby_accounts').select('emby_user_id, username, recovery_email, is_disabled').eq('recovery_email', cleanEmail).limit(1),
      db.from('silo_accounts').select('silo_user_id, username, recovery_email, is_disabled').eq('recovery_email', cleanEmail).limit(1),
    ]);
    const matches = [
      ...(embyAccounts || []).filter(account => !account.is_disabled).map(account => ({ service: 'Emby', table: 'emby_accounts', idColumn: 'emby_user_id', id: account.emby_user_id, username: account.username })),
      ...(siloAccounts || []).filter(account => !account.is_disabled).map(account => ({ service: 'Silo', table: 'silo_accounts', idColumn: 'silo_user_id', id: account.silo_user_id, username: account.username })),
    ];
    if (!matches.length) return res.json({ success: true });

    for (const match of matches) {
      const token = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      const { error } = await db.from(match.table).update({
        reset_token: token,
        reset_token_expires: expires
      }).eq(match.idColumn, match.id);
      if (error) throw error;
      const resetUrl = `${PORTAL_URL}/reset-password?token=${token}`;
      const sent = await sendResetEmail(cleanEmail, resetUrl, match.service);
      if (!sent) {
        await db.from(match.table).update({ reset_token: null, reset_token_expires: null }).eq(match.idColumn, match.id);
      }
    }
    return res.json({ success: true });
  } catch (e) {
    console.error('[forgot-password]', e.message);
    return res.json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─── API: Verify reset token ───────────────────────────────────────────────────
app.get('/api/reset-password/verify', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.json({ valid: false });
  const [{ data: embyRows }, { data: siloRows }] = await Promise.all([
    db.from('emby_accounts').select('username, reset_token_expires').eq('reset_token', token).limit(1),
    db.from('silo_accounts').select('username, reset_token_expires').eq('reset_token', token).limit(1),
  ]);
  const match = embyRows?.length ? { ...embyRows[0], service: 'Emby' } : siloRows?.length ? { ...siloRows[0], service: 'Silo' } : null;
  if (!match) return res.json({ valid: false });
  if (new Date(match.reset_token_expires) < new Date()) return res.json({ valid: false, expired: true });
  return res.json({ valid: true, username: match.username, service: match.service });
});

// ─── API: Submit new password via reset token ──────────────────────────────────
app.post('/api/reset-password/submit', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword || newPassword.length < 6) {
    return res.json({ error: 'Password must be at least 6 characters.' });
  }
  try {
    const [{ data: embyRows }, { data: siloRows }] = await Promise.all([
      db.from('emby_accounts').select('emby_user_id, username, reset_token_expires').eq('reset_token', token).limit(1),
      db.from('silo_accounts').select('silo_user_id, username, reset_token_expires').eq('reset_token', token).limit(1),
    ]);
    const account = embyRows?.length ? { ...embyRows[0], service: 'Emby' } : siloRows?.length ? { ...siloRows[0], service: 'Silo' } : null;
    if (!account) return res.json({ error: 'Invalid or expired reset link.' });
    if (new Date(account.reset_token_expires) < new Date()) return res.json({ error: 'Reset link has expired. Please request a new one.' });
    const table = account.service === 'Silo' ? 'silo_accounts' : 'emby_accounts';
    try {
      if (account.service === 'Silo') {
        await siloAdminRequest('PUT', `/api/v1/admin/users/${encodeURIComponent(account.silo_user_id)}`, { password: newPassword });
      } else if (!(await embySetPassword(account.emby_user_id, newPassword))) {
        return res.json({ error: 'Emby rejected the password update. Please request a new reset link or contact support.' });
      }
    } catch (error) {
      console.error('[reset-password] provider update failed:', error.response?.data || error.message);
      return res.json({ error: `${account.service} rejected the password update. Please request a new reset link or contact support.` });
    }
    // Update PostgreSQL and clear the token only after the provider accepted it.
    const idColumn = account.service === 'Silo' ? 'silo_user_id' : 'emby_user_id';
    const { error: accountUpdateError } = await db.from(table).update({
      password: newPassword,
      reset_token: null,
      reset_token_expires: null
    }).eq(idColumn, account[ idColumn ]);
    if (accountUpdateError) return res.json({ error: `The password changed in ${account.service}, but the Portal record could not be synchronized. Contact support.` });
    return res.json({ success: true });
  } catch (e) {
    console.error('[reset-password]', e.message);
    return res.json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─── Page: Reset password (token link from email) ─────────────────────────────
app.get('/reset-password', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'reset-password.html'));
});

app.post('/api/reset-password', requireAuth, async (req, res) => {
  const { emby_user_id } = req.session.user;

  const newPassword = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);

  await embySetPassword(emby_user_id, newPassword);

  await db
    .from('emby_accounts')
    .update({ password: newPassword })
    .eq('emby_user_id', emby_user_id);

  res.json({ success: true, password: newPassword });
});

// ─── API: Change own password ──────────────────────────────────────────────────
app.post('/api/change-password', requireAuth, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 4) return res.json({ error: 'Password too short' });

  const { emby_user_id } = req.session.user;

  await embySetPassword(emby_user_id, newPassword);

  await db
    .from('emby_accounts')
    .update({ password: newPassword })
    .eq('emby_user_id', emby_user_id);

  res.json({ success: true });
});

// ─── API: Change/reset Silo password ─────────────────────────────────────────
// Both the live Silo account and Portal's silo_accounts row are updated so the
// Discord bot, portal display and Silo login all continue using the same value.
app.post('/api/silo/change-password', requireAuth, async (req, res) => {
  const newPassword = String(req.body.newPassword || '');
  if (!newPassword || newPassword.length < 6) return res.json({ error: 'Password must be at least 6 characters.' });
  try {
    const account = await linkedSiloAccount(req);
    if (!account) return res.json({ error: 'No Silo account is linked to this portal account.' });
    await siloAdminRequest('PUT', `/api/v1/admin/users/${encodeURIComponent(account.silo_user_id)}`, { password: newPassword });
    const { error } = await db.from('silo_accounts').update({ password: newPassword }).eq('id', account.id);
    if (error) throw error;
    res.json({ success: true, password: newPassword });
  } catch (e) {
    console.error('[silo/change-password]', e.response?.data || e.message);
    res.json({ error: 'Silo rejected the password update or the account could not be synced.' });
  }
});

app.post('/api/silo/reset-password', requireAuth, async (req, res) => {
  const newPassword = `${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6)}`;
  try {
    const account = await linkedSiloAccount(req);
    if (!account) return res.json({ error: 'No Silo account is linked to this portal account.' });
    await siloAdminRequest('PUT', `/api/v1/admin/users/${encodeURIComponent(account.silo_user_id)}`, { password: newPassword });
    const { error } = await db.from('silo_accounts').update({ password: newPassword }).eq('id', account.id);
    if (error) throw error;
    res.json({ success: true, password: newPassword });
  } catch (e) {
    console.error('[silo/reset-password]', e.response?.data || e.message);
    res.json({ error: 'Silo rejected the password reset or the account could not be synced.' });
  }
});

// ─── API: Update connect email ─────────────────────────────────────────────────
app.post('/api/connect-email', requireAuth, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return res.json({ error: 'Valid email required' });

  const emby_user_id = req.session.user.emby_user_id;
  if (!emby_user_id) return res.json({ error: 'No Emby account linked' });

  try {
    // A Connect email identifies exactly one portal account. Keep this check
    // scoped to the saved Emby row so sub-users cannot alter or collide with
    // the parent account's login identity.
    const { data: existingConnectAccount, error: existingConnectError } = await db
      .from('emby_accounts')
      .select('emby_user_id, parent_emby_user_id')
      .ilike('connect_email', email)
      .neq('emby_user_id', String(emby_user_id))
      .maybeSingle();
    if (existingConnectError) throw existingConnectError;
    if (existingConnectAccount) return res.json({ error: 'That Emby Connect email is already linked to another portal account.' });

    // Use non-CDN domain + admin API key to link Emby Connect on behalf of user
    const EMBY_DIRECT = '${process.env.EMBY_DIRECT_URL || process.env.EMBY_URL || ""}';
    await axios({
      method: 'POST',
      url: `${EMBY_DIRECT}/emby/Users/${emby_user_id}/Connect/Link?ConnectUsername=${encodeURIComponent(email)}`,
      headers: {
        'X-Emby-Token': process.env.EMBY_API_KEY,
        'Content-Type': 'application/json',
        'X-Emby-Authorization': `MediaBrowser Client="Portal", Device="Server", DeviceId="portal", Version="1.0.0", Token="${process.env.EMBY_API_KEY}"`
      },
      timeout: 10000
    });

    await db
      .from('emby_accounts')
      .update({ connect_email: email })
      .eq('emby_user_id', emby_user_id);

    res.json({ success: true });
  } catch (e) {
    const msg = e.response?.data?.Message || e.response?.data || e.message;
    console.error('Emby Connect error:', msg);
    res.json({ error: typeof msg === 'string' ? msg : 'Failed to link Emby Connect account. Please check the email and try again.' });
  }
});

// ─── API: Remove connect email ────────────────────────────────────────────────
app.post('/api/connect-email/remove', requireAuth, async (req, res) => {
  const emby_user_id = req.session.user.emby_user_id;
  if (!emby_user_id) return res.json({ error: 'No Emby account linked' });
  try {
    const EMBY_DIRECT = '${process.env.EMBY_DIRECT_URL || process.env.EMBY_URL || ""}';
    await axios({
      method: 'DELETE',
      url: `${EMBY_DIRECT}/emby/Users/${emby_user_id}/Connect/Link`,
      headers: {
        'X-Emby-Token': process.env.EMBY_API_KEY,
        'X-Emby-Authorization': `MediaBrowser Client="Portal", Device="Server", DeviceId="portal", Version="1.0.0", Token="${process.env.EMBY_API_KEY}"`
      },
      timeout: 10000
    });
    await db.from('emby_accounts').update({ connect_email: null }).eq('emby_user_id', emby_user_id);
    res.json({ success: true });
  } catch (e) {
    const msg = e.response?.data?.Message || e.message;
    console.error('Emby Connect remove error:', msg);
    // Even if Emby call fails, clear from DB
    await db.from('emby_accounts').update({ connect_email: null }).eq('emby_user_id', emby_user_id);
    res.json({ success: true });
  }
});

// ─── API: Rename sub-user ─────────────────────────────────────────────────────
app.post('/api/subuser/rename', requireAuth, async (req, res) => {
  const { emby_user_id, newName } = req.body;
  if (!emby_user_id || !newName) return res.json({ error: 'Missing fields' });
  if (req.session.user.is_sub) return res.json({ error: 'Not authorized' });

  const { data: sub } = await db
    .from('emby_accounts')
    .select('*')
    .eq('emby_user_id', emby_user_id)
    .eq('parent_emby_user_id', req.session.user.emby_user_id)
    .maybeSingle();

  if (!sub) return res.json({ error: 'Sub-user not found or not yours' });

  try {
    const getUserRes = await axios({
      method: 'GET',
      url: `${process.env.EMBY_URL}/emby/Users/${emby_user_id}`,
      headers: { 'X-Emby-Token': process.env.EMBY_API_KEY },
      timeout: 8000
    });
    const embyUser = getUserRes.data;
    embyUser.Name = newName;

    await axios({
      method: 'POST',
      url: `${process.env.EMBY_URL}/emby/Users/${emby_user_id}`,
      headers: {
        'X-Emby-Token': process.env.EMBY_API_KEY,
        'Content-Type': 'application/json'
      },
      data: embyUser,
      timeout: 8000
    });
  } catch(e) {
    console.error('Emby rename error:', e.response?.status, JSON.stringify(e.response?.data));
    return res.json({ error: 'Failed to rename in Emby: ' + (e.response?.data?.Message || e.message) });
  }

  await db.from('emby_accounts').update({ username: newName }).eq('emby_user_id', emby_user_id);

  res.json({ success: true });
});

// ─── API: Adjust sub-user streams ─────────────────────────────────────────────
app.post('/api/subuser/streams', requireAuth, async (req, res) => {
  const { emby_user_id, delta } = req.body;
  if (!emby_user_id || delta === undefined) return res.json({ error: 'Missing fields' });
  if (req.session.user.is_sub) return res.json({ error: 'Not authorized' });

  const [{ data: parent }, { data: sub }, { data: allSubs }] = await Promise.all([
    db.from('emby_accounts').select('*').eq('emby_user_id', req.session.user.emby_user_id).maybeSingle(),
    db.from('emby_accounts').select('*').eq('emby_user_id', emby_user_id).eq('parent_emby_user_id', req.session.user.emby_user_id).maybeSingle(),
    db.from('emby_accounts').select('connections, emby_user_id').eq('parent_emby_user_id', req.session.user.emby_user_id),
  ]);

  if (!parent) return res.json({ error: 'Parent account not found' });
  if (!sub) return res.json({ error: 'Sub-user not found' });

  const currentSubStreams = sub.connections || 1;
  const newSubStreams = currentSubStreams + delta;
  if (newSubStreams < 1) return res.json({ error: 'Sub-user must have at least 1 stream' });

  const totalPool = parent.total_pool || parent.connections || 0;
  const usedExcludingThis = (allSubs || [])
    .filter(s => s.emby_user_id !== emby_user_id)
    .reduce((sum, s) => sum + (s.connections || 1), 0);

  if (usedExcludingThis + newSubStreams > totalPool) {
    return res.json({ error: 'Not enough streams in your pool' });
  }

  // Update PostgreSQL immediately and respond — don't wait for Emby
  await db.from('emby_accounts').update({ connections: newSubStreams }).eq('emby_user_id', emby_user_id);

  const parentAvailable = totalPool - (usedExcludingThis + newSubStreams);
  res.json({ success: true, parentAvailable, totalPool });

  // Fire-and-forget Emby policy update — doesn't block the response
  setImmediate(async () => {
    try {
      const base = '${process.env.EMBY_DIRECT_URL || process.env.EMBY_URL || ""}';
      const headers = { 'X-Emby-Token': process.env.EMBY_API_KEY };
      const { data: embyUser } = await axios.get(`${base}/emby/Users/${emby_user_id}`, { headers, timeout: 8000 });
      embyUser.Policy.SimultaneousStreamLimit = newSubStreams;
      await axios.post(`${base}/emby/Users/${emby_user_id}/Policy`, embyUser.Policy, {
        headers: { ...headers, 'Content-Type': 'application/json' }, timeout: 8000
      });
    } catch(e) {
      console.error('[streams] Emby policy update failed:', e.response?.status, e.message);
    }
  });

  // Also update parent's stream limit in Emby (fire-and-forget)
  setImmediate(async () => {
    try {
      const base = '${process.env.EMBY_DIRECT_URL || process.env.EMBY_URL || ""}';
      const headers = { 'X-Emby-Token': process.env.EMBY_API_KEY };
      const newTotalUsed = usedExcludingThis + newSubStreams;
      const parentAvail = totalPool - newTotalUsed;
      const { data: parentEmbyUser } = await axios.get(`${base}/emby/Users/${req.session.user.emby_user_id}`, { headers, timeout: 8000 });
      parentEmbyUser.Policy.SimultaneousStreamLimit = parentAvail;
      await axios.post(`${base}/emby/Users/${req.session.user.emby_user_id}/Policy`, parentEmbyUser.Policy, {
        headers: { ...headers, 'Content-Type': 'application/json' }, timeout: 8000
      });
    } catch(e) {
      console.error('[streams] Parent policy update failed:', e.response?.status, e.message);
    }
  });
});

// ─── ADMIN DASHBOARD ──────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!req.session.user) return res.redirect('/');
  if (req.session.user.is_admin !== true) return res.redirect('/dashboard');
  next();
}

function configResponse() {
  const defaultEnabled = new Set(['LIBRARY_ENABLED','EBOOKS_ENABLED','AUDIOBOOKS_ENABLED','COMICS_ENABLED','REQUESTS_MOVIES_ENABLED','REQUESTS_SHOWS_ENABLED','REQUESTS_MY_ENABLED','REQUESTS_ISSUES_ENABLED','LIBRARY_ACCESS_EMBY','LIBRARY_ACCESS_SILO','LIBRARY_ACCESS_PLEX','LIBRARY_ACCESS_JELLYFIN','ANNOUNCEMENTS_EMBY_ENABLED','ANNOUNCEMENTS_SILO_ENABLED','ANNOUNCEMENTS_PLEX_ENABLED','ANNOUNCEMENTS_JELLYFIN_ENABLED']);
  const installDefaults = {
    AUTH_EMBY_CONNECT_URL: embyConnectCallbackUrl(),
    DISCORD_ALLOWED_ROLE_IDS: PORTAL_ROLE_DEFAULTS.allowed.join(', '),
    VPS_NAME: process.env.VPS_NAME || 'Portal public PostgreSQL VPS',
    VPS_SSH_PORT: process.env.VPS_SSH_PORT || '22',
  };
  return PORTAL_CONFIG_FIELDS.map(field => ({
    ...field,
    configured: Boolean(process.env[field.key] || portalSettings.has(field.key)),
    // Never send secret values back to a browser, including to an admin.
    value: field.secret ? '' : String(process.env[field.key] || (defaultEnabled.has(field.key) ? 'true' : (installDefaults[field.key] || ''))),
  }));
}

app.get('/api/admin/config', requireAdmin, async (req, res) => {
  await settingsReady;
  res.json({
    fields: configResponse(),
    encryptionConfigured: Boolean(process.env.CONFIG_ENCRYPTION_KEY),
    bootstrap: ['DATABASE_URL', 'DATABASE_URL', 'SESSION_SECRET', 'CONFIG_ENCRYPTION_KEY'],
  });
});

app.post('/api/admin/seerr/test', requireAdmin, async (req, res) => {
  await settingsReady;
  const url = String(req.body?.url || process.env.SEERR_URL || '').trim().replace(/\/+$/, '');
  const apiKey = String(req.body?.apiKey || process.env.SEERR_API_KEY || '').trim();
  if (!url || !apiKey) return res.status(400).json({ error: 'Enter the Seerr URL and API key first.' });
  const headers = { 'X-Api-Key': apiKey, Accept: 'application/json' };
  try {
    let response;
    try {
      response = await axios.get(`${url}/api/v1/status`, { headers, timeout: 8000 });
    } catch (firstError) {
      if (firstError.response?.status !== 404) throw firstError;
      response = await axios.get(`${url}/status`, { headers, timeout: 8000 });
    }
    res.json({ success: true, message: `Seerr responded successfully${response.data?.version ? ` (version ${response.data.version})` : ''}.` });
  } catch (error) {
    console.error('[seerr test]', error.response?.status || 'network', error.message);
    res.status(502).json({ error: `Seerr connection failed (${error.response?.status || 'network error'}). Check the URL and API key.` });
  }
});

function seerrArrUrlParts(value) {
  const parsed = new URL(String(value || '').trim());
  return { hostname: parsed.hostname, port: Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)), useSsl: parsed.protocol === 'https:', baseUrl: parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '') };
}

app.get('/api/admin/seerr/automation', requireAdmin, async (req, res) => {
  try {
    const [radarr, sonarr] = await Promise.all([seerrApi('get', '/settings/radarr'), seerrApi('get', '/settings/sonarr')]);
    const map = (service, response) => (Array.isArray(response.data) ? response.data : []).map(item => ({
      id: `${service}-${item.id}`, seerrId: item.id, service, name: item.name || `${service[0].toUpperCase()}${service.slice(1)} instance`,
      url: item.externalUrl || `${item.useSsl ? 'https' : 'http'}://${item.hostname}${item.port ? `:${item.port}` : ''}${item.baseUrl || ''}`,
      apiKeyConfigured: Boolean(item.apiKey), enabled: true, is4k: item.is4k === true,
      categories: service === 'radarr' ? (item.is4k ? ['movies-4k','movies-4kdv'] : ['movies']) : (item.is4k ? ['shows-4k'] : ['shows']),
      roleIds: [], seerrServerId: String(item.id), qualityProfileId: String(item.activeProfileId || ''), rootFolder: String(item.activeDirectory || ''),
      profileName: item.activeProfileName || '', rootFolderName: item.activeDirectory || '', isDefault: item.isDefault === true,
    }));
    res.json({ instances: [...map('radarr', radarr), ...map('sonarr', sonarr)], source: 'seerr' });
  } catch (error) {
    console.error('[seerr automation list]', error.response?.status || 'network', error.message);
    res.status(502).json({ error: 'Could not read Radarr/Sonarr servers from Seerr. Check the Seerr URL, API key, and admin permissions.' });
  }
});

app.post('/api/admin/seerr/automation', requireAdmin, async (req, res) => {
  const service = String(req.body?.service || '').toLowerCase();
  if (!['radarr', 'sonarr'].includes(service)) return res.status(400).json({ error: 'Choose Radarr or Sonarr.' });
  const apiKey = String(req.body?.apiKey || '').trim();
  if (!apiKey) return res.status(400).json({ error: `Enter the ${service[0].toUpperCase() + service.slice(1)} API key.` });
  let parts;
  try { parts = seerrArrUrlParts(req.body?.url); } catch (_) { return res.status(400).json({ error: 'Enter a valid Radarr/Sonarr URL.' }); }
  try {
    const arrBase = `${parts.useSsl ? 'https' : 'http'}://${parts.hostname}${parts.port ? `:${parts.port}` : ''}${parts.baseUrl}`;
    const headers = { 'X-Api-Key': apiKey, Accept: 'application/json' };
    const [profiles, folders] = await Promise.all([
      axios.get(`${arrBase}/api/v3/qualityprofile`, { headers, timeout: 8000 }),
      axios.get(`${arrBase}/api/v3/rootfolder`, { headers, timeout: 8000 }),
    ]);
    const profile = Array.isArray(profiles.data) ? profiles.data[0] : null;
    const folder = Array.isArray(folders.data) ? folders.data[0] : null;
    if (!profile || !folder) return res.status(400).json({ error: 'The service responded, but no quality profile or root folder was available.' });
    const payload = {
      name: String(req.body?.name || `${service[0].toUpperCase()}${service.slice(1)} instance`).trim(), ...parts, apiKey,
      activeProfileId: profile.id, activeProfileName: profile.name, activeDirectory: folder.path,
      is4k: req.body?.is4k === true, isDefault: req.body?.isDefault === true, externalUrl: String(req.body?.url || '').trim(), syncEnabled: true, preventSearch: false,
      ...(service === 'sonarr' ? { activeLanguageProfileId: 1, activeAnimeProfileId: 0, activeAnimeLanguageProfileId: 0, activeAnimeProfileName: profile.name, activeAnimeDirectory: folder.path, enableSeasonFolders: true } : { minimumAvailability: 'Released' }),
    };
    const response = await seerrApi('post', `/settings/${service}`, { data: payload });
    res.status(response.status || 201).json({ success: true, instance: response.data });
  } catch (error) {
    console.error('[seerr automation add]', error.response?.status || 'network', error.message);
    res.status(error.response?.status || 502).json({ error: error.response?.data?.message || 'Could not add the automation service to Seerr. Verify the service URL, API key, and Seerr admin API key.' });
  }
});

app.post('/api/admin/arr/test', requireAdmin, async (req, res) => {
  const service = String(req.body?.service || '').toLowerCase();
  const allowed = { radarr: 'Radarr', sonarr: 'Sonarr', sportarr: 'Sportarr' };
  if (!allowed[service]) return res.status(400).json({ error: 'Choose Radarr, Sonarr, or Sportarr.' });
  const instance = req.body?.instanceId ? configuredArrInstances().find(item => String(item.id) === String(req.body.instanceId)) : null;
  const url = String(req.body?.url || instance?.url || process.env[`${service.toUpperCase()}_URL`] || '').trim().replace(/\/+$/, '');
  const apiKey = String(req.body?.apiKey || instance?.apiKey || process.env[`${service.toUpperCase()}_API_KEY`] || '').trim();
  if (!url || !apiKey) return res.status(400).json({ error: `Enter the ${allowed[service]} URL and API key first.` });
  try {
    const response = await axios.get(`${url}/api/v3/system/status`, { headers: { 'X-Api-Key': apiKey, Accept: 'application/json' }, timeout: 8000 });
    res.json({ success: true, message: `${allowed[service]} responded successfully${response.data?.version ? ` (${response.data.version})` : ''}.` });
  } catch (error) {
    console.error(`[${service} test]`, error.response?.status || 'network', error.message);
    res.status(502).json({ error: `${allowed[service]} connection failed (${error.response?.status || 'network error'}). Check the URL and API key.` });
  }
});

// ─── API: Portal-hosted Seerr flow ───────────────────────────────────────────
// Seerr remains the media-request engine, but members use Portal's authenticated
// UI and API. The Seerr API key never reaches the browser. Portal users are
// matched by their linked media-provider identity; recovery email is not part of
// the request identity. If a matching Seerr user is absent, Portal provisions a
// server-only Seerr local user with a generated password.
const SEERR_USER_CACHE = new Map();
const SEERR_USER_CACHE_MS = 60 * 1000;

function seerrBaseUrl() {
  return String(process.env.SEERR_URL || '').trim().replace(/\/+$/, '');
}

async function seerrApi(method, endpoint, config = {}) {
  const base = seerrBaseUrl();
  const apiKey = String(process.env.SEERR_API_KEY || '').trim();
  if (!base || !apiKey) throw new Error('Seerr is not configured');
  return axios({
    method,
    url: `${base}/api/v1${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`,
    timeout: 12000,
    ...config,
    headers: { Accept: 'application/json', 'X-Api-Key': apiKey, ...(config.headers || {}) },
  });
}

function seerrPortalIdentity(req) {
  const user = req.session?.user || {};
  const username = String(user.emby_username || user.silo_username || user.discord_username || user.username || '').trim();
  const provider = user.emby_user_id ? 'emby' : user.jellyfin_user_id ? 'jellyfin' : user.plex_user_id ? 'plex' : user.silo_user_id ? 'silo' : user.discord_id ? 'discord' : 'username';
  const providerId = String(user[`${provider}_user_id`] || user[`${provider}_id`] || '').trim();
  const key = providerId ? `${provider}:${providerId}` : `${provider}:${username.toLowerCase()}`;
  return { key, provider, providerId, username };
}

function seerrMembershipAllowed(req) {
  const features = getPortalFeatures();
  if (!features.requests) return false;
  const user = req.session?.user || {};
  return ['emby', 'silo', 'plex', 'jellyfin'].some(provider => {
    const linked = Boolean(user[`has_${provider}`] || user[`${provider}_user_id`]);
    return linked && features.seerrServices?.[provider] === true;
  });
}

async function seerrUserForRequest(req) {
  const identity = seerrPortalIdentity(req);
  if (!identity.username && !identity.providerId) return null;
  const cached = SEERR_USER_CACHE.get(identity.key);
  if (cached && Date.now() - cached.updatedAt < SEERR_USER_CACHE_MS) return cached.user;
  const linked = await db.from('seerr_users').select('seerr_user').eq('portal_user_key', identity.key).maybeSingle();
  if (linked.data?.seerr_user?.id) {
    SEERR_USER_CACHE.set(identity.key, { updatedAt: Date.now(), user: linked.data.seerr_user });
    return linked.data.seerr_user;
  }
  if (identity.provider === 'jellyfin' && identity.providerId) {
    try {
      const direct = await seerrApi('get', `/user/jellyfin/${encodeURIComponent(identity.providerId)}`);
      if (direct.data?.id) return await rememberSeerrUser(identity, direct.data);
    } catch (error) {
      if (error.response?.status !== 404) throw error;
    }
  }
  const response = await seerrApi('get', '/user', { params: { take: 1000 } });
  const users = Array.isArray(response.data) ? response.data : response.data?.results || response.data?.users || [];
  const wanted = identity.username.toLowerCase();
  const providerFieldMatches = identity.provider === 'jellyfin'
    ? ['jellyfinUserId', 'jellyfinUsername', 'username']
    : identity.provider === 'plex'
      ? ['plexUserId', 'plexUsername', 'username']
      : ['embyUserId', 'embyUsername', 'username'];
  const user = users.find(item => providerFieldMatches.map(field => String(item[field] || '').trim().toLowerCase()).some(value => value && (identity.providerId && value === identity.providerId.toLowerCase() || value === wanted))) || null;
  if (user?.id) return rememberSeerrUser(identity, user);
  return provisionSeerrUser(identity);
}

async function rememberSeerrUser(identity, user) {
  SEERR_USER_CACHE.set(identity.key, { updatedAt: Date.now(), user });
  await db.from('seerr_users').upsert({ portal_user_key: identity.key, seerr_user_id: String(user.id), username: identity.username, email: '', seerr_user: user }, { onConflict: 'portal_user_key' });
  return user;
}

async function provisionSeerrUser(identity) {
  if (!identity.username) return null;
  const settings = await seerrApi('get', '/settings/main');
  const permissions = Number(settings.data?.defaultPermissions || 0);
  if (!permissions) throw new Error('Seerr has no default member request permissions. Configure Seerr → Settings → Users → Default Permissions first.');
  const suffix = crypto.createHash('sha256').update(identity.key).digest('hex').slice(0, 12);
  const username = `${identity.username.slice(0, 60)}-${suffix}`;
  const email = `portal-${suffix}@example.invalid`;
  const created = await seerrApi('post', '/user', { data: { username, email, password: crypto.randomBytes(32).toString('base64url'), permissions } });
  return rememberSeerrUser(identity, created.data);
}

async function requireSeerrPortalAccess(req, res) {
  if (!seerrMembershipAllowed(req)) {
    res.status(403).json({ error: 'Seerr access is not enabled for this Portal membership.' });
    return null;
  }
  try {
    const user = await seerrUserForRequest(req);
    if (!user?.id) {
      res.status(409).json({ error: 'Your Portal account is not linked to a matching Seerr account.' });
      return null;
    }
    return { user, identity: seerrPortalIdentity(req) };
  } catch (error) {
    console.error('[seerr portal access]', error.response?.status || 'network', error.message);
    res.status(502).json({ error: 'Seerr could not be reached.' });
    return null;
  }
}

function requestCategoryAllowed(req, category, mediaType) {
  const normalized = String(category || (mediaType === 'tv' ? 'shows' : 'movies')).toLowerCase();
  if (normalized === 'movies' && !featureEnabled('REQUESTS_MOVIES_ENABLED')) return false;
  if (normalized === 'shows' && !featureEnabled('REQUESTS_SHOWS_ENABLED')) return false;
  const policy = configuredArrPolicies().find(item => String(item.id) === normalized);
  if (!publicArrInstances().some(instance => instance.enabled && instance.categories.includes(normalized) && (!policy?.instanceId || instance.id === policy.instanceId))) return false;
  return arrPolicyAllowed(req, normalized);
}

function seerrMediaIdFromRequest(item) {
  return String(item?.media?.tmdbId || item?.media?.mediaId || item?.mediaId || item?.tmdbId || '');
}

async function findExistingSeerrRequest(mediaType, mediaId) {
  const response = await seerrApi('get', '/request', { params: { take: 500, skip: 0, mediaType, sort: 'added', sortDirection: 'desc' } });
  const payload = response.data || {};
  const items = Array.isArray(payload) ? payload : payload.results || [];
  const ignored = new Set(['deleted', 'failed']);
  return items.find(item => seerrMediaIdFromRequest(item) === String(mediaId) && !ignored.has(String(item.status || '').toLowerCase())) || null;
}

app.get('/api/seerr/request-config', requireAuth, async (req, res) => {
  const context = await requireSeerrPortalAccess(req, res); if (!context) return;
  res.json({
    categories: configuredArrPolicies().map(policy => ({ ...policy, allowed: requestCategoryAllowed(req, policy.id, policy.id.includes('shows') ? 'tv' : 'movie') })),
    instances: publicArrInstances().filter(item => item.enabled),
  });
});

async function persistSeerrHistory(kind, context, item) {
  const id = item?.id || item?.request?.id || item?.issue?.id;
  if (!id) return;
  await db.from('seerr_history').upsert({
    kind,
    seerr_id: String(id),
    portal_user_key: context.identity.key,
    seerr_user_id: String(context.user.id),
    payload: item,
  }, { onConflict: 'kind,seerr_id,portal_user_key' });
}

async function localSeerrHistory(kind, context) {
  const result = await db.from('seerr_history').select('payload,created_at,updated_at')
    .eq('kind', kind).eq('portal_user_key', context.identity.key)
    .order('created_at', { ascending: false }).limit(100);
  return (result.data || []).map(row => row.payload).filter(Boolean);
}

app.get('/api/seerr/discover', requireAuth, async (req, res) => {
  const context = await requireSeerrPortalAccess(req, res); if (!context) return;
  try {
    const response = await seerrApi('get', '/discover/trending', { params: { page: Math.max(1, Number(req.query.page) || 1), type: req.query.type || 'all' } });
    res.json(response.data);
  } catch (error) {
    console.error('[seerr discover]', error.response?.status || 'network', error.message);
    res.status(error.response?.status || 502).json({ error: 'Could not load Seerr Discover.' });
  }
});

app.get('/api/seerr/search', requireAuth, async (req, res) => {
  const context = await requireSeerrPortalAccess(req, res); if (!context) return;
  const query = String(req.query.query || '').trim();
  if (!query) return res.status(400).json({ error: 'Search query is required.' });
  try {
    const response = await seerrApi('get', '/search', { params: { query, page: Math.max(1, Number(req.query.page) || 1) } });
    res.json(response.data);
  } catch (error) {
    console.error('[seerr search]', error.response?.status || 'network', error.message);
    res.status(error.response?.status || 502).json({ error: 'Could not search Seerr.' });
  }
});

app.get('/api/seerr/movie/:id', requireAuth, async (req, res) => {
  const context = await requireSeerrPortalAccess(req, res); if (!context) return;
  try { res.json((await seerrApi('get', `/movie/${encodeURIComponent(req.params.id)}`)).data); }
  catch (error) { res.status(error.response?.status || 502).json({ error: 'Could not load movie details.' }); }
});

app.get('/api/seerr/tv/:id', requireAuth, async (req, res) => {
  const context = await requireSeerrPortalAccess(req, res); if (!context) return;
  try { res.json((await seerrApi('get', `/tv/${encodeURIComponent(req.params.id)}`)).data); }
  catch (error) { res.status(error.response?.status || 502).json({ error: 'Could not load TV details.' }); }
});

function normaliseSeerrRequestStatus(item) {
  const media = item?.media || item?.mediaInfo || item?.request?.media || {};
  return {
    mediaId: String(item?.mediaId || item?.tmdbId || media?.tmdbId || media?.mediaId || ''),
    mediaType: String(item?.mediaType || media?.mediaType || '').toLowerCase(),
    title: String(item?.title || item?.name || media?.title || media?.name || ''),
    requestStatus: item?.status ?? item?.requestStatus ?? '',
    mediaStatus: media?.status ?? item?.mediaInfo?.status ?? '',
  };
}

app.get('/api/seerr/request-status', requireAuth, async (req, res) => {
  const context = await requireSeerrPortalAccess(req, res); if (!context) return;
  try {
    const payload = (await seerrApi('get', '/request', {
      params: { requestedBy: context.user.id, take: 500, skip: 0, sort: 'added', sortDirection: 'desc' }
    })).data || {};
    const raw = Array.isArray(payload) ? payload : payload.results || [];
    res.json({ results: raw.map(normaliseSeerrRequestStatus).filter(item => item.mediaId) });
  } catch (error) {
    console.error('[seerr request status]', error.response?.status || 'network', error.message);
    res.status(error.response?.status || 502).json({ error: 'Could not load Seerr request status.' });
  }
});

app.get('/api/seerr/requests', requireAuth, async (req, res) => {
  const context = await requireSeerrPortalAccess(req, res); if (!context) return;
  try {
    const response = await seerrApi('get', '/request', { params: { requestedBy: context.user.id, take: 100, skip: 0, sort: 'added', sortDirection: 'desc' } });
    const payload = response.data || {};
    const items = Array.isArray(payload) ? payload : payload.results || [];
    await Promise.all(items.map(item => persistSeerrHistory('request', context, item)));
    res.json({ ...payload, results: items });
  } catch (error) {
    console.error('[seerr requests]', error.response?.status || 'network', error.message);
    try {
      const items = await localSeerrHistory('request', context);
      if (items.length) return res.json({ results: items, localHistory: true });
    } catch (historyError) {
      console.error('[seerr local requests]', historyError.message);
    }
    res.status(error.response?.status || 502).json({ error: 'Could not load your Seerr requests.' });
  }
});

async function seerrRequestWithFallback(requestData) {
  try {
    return await seerrApi('post', '/request', { data: requestData });
  } catch (error) {
    // Some Seerr/Arr versions reject routing hints for anime or international
    // profiles. Retry once with Seerr's own default routing instead of failing
    // the member request.
    const status = Number(error.response?.status || 0);
    const retryable = status >= 400 && status < 500;
    const hasRoutingHints = ['serverId', 'profileId', 'rootFolder'].some(key => Object.prototype.hasOwnProperty.call(requestData, key));
    if (!retryable || !hasRoutingHints) throw error;
    const fallback = { ...requestData };
    delete fallback.serverId; delete fallback.profileId; delete fallback.rootFolder;
    return seerrApi('post', '/request', { data: fallback });
  }
}

app.post('/api/seerr/requests', requireAuth, async (req, res) => {
  const context = await requireSeerrPortalAccess(req, res); if (!context) return;
  const body = req.body || {};
  if (!['movie', 'tv'].includes(body.mediaType) || !body.mediaId) return res.status(400).json({ error: 'A movie or TV media ID is required.' });
  const category = String(body.requestCategory || (body.mediaType === 'tv' ? 'shows' : 'movies')).toLowerCase();
  if (!requestCategoryAllowed(req, category, body.mediaType)) return res.status(403).json({ error: `Your account is not permitted to request ${category}.` });
  const policy = configuredArrPolicies().find(item => String(item.id) === category);
  const instance = configuredArrInstances().find(item => item.enabled !== false && item.categories?.includes(category) && (!policy?.instanceId || String(item.id) === String(policy.instanceId)));
  try {
    const existing = await findExistingSeerrRequest(body.mediaType, body.mediaId);
    if (existing) return res.status(409).json({ error: 'This title is already requested or available.', existing });
    const requestData = { ...body, userId: context.user.id, is4k: category.includes('4k') };
    delete requestData.requestCategory;
    if (instance?.seerrServerId) requestData.serverId = Number(instance.seerrServerId) || instance.seerrServerId;
    if (instance?.qualityProfileId) requestData.profileId = Number(instance.qualityProfileId) || instance.qualityProfileId;
    if (instance?.rootFolder) requestData.rootFolder = instance.rootFolder;
    const response = await seerrRequestWithFallback(requestData);
    await persistSeerrHistory('request', context, response.data);
    res.status(response.status || 201).json(response.data);
  } catch (error) {
    console.error('[seerr request]', error.response?.status || 'network', error.message);
    res.status(error.response?.status || 502).json({ error: error.response?.data?.message || 'Could not create the Seerr request.' });
  }
});

app.get('/api/seerr/issues', requireAuth, async (req, res) => {
  const context = await requireSeerrPortalAccess(req, res); if (!context) return;
  try {
    const response = await seerrApi('get', '/issue');
    const raw = Array.isArray(response.data) ? response.data : response.data?.results || [];
    const items = raw.filter(item => String(item.createdBy?.id || item.reportedBy?.id || '') === String(context.user.id));
    await Promise.all(items.map(item => persistSeerrHistory('issue', context, item)));
    res.json({ issues: items });
  } catch (error) {
    console.error('[seerr issues]', error.response?.status || 'network', error.message);
    try {
      const items = await localSeerrHistory('issue', context);
      if (items.length) return res.json({ issues: items, localHistory: true });
    } catch (historyError) {
      console.error('[seerr local issues]', historyError.message);
    }
    res.status(error.response?.status || 502).json({ error: 'Could not load your Seerr issues.' });
  }
});

app.post('/api/seerr/issues', requireAuth, async (req, res) => {
  const context = await requireSeerrPortalAccess(req, res); if (!context) return;
  const body = req.body || {};
  if (!body.mediaId || !body.issueType || !String(body.message || '').trim()) return res.status(400).json({ error: 'Media, issue type, and message are required.' });
  try {
    const response = await seerrApi('post', '/issue', { data: { ...body, message: String(body.message).trim(), userId: context.user.id } });
    await persistSeerrHistory('issue', context, response.data);
    res.status(response.status || 201).json(response.data);
  } catch (error) {
    console.error('[seerr issue]', error.response?.status || 'network', error.message);
    res.status(error.response?.status || 502).json({ error: error.response?.data?.message || 'Could not create the Seerr issue.' });
  }
});

app.get('/api/admin/config/:key/reveal', requireAdmin, async (req, res) => {
  await settingsReady;
  const field = PORTAL_CONFIG_BY_KEY.get(req.params.key);
  if (!field || !field.secret) return res.status(400).json({ error: 'This setting does not need revealing.' });
  res.json({ key: field.key, value: String(process.env[field.key] || '') });
});

function brandingResponse() {
  return {
    name: String(process.env.PORTAL_NAME || 'Portal v1').trim() || 'Portal v1',
    welcomeMessage: String(process.env.PORTAL_WELCOME_MESSAGE || 'Everything you use, ready in one place.').trim() || 'Everything you use, ready in one place.',
    logoUrl: String(process.env.PORTAL_LOGO_URL || '/logo.png').trim() || '/logo.png',
    faviconUrl: String(process.env.PORTAL_FAVICON_URL || process.env.PORTAL_LOGO_URL || '/logo.png').trim() || '/logo.png',
  };
}

app.get('/api/branding', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(brandingResponse());
});

app.get('/api/login-options', async (req, res) => {
  await settingsReady;
  res.set('Cache-Control', 'no-store');
  res.json(getLoginOptions());
});

app.post('/api/admin/branding/upload', requireAdmin, async (req, res) => {
  await settingsReady;
  const kind = String(req.body?.kind || '');
  const dataUrl = String(req.body?.dataUrl || '');
  const fieldKey = kind === 'logo' ? 'PORTAL_LOGO_URL' : kind === 'favicon' ? 'PORTAL_FAVICON_URL' : '';
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp|svg\+xml|x-icon|vnd\.microsoft\.icon));base64,([A-Za-z0-9+/=]+)$/i);
  if (!fieldKey || !match) return res.status(400).json({ error: 'Choose a PNG, JPG, WebP, SVG, or ICO image.' });
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 1024 * 1024) return res.status(400).json({ error: 'Images must be smaller than 1 MB.' });
  const extensionByType = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico' };
  const extension = extensionByType[match[1].toLowerCase()];
  if (!extension) return res.status(400).json({ error: 'Unsupported image type.' });
  try {
    configEncryptionKey();
    const relativeUrl = `/branding/${kind}.${extension}`;
    const brandingDir = path.join(__dirname, 'public', 'branding');
    fs.mkdirSync(brandingDir, { recursive: true });
    fs.writeFileSync(path.join(brandingDir, `${kind}.${extension}`), buffer, { mode: 0o644 });
    const { error } = await db.from('portal_settings').upsert({
      key_name: fieldKey,
      value_encrypted: encryptConfigValue(relativeUrl),
      is_secret: false,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key_name' });
    if (error) throw error;
    portalSettings.set(fieldKey, relativeUrl);
    process.env[fieldKey] = relativeUrl;
    res.json({ success: true, url: `${relativeUrl}?v=${Date.now()}`, branding: brandingResponse() });
  } catch (error) {
    console.error('[branding] upload failed:', error.message);
    res.status(500).json({ error: 'Unable to save the image.' });
  }
});

app.put('/api/admin/config', requireAdmin, async (req, res) => {
  await settingsReady;
  const values = req.body?.values && typeof req.body.values === 'object' ? req.body.values : {};
  const clear = new Set(Array.isArray(req.body?.clear) ? req.body.clear : []);
  const changed = [];
  try {
    // Fail before writing anything if the encryption bootstrap is missing.
    configEncryptionKey();
    for (const [key, rawValue] of Object.entries(values)) {
      const field = PORTAL_CONFIG_BY_KEY.get(key);
      if (!field) continue;
      const value = String(rawValue ?? '').trim();
      if (!value) continue;
      const encrypted = encryptConfigValue(value);
      const { error } = await db.from('portal_settings').upsert({
        key_name: key,
        value_encrypted: encrypted,
        is_secret: field.secret,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key_name' });
      if (error) throw error;
      portalSettings.set(key, value);
      process.env[key] = value;
      changed.push(key);
    }
    for (const key of clear) {
      if (!PORTAL_CONFIG_BY_KEY.has(key)) continue;
      const { error } = await db.from('portal_settings').delete().eq('key_name', key);
      if (error) throw error;
      portalSettings.delete(key);
      delete process.env[key];
      changed.push(key);
    }
    applyRuntimeSettings();
    // These values are read by module-level helpers in the legacy portal code.
    RESEND_API_KEY = process.env.RESEND_API_KEY || '';
    PORTAL_URL = process.env.PORTAL_URL || PORTAL_URL;
    BW_BASE = normaliseBookWarehouseBase(process.env.BOOKWAREHOUSE_URL || BW_BASE);
    SM_URL = process.env.SHELFMARK_URL || SM_URL;
    SM_USER = process.env.SHELFMARK_USER || SM_USER;
    SM_PASS = process.env.SHELFMARK_PASS || SM_PASS;
    BOOKS_DIR = process.env.BOOKS_DIR || BOOKS_DIR;
    HC_API_KEY = process.env.HARDCOVER_API_KEY || '';
    CV_API_KEY = process.env.COMICVINE_API_KEY || '';
    DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || '';
    res.json({ success: true, changed, fields: configResponse() });
  } catch (e) {
    console.error('[config save]', e.message);
    res.status(500).json({ error: e.message.includes('CONFIG_ENCRYPTION_KEY')
      ? 'Set CONFIG_ENCRYPTION_KEY on the server before saving provider settings.'
      : 'Could not save provider settings. Check that the portal_settings table exists.' });
  }
});

async function saveEncryptedPortalSetting(key, value) {
  configEncryptionKey();
  const { error } = await db.from('portal_settings').upsert({
    key_name: key, value_encrypted: encryptConfigValue(JSON.stringify(value)), is_secret: true, updated_at: new Date().toISOString(),
  }, { onConflict: 'key_name' });
  if (error) throw error;
  portalSettings.set(key, JSON.stringify(value));
  process.env[key] = JSON.stringify(value);
}

app.get('/api/admin/arr/instances', requireAdmin, async (req, res) => {
  await settingsReady;
  res.json({ instances: publicArrInstances(), policies: configuredArrPolicies(), legacyFallback: !portalSettings.has(ARR_INSTANCES_KEY) && !process.env[ARR_INSTANCES_KEY] });
});

app.put('/api/admin/arr/instances', requireAdmin, async (req, res) => {
  await settingsReady;
  const input = Array.isArray(req.body?.instances) ? req.body.instances : [];
  const policies = Array.isArray(req.body?.policies) ? req.body.policies : configuredArrPolicies();
  if (input.length > 50) return res.status(400).json({ error: 'A maximum of 50 automation instances can be configured.' });
  const ids = new Set();
  let instances;
  try { instances = input.map((item, index) => {
    const service = String(item?.service || '').toLowerCase();
    const id = String(item?.id || `${service || 'instance'}-${index + 1}`).trim().replace(/[^a-z0-9_-]/g, '-');
    if (ids.has(id)) throw new Error(`Duplicate automation instance ID: ${id}`);
    ids.add(id);
    if (!['radarr', 'sonarr', 'sportarr'].includes(service)) throw new Error(`Unsupported automation service: ${service || 'blank'}`);
    const previous = configuredArrInstances().find(existing => String(existing.id) === id);
    return {
      id, name: String(item?.name || `${service[0].toUpperCase()}${service.slice(1)} ${index + 1}`).trim().slice(0, 80),
      service, url: String(item?.url || '').trim().replace(/\/+$/, ''),
      apiKey: String(item?.apiKey || '').trim() || String(previous?.apiKey || '').trim(), enabled: item?.enabled !== false,
      categories: Array.isArray(item?.categories) ? [...new Set(item.categories.map(String).filter(Boolean))] : [],
      roleIds: Array.isArray(item?.roleIds) ? [...new Set(item.roleIds.map(String).filter(Boolean))] : [],
      seerrServerId: String(item?.seerrServerId || '').trim(), qualityProfileId: String(item?.qualityProfileId || '').trim(), rootFolder: String(item?.rootFolder || '').trim(),
    };
  }); } catch (error) { return res.status(400).json({ error: error.message }); }
  try {
    await saveEncryptedPortalSetting(ARR_INSTANCES_KEY, instances);
    await saveEncryptedPortalSetting(ARR_POLICIES_KEY, policies.map(item => ({
      id: String(item?.id || '').trim(), label: String(item?.label || item?.id || '').trim(), enabled: item?.enabled === true,
      roleIds: Array.isArray(item?.roleIds) ? [...new Set(item.roleIds.map(String).filter(Boolean))] : [], instanceId: String(item?.instanceId || '').trim(),
    })).filter(item => item.id));
    res.json({ success: true, instances: publicArrInstances(), policies: configuredArrPolicies() });
  } catch (error) {
    console.error('[arr settings]', error.message);
    res.status(500).json({ error: 'Could not save automation settings. Check CONFIG_ENCRYPTION_KEY and portal_settings.' });
  }
});

// Moves the already-working legacy Resend configuration into the new separated
// cards without ever returning the API key to the browser.
app.post('/api/admin/email/migrate-legacy', requireAdmin, async (req, res) => {
  await settingsReady;
  const target = String(req.body?.target || '').trim();
  const apiKey = String(process.env.RESEND_API_KEY || '').trim();
  const fromEmail = String(process.env.RESEND_FROM_EMAIL || '').trim();
  if (!['kindle', 'admin'].includes(target)) return res.status(400).json({ error: 'Unknown email configuration target.' });
  if (!apiKey || !fromEmail) return res.status(400).json({ error: 'No existing Resend setup was found to copy.' });
  const fields = target === 'kindle'
    ? { KINDLE_EMAIL_PROVIDER: 'resend', KINDLE_RESEND_API_KEY: apiKey, KINDLE_RESEND_FROM_EMAIL: fromEmail }
    : { ADMIN_EMAIL_PROVIDER: 'resend', ADMIN_RESEND_API_KEY: apiKey, ADMIN_FROM_EMAIL: fromEmail };
  try {
    configEncryptionKey();
    for (const [key, value] of Object.entries(fields)) {
      const definition = PORTAL_CONFIG_BY_KEY.get(key);
      const { error } = await db.from('portal_settings').upsert({
        key_name: key, value_encrypted: encryptConfigValue(value), is_secret: definition.secret, updated_at: new Date().toISOString(),
      }, { onConflict: 'key_name' });
      if (error) throw error;
      portalSettings.set(key, value); process.env[key] = value;
    }
    res.json({ success: true, fields: configResponse() });
  } catch (error) {
    console.error('[email migration]', error.message);
    res.status(500).json({ error: 'Could not copy the existing Resend configuration.' });
  }
});

// Validates the Resend connection without sending an email.  The API key may
// be supplied from the currently open form so an admin can test it before
// saving; otherwise the encrypted, currently active portal setting is used.
app.post('/api/admin/resend/test', requireAdmin, async (req, res) => {
  await settingsReady;
  const apiKey = String(req.body?.apiKey || process.env.RESEND_API_KEY || '').trim();
  const fromEmail = String(req.body?.fromEmail || process.env.RESEND_FROM_EMAIL || '').trim();
  if (!apiKey) return res.status(400).json({ error: 'Enter a Resend API key first.' });
  if (!fromEmail || !fromEmail.includes('@')) return res.status(400).json({ error: 'Enter the verified Resend sender email first.' });
  try {
    const response = await axios.get('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${apiKey}` }, timeout: 10000,
    });
    const domain = fromEmail.split('@').pop().toLowerCase();
    const domains = Array.isArray(response.data?.data) ? response.data.data : [];
    const configured = domains.find(item => String(item.name || '').toLowerCase() === domain);
    if (configured && String(configured.status || '').toLowerCase() !== 'verified') {
      return res.status(400).json({ error: `Resend connected, but ${domain} is not verified yet.` });
    }
    res.json({ success: true, message: `Connected to Resend. ${domain} is ready for the configured sender.` });
  } catch (error) {
    const status = error.response?.status;
    if (status === 401 || status === 403) return res.status(401).json({ error: 'Resend rejected that API key.' });
    console.error('[resend test]', error.message);
    res.status(502).json({ error: 'Could not reach Resend. Check the API key and try again.' });
  }
});

// Test the currently entered Kindle delivery provider without saving it first.
// Resend validates its API key and sender domain; SMTP verifies the connection
// and authentication without sending an actual Kindle message.
app.post('/api/admin/kindle-email/test', requireAdmin, async (req, res) => {
  await settingsReady;
  const provider = String(req.body?.provider || process.env.KINDLE_EMAIL_PROVIDER || 'resend').toLowerCase();
  try {
    if (provider === 'smtp') {
      const config = getKindleMailConfig({
        provider, host: req.body?.host, port: req.body?.port, secure: req.body?.secure,
        username: req.body?.username, password: req.body?.password, fromEmail: req.body?.fromEmail,
      });
      if (!config.host || !config.fromEmail) return res.status(400).json({ error: 'Enter the SMTP host and sender email first.' });
      const transporter = nodemailer.createTransport({
        host: config.host, port: config.port || 587, secure: config.secure,
        auth: config.username ? { user: config.username, pass: config.password } : undefined,
      });
      await transporter.verify();
      return res.json({ success: true, message: 'SMTP connection and login verified. No email was sent.' });
    }
    const config = getKindleMailConfig({ provider, apiKey: req.body?.apiKey, fromEmail: req.body?.fromEmail });
    if (!config.apiKey) return res.status(400).json({ error: 'Enter a Resend API key first.' });
    if (!config.fromEmail || !config.fromEmail.includes('@')) return res.status(400).json({ error: 'Enter the verified Resend sender email first.' });
    const response = await axios.get('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${config.apiKey}` }, timeout: 10000 });
    const domain = config.fromEmail.split('@').pop().toLowerCase();
    const domains = Array.isArray(response.data?.data) ? response.data.data : [];
    const match = domains.find(item => String(item.name || '').toLowerCase() === domain);
    if (match && String(match.status || '').toLowerCase() !== 'verified') return res.status(400).json({ error: `Resend connected, but ${domain} is not verified yet.` });
    return res.json({ success: true, message: `Connected to Resend. ${domain} is ready for Kindle delivery.` });
  } catch (error) {
    console.error('[kindle email test]', error.message);
    const responseMessage = error.response?.data?.message;
    res.status(502).json({ error: responseMessage || 'Connection test failed. Check the details and try again.' });
  }
});

app.post('/api/admin/admin-email/test', requireAdmin, async (req, res) => {
  await settingsReady;
  const provider = String(req.body?.provider || process.env.ADMIN_EMAIL_PROVIDER || 'resend').toLowerCase();
  try {
    if (provider === 'smtp') {
      const config = getAdminMailConfig({
        provider, host: req.body?.host, port: req.body?.port, secure: req.body?.secure,
        username: req.body?.username, password: req.body?.password, fromEmail: req.body?.fromEmail,
      });
      if (!config.host || !config.fromEmail || !config.fromEmail.includes('@')) return res.status(400).json({ error: 'Enter the SMTP host and sender email first.' });
      const transporter = nodemailer.createTransport({
        host: config.host, port: config.port || 587, secure: config.secure,
        auth: config.username ? { user: config.username, pass: config.password } : undefined,
      });
      await transporter.verify();
      return res.json({ success: true, message: 'Admin SMTP connection and login verified. No email was sent.' });
    }
    const config = getAdminMailConfig({ provider: 'resend', apiKey: req.body?.apiKey, fromEmail: req.body?.fromEmail });
    if (!config.apiKey) return res.status(400).json({ error: 'Enter the admin Resend API key first.' });
    if (!config.fromEmail || !config.fromEmail.includes('@')) return res.status(400).json({ error: 'Enter the admin sender email first.' });
    await axios.get('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${config.apiKey}` }, timeout: 10000 });
    return res.json({ success: true, message: 'Admin Resend connection verified. No email was sent.' });
  } catch (error) {
    console.error('[admin email test]', error.message);
    const status = error.response?.status;
    res.status(502).json({ error: status === 401 || status === 403 ? 'Email provider rejected the supplied credentials.' : 'Could not verify the admin email connection.' });
  }
});

// Verify a BookWarehouse deployment using values currently shown in the admin
// form. This does not save anything or expose the API key.
app.post('/api/admin/bookwarehouse/test', requireAdmin, async (req, res) => {
  await settingsReady;
  const base = normaliseBookWarehouseBase(req.body?.url || process.env.BOOKWAREHOUSE_URL);
  const apiKey = String(req.body?.apiKey || process.env.BOOKWAREHOUSE_API_KEY || '').trim();
  if (!apiKey) return res.status(400).json({ error: 'Enter the BookWarehouse API key first.' });
  try {
    await axios.get(`${base}/books?limit=1`, { headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' }, timeout: 10000 });
    res.json({ success: true, message: 'BookWarehouse connection verified. No settings were changed.' });
  } catch (error) {
    console.error('[bookwarehouse test]', error.message);
    const status = error.response?.status;
    if (status === 401 || status === 403) return res.status(401).json({ error: 'BookWarehouse rejected that API key.' });
    res.status(502).json({ error: 'Could not reach BookWarehouse. Check the base URL and API key.' });
  }
});

app.get('/api/admin/administrators', requireAdmin, async (req, res) => {
  const configured = String(process.env.PORTAL_ADMIN_USERNAME || 'admin').trim();
  const designatedRecord = await getPortalDesignatedAdmin();
  const accounts = await getPortalAdminAccounts();
  res.json({
    designated: { username: designatedRecord?.username || configured, source: designatedRecord ? 'portal settings' : 'server bootstrap', removable: false },
    additional: accounts.map(item => ({ username: item.username, created_at: item.created_at || null, removable: true })),
  });
});

app.put('/api/admin/designated-administrator', requireAdmin, async (req, res) => {
  let username = String(req.body?.username || '').trim();
  let password = String(req.body?.password || '');
  if (!username || username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters.' });
  try {
    const existing = await getPortalDesignatedAdmin();
    if (!password && !existing) return res.status(400).json({ error: 'Enter a password for the designated administrator.' });
    if (password && password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    const hashed = password ? hashPortalAdminPassword(password) : { salt: existing.salt, password_hash: existing.password_hash };
    await savePortalDesignatedAdmin({ username, ...hashed, updated_at: new Date().toISOString() });
    res.json({ success: true, username });
  } catch (e) {
    console.error('[designated admin save]', e.message);
    res.status(500).json({ error: 'Could not save the designated administrator. Check CONFIG_ENCRYPTION_KEY and portal_settings.' });
  }
});

app.post('/api/admin/administrators', requireAdmin, async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const configured = String(process.env.PORTAL_ADMIN_USERNAME || 'admin').trim();
  const designated = await getPortalDesignatedAdmin();
  if (!username || username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (username.toLowerCase() === configured.toLowerCase() || username.toLowerCase() === String(designated?.username || '').toLowerCase()) return res.status(400).json({ error: 'That username is reserved for the primary administrator.' });
  try {
    const accounts = await getPortalAdminAccounts();
    const existing = accounts.findIndex(item => String(item.username).toLowerCase() === username.toLowerCase());
    const hashed = hashPortalAdminPassword(password);
    const record = { username, ...hashed, created_at: new Date().toISOString() };
    if (existing >= 0) accounts[existing] = record; else accounts.push(record);
    await savePortalAdminAccounts(accounts);
    res.json({ success: true, username });
  } catch (e) {
    console.error('[admin account save]', e.message);
    res.status(500).json({ error: 'Could not save administrator. Check CONFIG_ENCRYPTION_KEY and portal_settings.' });
  }
});

app.delete('/api/admin/administrators/:username', requireAdmin, async (req, res) => {
  const username = String(req.params.username || '').trim();
  const configured = String(process.env.PORTAL_ADMIN_USERNAME || 'admin').trim();
  const designated = await getPortalDesignatedAdmin();
  if (!username || username.toLowerCase() === configured.toLowerCase() || username.toLowerCase() === String(designated?.username || '').toLowerCase()) return res.status(400).json({ error: 'The primary administrator cannot be removed here.' });
  try {
    const accounts = await getPortalAdminAccounts();
    await savePortalAdminAccounts(accounts.filter(item => String(item.username).toLowerCase() !== username.toLowerCase()));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Could not remove administrator.' }); }
});

// Service credentials linked to the dedicated portal-admin account are stored
// encrypted in portal_settings.  They are not environment variables and are
// never used to authenticate an ordinary member as an administrator.
app.post('/api/admin/services/link', requireAdmin, async (req, res) => {
  const service = String(req.body?.service || '').trim().toLowerCase();
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!req.session.user.admin_login) return res.status(403).json({ error: 'Only the dedicated portal administrator can link services.' });
  if (!['emby', 'silo'].includes(service)) return res.status(400).json({ error: 'Choose Emby or Silo.' });
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
  try {
    const metadata = {};
    if (service === 'emby') {
      const auth = await embyAuthenticate(username, password);
      if (!auth?.User) return res.status(401).json({ error: 'Those Emby credentials were not accepted.' });
      metadata.user_id = auth.User.Id;
    } else {
      const auth = await siloAuthenticate(username, password);
      const user = auth?.user || auth?.User;
      if (!user) return res.status(401).json({ error: 'Those Silo credentials were not accepted.' });
      metadata.user_id = user.id ?? user.user_id;
    }
    await saveAdminLinkedService(service, username, password, metadata);
    res.json({ success: true, service, username });
  } catch (e) { res.status(500).json({ error: 'Could not save that service.' }); }
});

app.delete('/api/admin/services/:service', requireAdmin, async (req, res) => {
  if (!req.session.user.admin_login) return res.status(403).json({ error: 'Only the dedicated portal administrator can unlink services.' });
  const service = String(req.params.service || '').trim().toLowerCase();
  if (!['emby', 'silo'].includes(service)) return res.status(400).json({ error: 'Unknown service.' });
  try {
    await deleteAdminLinkedService(service);
    res.json({ success: true, service });
  } catch (e) {
    console.error('[admin service unlink]', e.message);
    res.status(500).json({ error: 'Could not unlink that service.' });
  }
});

// A primary member may verify one of their existing services from the portal.
// This deliberately does not create accounts, move ownership, save credentials,
// or grant new permissions: the login must already belong to the same Discord
// account that Portal has linked in PostgreSQL. Sub-users cannot use this route.
app.get('/api/provider-status', requireAuth, async (req, res) => {
  await settingsReady;
  const configured = key => Boolean(process.env[key]);
  res.json({ providers: {
    emby: { configured: configured('EMBY_URL') && configured('EMBY_API_KEY'), url: process.env.EMBY_URL || '' },
    silo: { configured: configured('SILO_URL') && configured('SILO_API_KEY'), url: process.env.SILO_URL || '' },
    plex: { configured: configured('PLEX_URL') && configured('PLEX_TOKEN'), url: process.env.PLEX_URL || '' },
    jellyfin: { configured: configured('JELLYFIN_URL') && configured('JELLYFIN_API_KEY'), url: process.env.JELLYFIN_URL || '' },
    library: { configured: configured('BOOKWAREHOUSE_URL') && configured('BOOKWAREHOUSE_API_KEY'), url: process.env.BOOKWAREHOUSE_URL || '' },
  }});
});

app.get('/admin', requireAdmin, (req, res) => {
  res.redirect('/dashboard#administration');
});

function discordBotTarHeader(name, size) {
  const header = Buffer.alloc(512);
  const write = (offset, length, value) => header.write(String(value), offset, length, 'utf8');
  write(0, 100, name);
  write(100, 8, '0000644');
  write(108, 8, '0000000');
  write(116, 8, '0000000');
  write(124, 12, String(size.toString(8).padStart(11, '0')) + ' ');
  write(136, 12, '00000000000 ');
  header[156] = 48;
  write(257, 6, 'ustar');
  write(263, 2, '00');
  const checksum = [...header].reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
  write(148, 8, String(checksum.toString(8).padStart(6, '0')) + ' ');
  return header;
}
function discordBotTarGz(entries) {
  const chunks = [];
  for (const [name, value] of Object.entries(entries)) {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
    chunks.push(discordBotTarHeader(name, data.length), data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(chunks), { level: 9 });
}
app.post('/api/admin/discord-bot/bundle', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const pricing = body.pricing && typeof body.pricing === 'object' ? body.pricing : {};
    const identity = body.identity && typeof body.identity === 'object' ? body.identity : {};
    const deployment = body.deployment && typeof body.deployment === 'object' ? body.deployment : {};
    const providerDefs = {
      emby: ['EMBY_URL', 'EMBY_API_KEY', 'EMBY_ROLE_IDS'],
      silo: ['SILO_URL', 'SILO_API_KEY', 'SILO_ROLE_IDS'],
      jellyfin: ['JELLYFIN_URL', 'JELLYFIN_API_KEY', 'JELLYFIN_ROLE_IDS'],
      plex: ['PLEX_URL', 'PLEX_TOKEN', 'PLEX_ROLE_IDS'],
    };
    const selected = Object.keys(providerDefs).filter(key => pricing.providers?.[key]?.enabled !== false && PORTAL_CONFIG_FIELDS.some(field => field.key === providerDefs[key][0] && (process.env[field.key] || portalSettings.has(field.key))));
    const required = [...new Set(['DISCORD_TOKEN', 'CLIENT_ID', 'DISCORD_GUILD_ID', 'DATABASE_URL', 'PRICING_JSON', ...selected.flatMap(key => providerDefs[key])])];
    const envExample = [
      '# Copy to .env on the bot VPS. Never commit the completed .env.',
      ...required.map(key => key === 'DATABASE_URL' ? 'DATABASE_URL=postgres://portal:REPLACE_ON_HOST@db:5432/portal' : key === 'PRICING_JSON' ? 'PRICING_JSON=' : key + '=REPLACE_ON_HOST'),
      '',
    ].join('\n');
    const safeDeployment = { target: 'vps', githubRepo: String(deployment.githubRepo || '').slice(0, 300), githubBranch: String(deployment.githubBranch || 'main').slice(0, 120), vpsDirectory: String(deployment.vpsDirectory || '/opt/portal-discord-bot').replace(/[\r\n]/g, ' ').slice(0, 300) };
    const manifest = { version: 1, generatedAt: new Date().toISOString(), warning: 'Non-secret configuration manifest. Add tokens and provider API keys only as host environment variables.', mediaServers: Object.fromEntries(selected.map(key => [key, { configured: true, enabled: pricing.providers?.[key]?.enabled !== false, requiredEnv: providerDefs[key] }])), pricing, identity, deployment: safeDeployment, commands: ['pricing', 'ticketpanel', 'ticketclose', ...selected.flatMap(key => { const prefix = { emby:'emb', silo:'silo', jellyfin:'jelly', plex:'plex' }[key]; return DISCORD_BOT_COMMAND_GUIDE.map(([suffix]) => prefix + suffix); })], requiredEnvironment: required };
    const templateRoot = path.join(__dirname, 'public', 'discord-bot-template');
    const names = ['index.js', 'db.js', 'package.json', 'README.md', 'CUSTOMIZATIONS.md', 'DEPLOY.md', 'Dockerfile', 'docker-compose.yml', 'discord_bot_memberships.sql', 'announcements.sql'];
    const entries = { 'portal-discord-bot/bot-config.json': JSON.stringify(manifest, null, 2), 'portal-discord-bot/env.example': envExample };
    for (const name of names) entries['portal-discord-bot/' + name] = fs.readFileSync(path.join(templateRoot, name));
    const archive = discordBotTarGz(entries);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', 'attachment; filename="portal-discord-bot-bundle.tar.gz"');
    res.send(archive);
  } catch (error) {
    console.error('[admin/discord-bot/bundle]', error.message);
    res.status(500).json({ error: 'Unable to build the Discord bot bundle.' });
  }
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const configured = {
    emby: Boolean(process.env.EMBY_URL && process.env.EMBY_API_KEY),
    silo: Boolean(process.env.SILO_URL && process.env.SILO_API_KEY),
    plex: Boolean(process.env.PLEX_URL && process.env.PLEX_TOKEN),
    jellyfin: Boolean(process.env.JELLYFIN_URL && process.env.JELLYFIN_API_KEY),
  };

  try {
    const [embyResult, siloResult] = await Promise.all([
      db.from('emby_accounts').select('*'),
      db.from('silo_accounts').select('*'),
    ]);
    const firstError = [embyResult?.error, siloResult?.error].find(Boolean);
    if (firstError) throw firstError;

    // IPTV is not part of the PostgreSQL public schema. Keep the response
    // shape compatible with the dashboard so the provider tabs remain stable.
    res.json({
      emby: embyResult?.data || [],
      silo: siloResult?.data || [],
      iptv: [],
      iptvLines: [],
      configured,
    });
  } catch (error) {
    console.error('[admin/users]', error.message);
    res.status(500).json({ error: 'Unable to load users.' });
  }
});

function serviceUserExpiry(body) {
  if (body?.lifetime === true || !body?.expires_at) return { expires_at: null, is_lifetime: true, is_trial: false };
  const date = new Date(body.expires_at);
  if (Number.isNaN(date.getTime()) || date <= new Date()) throw new Error('Choose a future expiry date or select lifetime.');
  return { expires_at: date.toISOString(), is_lifetime: false, is_trial: false };
}

function generatedServicePassword() {
  return crypto.randomBytes(9).toString('base64url');
}

app.post('/api/admin/service-user/create', requireAdmin, async (req, res) => {
  const service = String(req.body?.service || '').trim().toLowerCase();
  const username = String(req.body?.username || '').trim();
  const discordUserId = String(req.body?.discord_user_id || '').trim();
  const password = String(req.body?.password || '').trim() || generatedServicePassword();
  const connections = Math.max(1, Math.min(50, Number(req.body?.connections) || 1));
  if (!['emby', 'silo', 'plex', 'jellyfin'].includes(service)) return res.status(400).json({ error: 'Choose a supported media service.' });
  if (!username) return res.status(400).json({ error: 'Username is required.' });
  if (!discordUserId) return res.status(400).json({ error: 'Discord user ID is required so all login methods share the same account.' });
  if (service === 'plex') return res.status(409).json({ error: 'Plex user creation needs the Plex Home/users bridge; Plex PMS does not provide a reliable portal-side account and per-user stream-limit API.' });
  if (service === 'jellyfin') return res.status(409).json({ error: 'Jellyfin user creation is reserved for the StreamLimit integration and its configured plugin endpoint.' });
  let expiry;
  try { expiry = serviceUserExpiry(req.body); } catch (error) { return res.status(400).json({ error: error.message }); }
  try {
    if (service === 'emby') {
      const created = await embyRequest('POST', '/Users/New', { Name: username, Password: password });
      const userId = created?.Id || created?.id;
      if (!userId) throw new Error('Emby did not return a user ID.');
      await embyRequest('POST', `/Users/${encodeURIComponent(userId)}/Policy`, { IsDisabled: false, SimultaneousStreamLimit: connections });
      const { error } = await db.from('emby_accounts').insert({ discord_user_id: discordUserId, emby_user_id: userId, username, password, connections, total_pool: connections, ...expiry });
      if (error) throw error;
      return res.status(201).json({ success: true, service, username, password, user_id: userId });
    }
    const created = await siloAdminRequest('POST', '/api/v1/admin/users', {
      username,
      email: String(req.body?.email || `${username.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'user'}@portal.invalid`),
      password,
      role: 'user',
      max_streams: connections,
      max_transcodes: 0,
      create_default_profile: true,
    });
    const userId = created?.id || created?.user?.id || created?.data?.id;
    if (!userId) throw new Error('Silo did not return a user ID.');
    const { error } = await db.from('silo_accounts').insert({ discord_user_id: discordUserId, silo_user_id: String(userId), username, password, connections, total_pool: connections, ...expiry });
    if (error) throw error;
    return res.status(201).json({ success: true, service, username, password, user_id: String(userId) });
  } catch (error) {
    console.error('[admin/service-user/create]', service, error.response?.data || error.message);
    res.status(502).json({ error: `${service[0].toUpperCase() + service.slice(1)} rejected the new account or the portal record could not be saved.` });
  }
});

app.post('/api/admin/silo/create-subuser', requireAdmin, async (req, res) => {
  const parentId = String(req.body?.parent_silo_user_id || '').trim();
  const username = String(req.body?.username || '').trim();
  if (!parentId || !username) return res.status(400).json({ error: 'Parent Silo account and username are required.' });
  try {
    const { data: parent, error: parentError } = await db.from('silo_accounts').select('*').eq('silo_user_id', parentId).maybeSingle();
    if (parentError || !parent) return res.status(404).json({ error: 'Parent Silo account was not found.' });
    if (!parent.is_lifetime) return res.status(400).json({ error: 'Only lifetime Silo parents can create sub-users.' });
    const { data: children, error: childrenError } = await db.from('silo_accounts').select('silo_user_id,connections').eq('parent_silo_user_id', parentId);
    if (childrenError) throw childrenError;
    if ((children || []).length >= 5) return res.status(400).json({ error: 'A Silo parent can have up to 5 sub-users.' });
    const requested = Math.max(1, Number(req.body?.connections) || 1);
    const pool = Math.max(1, Number(parent.total_pool || parent.connections || 1));
    const allocated = (children || []).reduce((sum, child) => sum + Math.max(0, Number(child.connections) || 0), 0);
    if (allocated + requested > pool) return res.status(400).json({ error: `The parent has ${Math.max(0, pool - allocated)} stream(s) available.` });
    const password = String(req.body?.password || '').trim() || generatedServicePassword();
    const expiry = serviceUserExpiry(req.body);
    const created = await siloAdminRequest('POST', '/api/v1/admin/users', {
      username,
      email: String(req.body?.email || `${username.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'subuser'}@portal.invalid`),
      password,
      role: 'user',
      max_streams: requested,
      max_transcodes: 0,
      create_default_profile: true,
    });
    const userId = created?.id || created?.user?.id || created?.data?.id;
    if (!userId) throw new Error('Silo did not return a sub-user ID.');
    const { error } = await db.from('silo_accounts').insert({
      discord_user_id: parent.discord_user_id || null,
      friend_of_discord_id: parent.friend_of_discord_id || parent.discord_user_id || null,
      silo_user_id: String(userId), username, password, connections: requested, total_pool: requested,
      parent_silo_user_id: parentId, is_friend_account: true, ...expiry,
    });
    if (error) throw error;
    res.status(201).json({ success: true, service: 'silo', username, password, user_id: String(userId), parent_user_id: parentId });
  } catch (error) {
    console.error('[admin/silo/create-subuser]', error.response?.data || error.message);
    res.status(502).json({ error: 'Silo rejected the sub-user or the portal record could not be saved.' });
  }
});

app.post('/api/admin/user/edit', requireAdmin, async (req, res) => {
  const { emby_user_id, username, password, connections, expires_at, connect_email } = req.body;
  if (!emby_user_id) return res.json({ error: 'Missing emby_user_id' });

  const embyUser = await embyRequest('GET', `/Users/${emby_user_id}`);
  if (embyUser && embyUser.Name !== username) {
    embyUser.Name = username;
    await embyRequest('POST', `/Users/${emby_user_id}`, embyUser);
  }

  if (password) {
    await embySetPassword(emby_user_id, password);
  }

  const update = { username, connections, connect_email: connect_email || null };
  if (expires_at) {
    update.expires_at = new Date(expires_at).toISOString();
    update.is_lifetime = false;
    update.is_trial = false;
  } else {
    update.expires_at = null;
    update.is_lifetime = true;
    update.is_trial = false;
    update.total_pool = connections;
  }
  if (password) update.password = password;

  try {
    const embyUserRes = await axios.get(`${process.env.EMBY_URL}/emby/Users/${emby_user_id}`, {
      headers: { 'X-Emby-Token': process.env.EMBY_API_KEY },
      timeout: 8000
    });
    const embyUserData = embyUserRes.data;
    embyUserData.Policy.SimultaneousStreamLimit = connections;
    await axios.post(`${process.env.EMBY_URL}/emby/Users/${emby_user_id}/Policy`, embyUserData.Policy, {
      headers: { 'X-Emby-Token': process.env.EMBY_API_KEY, 'Content-Type': 'application/json' },
      timeout: 8000
    });
  } catch(e) {
    console.error('Admin stream sync error:', e.message);
  }

  const { error } = await db.from('emby_accounts').update(update).eq('emby_user_id', emby_user_id);
  if (error) return res.json({ error: 'Failed to update' });
  res.json({ success: true });
});

app.post('/api/admin/silo/edit', requireAdmin, async (req, res) => {
  const siloUserId = String(req.body?.silo_user_id || '').trim();
  if (!siloUserId) return res.status(400).json({ error: 'Missing Silo user ID' });
  const update = {};
  if (req.body.username !== undefined) update.username = String(req.body.username || '').trim();
  if (req.body.password) update.password = String(req.body.password);
  if (req.body.connections !== undefined) update.connections = Math.max(1, Number(req.body.connections) || 1);
  if (req.body.expires_at) {
    update.expires_at = new Date(req.body.expires_at).toISOString();
    update.is_lifetime = false;
    update.is_trial = false;
  } else if (req.body.is_lifetime === true) {
    update.expires_at = null;
    update.is_lifetime = true;
    update.is_trial = false;
  }
  try {
    const remote = {};
    if (update.username) remote.username = update.username;
    if (update.password) remote.password = update.password;
    if (update.connections) remote.connections = update.connections;
    if (Object.keys(remote).length) await siloAdminRequest('PUT', `/api/v1/admin/users/${encodeURIComponent(siloUserId)}`, remote);
    const { error } = await db.from('silo_accounts').update(update).eq('silo_user_id', siloUserId);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    console.error('[admin/silo/edit]', e.response?.data || e.message);
    res.status(502).json({ error: 'Silo rejected the update or the account could not be synced.' });
  }
});

// Delete a linked service account from both its provider and the portal.
// Parent Emby/Silo accounts include every linked sub-user in the same request.
app.delete('/api/admin/account', requireAdmin, async (req, res) => {
  const service = String(req.body?.service || '').trim().toLowerCase();
  const embyUserId = String(req.body?.emby_user_id || '').trim();
  const siloUserId = String(req.body?.silo_user_id || '').trim();
  if (!['emby', 'silo'].includes(service)) return res.status(400).json({ error: 'Unsupported account service.' });
  try {
    if (service === 'emby') {
      if (!embyUserId) return res.status(400).json({ error: 'Missing Emby user ID.' });
      const { data: account } = await db.from('emby_accounts').select('emby_user_id').eq('emby_user_id', embyUserId).maybeSingle();
      if (!account) return res.status(404).json({ error: 'Emby account was not found.' });
      const { data: children } = await db.from('emby_accounts').select('emby_user_id').eq('parent_emby_user_id', embyUserId);
      const ids = [embyUserId, ...(children || []).map(item => String(item.emby_user_id || '')).filter(Boolean)];
      for (const id of ids) { try { await axios.delete(`${process.env.EMBY_URL}/emby/Users/${encodeURIComponent(id)}`, { headers: { 'X-Emby-Token': process.env.EMBY_API_KEY }, timeout: 8000 }); } catch (error) { if (Number(error.response?.status) !== 404) throw error; } }
      await db.from('emby_accounts').delete().in('emby_user_id', ids);
      return res.json({ success: true, deleted: ids.length, service });
    }
    if (!siloUserId) return res.status(400).json({ error: 'Missing Silo user ID.' });
    const { data: account } = await db.from('silo_accounts').select('silo_user_id').eq('silo_user_id', siloUserId).maybeSingle();
    if (!account) return res.status(404).json({ error: 'Silo account was not found.' });
    const { data: children } = await db.from('silo_accounts').select('silo_user_id').eq('parent_silo_user_id', siloUserId);
    const ids = [siloUserId, ...(children || []).map(item => String(item.silo_user_id || '')).filter(Boolean)];
    for (const id of ids) { try { await siloAdminRequest('DELETE', `/api/v1/admin/users/${encodeURIComponent(id)}`); } catch (error) { if (Number(error.response?.status) !== 404) throw error; } }
    await db.from('silo_accounts').delete().in('silo_user_id', ids);
    return res.json({ success: true, deleted: ids.length, service });
  } catch (error) { return res.status(502).json({ error: `The ${service} account could not be deleted from its provider.` }); }
});

app.delete('/api/admin/user/:emby_user_id', requireAdmin, async (req, res) => {
  const { emby_user_id } = req.params;
  try {
    await axios({
      method: 'DELETE',
      url: `${process.env.EMBY_URL}/emby/Users/${emby_user_id}`,
      headers: { 'X-Emby-Token': process.env.EMBY_API_KEY },
      timeout: 8000
    });
  } catch(e) {
    console.error('Admin Emby delete error:', e.response?.status, e.response?.data?.Message || e.message);
    return res.json({ error: 'Failed to delete from Emby: ' + (e.response?.data?.Message || e.message) });
  }
  await db.from('emby_accounts').delete().eq('emby_user_id', emby_user_id);
  res.json({ success: true });
});

// ─── ADMIN: Disable / Enable Emby account ─────────────────────────────────────
app.post('/api/admin/user/toggle-disable', requireAdmin, async (req, res) => {
  const { emby_user_id, disable } = req.body;
  try {
    // Disable/enable the main account on Emby
    const userRes = await axios.get(`${process.env.EMBY_URL}/emby/Users/${emby_user_id}`, {
      headers: { 'X-Emby-Token': process.env.EMBY_API_KEY }, timeout: 8000
    });
    const policy = userRes.data.Policy || {};
    policy.IsDisabled = disable;
    await axios.post(`${process.env.EMBY_URL}/emby/Users/${emby_user_id}/Policy`, policy, {
      headers: { 'X-Emby-Token': process.env.EMBY_API_KEY }, timeout: 8000
    });
    await db.from('emby_accounts').update({ is_disabled: disable }).eq('emby_user_id', emby_user_id);

    // Also disable/enable all sub-accounts
    const { data: subs } = await db
      .from('emby_accounts')
      .select('emby_user_id')
      .eq('parent_emby_user_id', emby_user_id);
    for (const sub of subs || []) {
      try {
        const subRes = await axios.get(`${process.env.EMBY_URL}/emby/Users/${sub.emby_user_id}`, {
          headers: { 'X-Emby-Token': process.env.EMBY_API_KEY }, timeout: 8000
        });
        const subPolicy = subRes.data.Policy || {};
        subPolicy.IsDisabled = disable;
        await axios.post(`${process.env.EMBY_URL}/emby/Users/${sub.emby_user_id}/Policy`, subPolicy, {
          headers: { 'X-Emby-Token': process.env.EMBY_API_KEY }, timeout: 8000
        });
        await db.from('emby_accounts').update({ is_disabled: disable }).eq('emby_user_id', sub.emby_user_id);
      } catch(e) {
        console.error('Sub disable error:', sub.emby_user_id, e.message);
      }
    }

    res.json({ success: true, is_disabled: disable });
  } catch(e) {
    console.error('Admin disable error:', e.response?.data?.Message || e.message);
    res.json({ error: e.response?.data?.Message || e.message });
  }
});

// Special libraries that use different exclude fields
const LATEST_ITEMS_EXCLUDE_IDS = {
  '1605282': '0181be9d715a45afa07cf521b0f6c605',
};
const MY_MEDIA_EXTRA_EXCLUDE_IDS = {
  '1594737': '83e1dcb33d414eec9683dab471472121', // Collections
  '1564892': '862dc059229b48c19d237b0ec164fbde', // Playlists
};
const DISPLAY_PREFS_LIBRARIES = {
  '1594737': 'collections',
  '1564892': 'playlists',
};
const COLLECTIONS_ID = '1594737';
const PLAYLISTS_ID = '1564892';

// ─── LIBRARIES PAGE ───────────────────────────────────────────────────────────
// Static icon proxy — fetches icon from a given URL, cached server-side
const _staticIconCache = {};
app.get('/api/static-icon', async (req, res) => {
  const { url } = req.query;
  if (!url || !/^https:\/\//.test(url)) return res.status(400).json({ error: 'Invalid URL' });
  try {
    if (_staticIconCache[url] && _staticIconCache[url].expires > Date.now()) {
      res.set('Content-Type', _staticIconCache[url].type);
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(_staticIconCache[url].data);
    }
    const imgRes = await axios.get(url, { responseType: 'arraybuffer', timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const buf = Buffer.from(imgRes.data);
    const type = imgRes.headers['content-type'] || 'image/png';
    _staticIconCache[url] = { data: buf, type, expires: Date.now() + 24 * 60 * 60 * 1000 };
    res.set('Content-Type', type);
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(buf);
  } catch (e) {
    res.status(502).json({ error: 'Icon fetch failed' });
  }
});

// Google Play icon proxy — scrapes icon from Play Store page server-side
const _gpIconCache = {};
app.get('/api/gp-icon/:packageName', async (req, res) => {
  const { packageName } = req.params;
  if (!/^[a-zA-Z0-9._]+$/.test(packageName)) return res.status(400).json({ error: 'Invalid package name' });
  try {
    // Serve from cache if valid
    if (_gpIconCache[packageName] && _gpIconCache[packageName].expires > Date.now()) {
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(_gpIconCache[packageName].data);
    }
    // Fetch Play Store page
    const page = await axios.get(`https://play.google.com/store/apps/details?id=${packageName}&hl=en`, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    // Extract icon URL — try multiple patterns
    let iconUrl = null;
    const patterns = [
      /https:\/\/play-lh\.googleusercontent\.com\/[^"'\\)]+(?=['"\\)])/g,
      /"https:\/\/(play-lh\.googleusercontent\.com\/[^"]+)"/g
    ];
    for (const pattern of patterns) {
      const matches = page.data.match(pattern);
      if (matches && matches.length > 0) {
        iconUrl = matches[0].replace(/['"]/g, '');
        // Append size param for best quality
        if (!iconUrl.includes('=w')) iconUrl += '=w256-h256-rw';
        break;
      }
    }
    if (!iconUrl) return res.status(404).json({ error: 'Icon not found in page' });
    // Fetch the actual image
    const imgRes = await axios.get(iconUrl, {
      responseType: 'arraybuffer', timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const buf = Buffer.from(imgRes.data);
    _gpIconCache[packageName] = { data: buf, expires: Date.now() + 24 * 60 * 60 * 1000 };
    res.set('Content-Type', imgRes.headers['content-type'] || 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(buf);
  } catch (e) {
    console.error(`[gp-icon] Failed for ${packageName}:`, e.message);
    res.status(502).json({ error: 'Icon fetch failed' });
  }
});

// iTunes app icon proxy — fetches icon from Apple's API server-side to avoid CORS/hotlink blocks
const _iconCache = {};
app.get('/api/app-icon/:appId', async (req, res) => {
  const { appId } = req.params;
  if (!/^\d+$/.test(appId)) return res.status(400).json({ error: 'Invalid app ID' });
  // Served from locally cached files (downloaded once) — avoids a slow
  // round-trip to Apple's CDN on every dashboard load.
  const localPath = path.join(__dirname, 'public', 'app-icons', `${appId}.jpg`);
  if (fs.existsSync(localPath)) {
    res.set('Cache-Control', 'public, max-age=604800'); // 1 week browser cache
    return res.sendFile(localPath);
  }
  // Fallback: app not pre-downloaded — fetch live and redirect (rare path)
  try {
    const { data } = await axios.get(`https://itunes.apple.com/lookup?id=${appId}`, { timeout: 5000 });
    const result = data?.results?.[0];
    if (!result) return res.status(404).json({ error: 'App not found' });
    const iconUrl = result.artworkUrl512 || result.artworkUrl100 || result.artworkUrl60;
    res.redirect(iconUrl);
  } catch (e) {
    res.status(502).json({ error: 'Icon fetch failed' });
  }
});

app.get('/libraries', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'libraries.html'));
});

// ─── API: Get user libraries ───────────────────────────────────────────────────
// Per-user library cache (5 min TTL — invalidated on POST)
const _libCache = {};
app.get('/api/libraries', requireAuth, async (req, res) => {
  const { emby_user_id } = req.session.user;
  const cacheEntry = _libCache[emby_user_id];
  if (cacheEntry && Date.now() - cacheEntry.ts < 5 * 60 * 1000) {
    return res.json(cacheEntry.data);
  }
  try {
    // Run independent requests in parallel with timeouts
    const [userRes, viewsRes] = await Promise.all([
      axios.get(`${process.env.EMBY_URL}/emby/Users/${emby_user_id}`, {
        headers: { 'X-Emby-Token': process.env.EMBY_API_KEY },
        timeout: 8000
      }),
      axios.get(`${process.env.EMBY_URL}/emby/Users/${emby_user_id}/Views`, {
        headers: { 'X-Emby-Token': process.env.EMBY_API_KEY },
        timeout: 8000
      })
    ]);

    const config = userRes.data.Configuration;
    const orderedViews = config.OrderedViews || [];
    const myMediaExcludes = config.MyMediaExcludes || [];
    const latestItemsExcludes = config.LatestItemsExcludes || [];

    // Get GUID->name mapping and DisplayPreferences in parallel
    const [guidToName, dispPrefsVisible] = await Promise.all([
      // GUID lookup
      (async () => {
        const map = {};
        if (orderedViews.length > 0) {
          try {
            const itemsRes = await axios.get(`${process.env.EMBY_URL}/emby/Items`, {
              headers: { 'X-Emby-Token': process.env.EMBY_API_KEY },
              params: { Ids: orderedViews.join(',') },
              timeout: 8000
            });
            itemsRes.data.Items.forEach((item, idx) => {
              map[orderedViews[idx]] = item.Name;
            });
          } catch(e) {
            console.error('Items fetch error:', e.message);
          }
        }
        return map;
      })(),
      // DisplayPreferences lookup + auto-setup missing sections
      (async () => {
        const visible = {};
        try {
          const dispRes = await axios.get(`${process.env.EMBY_URL}/emby/DisplayPreferences/usersettings`, {
            headers: { 'X-Emby-Token': process.env.EMBY_API_KEY },
            params: { userId: emby_user_id, client: 'emby' },
            timeout: 8000
          });
          const dispPrefs = dispRes.data;
          const prefs = dispPrefs.CustomPrefs || {};
          const activeValues = Object.values(prefs);

          // Auto-add any missing Collections/Playlists sections
          let prefsChanged = false;
          Object.entries(DISPLAY_PREFS_LIBRARIES).forEach(([id, sectionValue]) => {
            const alreadyPresent = activeValues.some(v => v === sectionValue);
            if (!alreadyPresent) {
              // Find a 'none' slot to reuse, or add a new section
              const noneSection = Object.entries(prefs).find(([k, v]) => v === 'none');
              if (noneSection) {
                prefs[noneSection[0]] = sectionValue;
              } else {
                const indices = Object.keys(prefs)
                  .map(k => parseInt(k.replace('homesection', '')))
                  .filter(n => !isNaN(n));
                const nextIdx = indices.length > 0 ? Math.max(...indices) + 1 : 0;
                prefs[`homesection${nextIdx}`] = sectionValue;
              }
              prefsChanged = true;
              console.log(`Auto-added ${sectionValue} section for user ${emby_user_id}`);
            }
          });

          if (prefsChanged) {
            dispPrefs.CustomPrefs = prefs;
            // Fire-and-forget — don't block the response on this write
            axios.post(`${process.env.EMBY_URL}/emby/DisplayPreferences/usersettings`, dispPrefs, {
              headers: { 'X-Emby-Token': process.env.EMBY_API_KEY, 'Content-Type': 'application/json' },
              params: { userId: emby_user_id, client: 'emby' },
              timeout: 8000
            }).catch(e => console.error('DisplayPrefs auto-setup write error:', e.message));
          }

          const updatedValues = Object.values(prefs);
          Object.entries(DISPLAY_PREFS_LIBRARIES).forEach(([id, sectionValue]) => {
            visible[id] = updatedValues.some(v => v === sectionValue);
          });
        } catch(e) {
          console.error('DisplayPrefs fetch error:', e.message);
          Object.keys(DISPLAY_PREFS_LIBRARIES).forEach(id => { visible[id] = true; });
        }
        return visible;
      })()
    ]);

    const nameToGuid = {};
    Object.entries(guidToName).forEach(([guid, name]) => {
      nameToGuid[name] = guid;
    });

    // Hardcoded library order — ensures all libraries always appear in the correct order
    // regardless of what the Views API returns
    const ALL_LIBRARIES = [
      { Id: '3',       Name: 'Movies' },
      { Id: '34011',   Name: 'TV Shows' },
      { Id: '37813',   Name: 'Movies Anime' },
      { Id: '38357',   Name: 'TV Anime' },
      { Id: '38797',   Name: "Movies INT'L" },
      { Id: '39247',   Name: "TV INT'L" },
      { Id: '1605282', Name: 'Sports' },
      { Id: '1594737', Name: 'Collections' },
      { Id: '1564892', Name: 'Playlists' },
    ];
    // Merge: use hardcoded list as base order, add any unknown libraries from API at the end
    const apiIds = new Set(viewsRes.data.Items.map(v => v.Id));
    const knownIds = new Set(ALL_LIBRARIES.map(l => l.Id));
    const extraFromApi = viewsRes.data.Items.filter(v => !knownIds.has(v.Id));
    const viewItems = [...ALL_LIBRARIES, ...extraFromApi];

    const libraries = viewItems.map(view => {
      const guid = nameToGuid[view.Name] || view.Id;
      // Emby's Home Screen library switches are backed by MyMediaExcludes.
      let isExcluded = myMediaExcludes.includes(String(guid)) || myMediaExcludes.includes(String(view.Id));
      if (LATEST_ITEMS_EXCLUDE_IDS[view.Id]) {
        isExcluded = isExcluded || latestItemsExcludes.includes(LATEST_ITEMS_EXCLUDE_IDS[view.Id]);
      }
      if (MY_MEDIA_EXTRA_EXCLUDE_IDS[view.Id]) {
        isExcluded = isExcluded || myMediaExcludes.includes(MY_MEDIA_EXTRA_EXCLUDE_IDS[view.Id]);
      }
      if (DISPLAY_PREFS_LIBRARIES[view.Id] !== undefined) {
        isExcluded = dispPrefsVisible[view.Id] === false;
      }
      return {
        id: (DISPLAY_PREFS_LIBRARIES[view.Id] !== undefined) ? view.Id : (guid !== view.Id ? guid : view.Id),
        numericId: view.Id,
        guid: guid !== view.Id ? guid : null,
        name: view.Name,
        enabled: !isExcluded
      };
    });

    const { data: account } = await db
      .from('emby_accounts')
      .select('username')
      .eq('emby_user_id', emby_user_id)
      .maybeSingle();

    const payload = {
      libraries,
      myMediaExcludes,
      username: account?.username,
      discord: {
        id: req.session.user.discord_id,
        avatar: req.session.user.discord_avatar
      }
    };
    // Cache for 5 minutes
    _libCache[emby_user_id] = { data: payload, ts: Date.now() };
    res.json(payload);
  } catch(e) {
    console.error('Library fetch error:', e.response?.status, e.message);
    res.json({ error: 'Failed to fetch libraries' });
  }
});
app.post('/api/libraries/:id/toggle', requireAuth, async (req, res) => {
  const { emby_user_id } = req.session.user;
  const requestedId = String(req.params.id || '');
  if (!emby_user_id || !requestedId) return res.status(400).json({ error: 'Missing library ID' });
  try {
    const [userRes, viewsRes] = await Promise.all([
      axios.get(`${process.env.EMBY_URL}/emby/Users/${emby_user_id}`, {
        headers: { 'X-Emby-Token': process.env.EMBY_API_KEY }, timeout: 8000
      }),
      axios.get(`${process.env.EMBY_URL}/emby/Users/${emby_user_id}/Views`, {
        headers: { 'X-Emby-Token': process.env.EMBY_API_KEY }, timeout: 8000
      })
    ]);
    const user = userRes.data || {};
    const config = { ...(user.Configuration || {}) };
    const views = viewsRes.data?.Items || [];
    const stableNames = {
      '3': 'Movies', '34011': 'TV Shows', '37813': 'Movies Anime', '38357': 'TV Anime',
      '38797': "Movies INT'L", '39247': "TV INT'L", '1605282': 'Sports',
      '1594737': 'Collections', '1564892': 'Playlists'
    };
    const target = views.find(v => String(v.Id) === requestedId || String(v.Name) === requestedId || String(v.Name) === stableNames[requestedId]);
    if (!target) return res.status(404).json({ error: 'Library not found' });

    const current = new Set((Array.isArray(config.MyMediaExcludes) ? config.MyMediaExcludes : []).map(String));
    let targetId = String(target.Id);
    // OrderedViews/Items gives the same GUID used in MyMediaExcludes on this
    // server, even when the Views endpoint exposes a stable numeric ID.
    const orderedViews = Array.isArray(config.OrderedViews) ? config.OrderedViews : [];
    if (orderedViews.length) {
      try {
        const itemsRes = await axios.get(`${process.env.EMBY_URL}/emby/Items`, {
          headers: { 'X-Emby-Token': process.env.EMBY_API_KEY },
          params: { Ids: orderedViews.join(',') }, timeout: 8000
        });
        const matching = (itemsRes.data?.Items || []).find(item => String(item.Name) === String(target.Name));
        if (matching?.Id) targetId = String(matching.Id);
      } catch (e) {
        console.error('Library toggle GUID lookup error:', e.message);
      }
    }
    const wasExcluded = current.has(targetId);
    if (wasExcluded) current.delete(targetId); else current.add(targetId);

    // This is the exact endpoint used by Emby Web's Home Screen switches.
    // It expects a partial configuration object and returns HTTP 204.
    await axios.post(`${process.env.EMBY_URL}/emby/Users/${emby_user_id}/Configuration/Partial`, {
      MyMediaExcludes: [...current]
    }, {
      headers: { 'X-Emby-Token': process.env.EMBY_API_KEY, 'Content-Type': 'application/json' }, timeout: 8000
    });
    delete _libCache[emby_user_id];
    const enabled = !current.has(targetId);
    res.json({ success: true, libraryId: targetId, enabled });
  } catch (e) {
    console.error('Library policy toggle error:', e.response?.status, e.response?.data || e.message);
    res.status(502).json({ error: 'Could not update Emby library access' });
  }
});
app.post('/api/libraries', requireAuth, async (req, res) => {
  const requestedExcludes = Array.isArray(req.body.myMediaExcludes) ? req.body.myMediaExcludes.map(String) : [];
  const { emby_user_id } = req.session.user;
  delete _libCache[emby_user_id]; // invalidate cache

  console.log(`Library update for ${emby_user_id}: excludes=${JSON.stringify(requestedExcludes)}`);
  try {
    const [userRes, viewsRes] = await Promise.all([
      axios.get(`${process.env.EMBY_URL}/emby/Users/${emby_user_id}`, {
        headers: { 'X-Emby-Token': process.env.EMBY_API_KEY }, timeout: 8000
      }),
      axios.get(`${process.env.EMBY_URL}/emby/Users/${emby_user_id}/Views`, {
        headers: { 'X-Emby-Token': process.env.EMBY_API_KEY }, timeout: 8000
      })
    ]);
      const config = userRes.data.Configuration || {};
      // Keep the numeric IDs for the secondary rows, then add the resolved
      // GUIDs as well because this Emby install uses GUIDs for the large My
      // Media library cards.
      const myMediaExcludes = requestedExcludes;

      const ALL_LIBRARY_NAMES = {
        '3': 'Movies', '34011': 'TV Shows', '37813': 'Movies Anime', '38357': 'TV Anime',
        '38797': "Movies INT'L", '39247': "TV INT'L", '1605282': 'Sports',
        '1594737': 'Collections', '1564892': 'Playlists'
      };
      const orderedViews = config.OrderedViews || [];
      const nameToGuid = {};
      (viewsRes.data?.Items || []).forEach(item => {
        if (item.Name && item.Id) nameToGuid[item.Name] = String(item.Id);
      });
      if (orderedViews.length) {
        try {
          const itemsRes = await axios.get(`${process.env.EMBY_URL}/emby/Items`, {
            headers: { 'X-Emby-Token': process.env.EMBY_API_KEY },
            params: { Ids: orderedViews.join(',') }, timeout: 8000
          });
          (itemsRes.data?.Items || []).forEach((item, idx) => {
            if (item.Name && item.Id) nameToGuid[item.Name] = String(item.Id);
            if (item.Name && orderedViews[idx]) nameToGuid[item.Name] = String(orderedViews[idx]);
          });
        } catch (e) {
          console.error('Library GUID lookup error:', e.message);
        }
      }
      const guidByNumericId = {};
      Object.entries(ALL_LIBRARY_NAMES).forEach(([id, name]) => {
        if (nameToGuid[name]) guidByNumericId[id] = nameToGuid[name];
      });

      const latestItemsExcludes = [];
      const knownLibraryGuids = new Set(Object.values(guidByNumericId).map(String));
      Object.values(LATEST_ITEMS_EXCLUDE_IDS).forEach(guid => knownLibraryGuids.add(String(guid)));
      const existingLatest = Array.isArray(config.LatestItemsExcludes) ? config.LatestItemsExcludes.map(String) : [];
      existingLatest.forEach(guid => { if (!knownLibraryGuids.has(guid)) latestItemsExcludes.push(guid); });
      Object.entries(ALL_LIBRARY_NAMES).forEach(([numericId]) => {
        if (!requestedExcludes.includes(numericId)) return;
        const guid = LATEST_ITEMS_EXCLUDE_IDS[numericId] || guidByNumericId[numericId];
        if (guid && !latestItemsExcludes.includes(String(guid))) latestItemsExcludes.push(String(guid));
      });

      const extraMyMediaExcludes = [];
      Object.entries(MY_MEDIA_EXTRA_EXCLUDE_IDS).forEach(([numericId, guid]) => {
        if (requestedExcludes.includes(numericId) || myMediaExcludes.includes(guid)) {
          extraMyMediaExcludes.push(guid);
        }
      });

      const hiddenLibraryGuids = requestedExcludes
        .map(numericId => LATEST_ITEMS_EXCLUDE_IDS[numericId] || MY_MEDIA_EXTRA_EXCLUDE_IDS[numericId] || guidByNumericId[numericId])
        .filter(Boolean)
        .map(String);
      const specialNumericIds = Object.keys(MY_MEDIA_EXTRA_EXCLUDE_IDS);
      const cleanMyMediaExcludes = myMediaExcludes
        .filter(id => !specialNumericIds.includes(id) && !knownLibraryGuids.has(String(id)))
        .concat(hiddenLibraryGuids, extraMyMediaExcludes)
        .filter((id, index, arr) => arr.indexOf(id) === index);

      config.MyMediaExcludes = cleanMyMediaExcludes;
      config.LatestItemsExcludes = latestItemsExcludes;

      // Run DisplayPreferences update and user config update in parallel
      await Promise.all([
        (async () => {
          try {
            const dispRes = await axios.get(`${process.env.EMBY_URL}/emby/DisplayPreferences/usersettings`, {
              headers: { 'X-Emby-Token': process.env.EMBY_API_KEY },
              params: { userId: emby_user_id, client: 'emby' },
              timeout: 8000
            });
            const dispPrefs = dispRes.data;
            const prefs = dispPrefs.CustomPrefs || {};
            let prefsChanged = false;

            Object.entries(DISPLAY_PREFS_LIBRARIES).forEach(([libId, sectionValue]) => {
              const shouldExclude = requestedExcludes.includes(libId);
              const sectionWithValue = Object.entries(prefs).find(([k, v]) => v === sectionValue);
              const isCurrentlyVisible = !!sectionWithValue;

              if (shouldExclude && isCurrentlyVisible) {
                prefs[sectionWithValue[0]] = 'none';
                prefsChanged = true;
              } else if (!shouldExclude && !isCurrentlyVisible) {
                const noneSection = Object.entries(prefs).find(([k, v]) => v === 'none');
                if (noneSection) {
                  prefs[noneSection[0]] = sectionValue;
                } else {
                  const indices = Object.keys(prefs)
                    .map(k => parseInt(k.replace('homesection', '')))
                    .filter(n => !isNaN(n));
                  const nextIdx = indices.length > 0 ? Math.max(...indices) + 1 : 0;
                  prefs[`homesection${nextIdx}`] = sectionValue;
                }
                prefsChanged = true;
              }
            });

            if (prefsChanged) {
              dispPrefs.CustomPrefs = prefs;
              await axios.post(`${process.env.EMBY_URL}/emby/DisplayPreferences/usersettings`, dispPrefs, {
                headers: { 'X-Emby-Token': process.env.EMBY_API_KEY, 'Content-Type': 'application/json' },
                params: { userId: emby_user_id, client: 'emby' },
                timeout: 8000
              });
              console.log('Updated DisplayPreferences:', JSON.stringify(prefs));
            }
          } catch(e) {
            console.error('DisplayPrefs update error:', e.message);
            throw e;
          }
        })(),
        axios.post(`${process.env.EMBY_URL}/emby/Users/${emby_user_id}/Configuration`, config, {
          headers: { 'X-Emby-Token': process.env.EMBY_API_KEY, 'Content-Type': 'application/json' },
          timeout: 8000
        })
      ]);

    console.log(`Library update complete for ${emby_user_id}`);
    res.json({ success: true });
  } catch(e) {
    console.error('Library update error:', e.response?.status, e.response?.data || e.message);
    res.status(502).json({ success: false, error: 'Could not save Emby library settings' });
  }
});

// ─── API: Media-server health and downtime ─────────────────────────────────────
const HEALTH_PROVIDERS = {
  emby: {
    label: 'Emby',
    urlKey: 'EMBY_URL',
    credentialKey: 'EMBY_API_KEY',
    healthKey: 'EMBY_HEALTH_URL',
    headers: () => ({ 'X-Emby-Token': process.env.EMBY_API_KEY }),
    table: 'emby_accounts',
    idColumn: 'emby_user_id',
  },
  silo: {
    label: 'Silo',
    urlKey: 'SILO_URL',
    credentialKey: 'SILO_API_KEY',
    healthKey: 'SILO_HEALTH_URL',
    headers: () => ({ Authorization: `Bearer ${process.env.SILO_API_KEY}` }),
    table: 'silo_accounts',
    idColumn: 'silo_user_id',
  },
  plex: {
    label: 'Plex',
    urlKey: 'PLEX_URL',
    credentialKey: 'PLEX_TOKEN',
    healthKey: 'PLEX_HEALTH_URL',
    headers: () => ({ 'X-Plex-Token': process.env.PLEX_TOKEN }),
    table: null,
    idColumn: null,
  },
  jellyfin: {
    label: 'Jellyfin',
    urlKey: 'JELLYFIN_URL',
    credentialKey: 'JELLYFIN_API_KEY',
    healthKey: 'JELLYFIN_HEALTH_URL',
    headers: () => ({ 'X-Emby-Token': process.env.JELLYFIN_API_KEY }),
    table: null,
    idColumn: null,
  },
};

const HEALTH_TIMEOUT_MS = 8000;
const HEALTH_INTERVAL_MS = 30000;
const HEALTH_FAILURES_TO_ALERT = 3;
const HEALTH_SUCCESSES_TO_RECOVER = 2;
const healthStates = Object.fromEntries(Object.keys(HEALTH_PROVIDERS).map(key => [key, {
  online: true,
  initialized: false,
  failureStreak: 0,
  successStreak: 0,
  currentDowntime: null,
  log: [],
  lastCheck: null,
  lastError: null,
}]));

function providerHealthConfiguration(key) {
  const def = HEALTH_PROVIDERS[key];
  if (!def) return { enabled: false, healthConfigured: false, endpoint: '' };
  const enabled = Boolean(String(process.env[def.urlKey] || '').trim() && String(process.env[def.credentialKey] || '').trim());
  const endpoint = String(process.env[def.healthKey] || '').trim();
  return { enabled, healthConfigured: enabled && Boolean(endpoint), endpoint };
}

function availableHealthProviders() {
  return Object.keys(HEALTH_PROVIDERS).filter(key => providerHealthConfiguration(key).healthConfigured);
}

async function checkProviderHealth(key) {
  const def = HEALTH_PROVIDERS[key];
  const config = providerHealthConfiguration(key);
  if (!config.healthConfigured) return { skipped: true };
  const response = await axios.get(config.endpoint, {
    headers: def.headers(),
    timeout: HEALTH_TIMEOUT_MS,
    validateStatus: () => true,
    maxContentLength: 1024 * 1024,
    maxBodyLength: 1024 * 1024,
  });
  // An authenticated endpoint may answer 401/403 while still proving the
  // server is reachable. A 404 is not accepted because it often means the
  // health path is wrong.
  if ((response.status >= 200 && response.status < 400) || response.status === 401 || response.status === 403) {
    return { online: true, status: response.status };
  }
  throw new Error(`${config.endpoint} -> HTTP ${response.status}`);
}

async function sendHealthPush(key, title, body) {
  if (!webpush) return;
  const def = HEALTH_PROVIDERS[key];
  if (!def.table) return;
  try {
    const { data: accounts } = await db.from(def.table).select(`${def.idColumn}, discord_user_id`);
    const ids = new Set((accounts || []).flatMap(account => [account[def.idColumn], account.discord_user_id]).filter(Boolean).map(String));
    if (!ids.size) return;
    const { data: subs } = await db.from('push_subscriptions').select('endpoint, subscription, user_id');
    await Promise.all((subs || []).filter(sub => ids.has(String(sub.user_id))).map(async sub => {
      try {
        await webpush.sendNotification(JSON.parse(sub.subscription), JSON.stringify({ title, body, url: '/', icon: '/logo.png' }));
      } catch (error) {
        if (error.statusCode === 410 || error.statusCode === 404) {
          await db.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
        }
      }
    }));
  } catch (error) {
    console.warn('[health push]', key, error.message);
  }
}

async function monitorProviderHealth(key) {
  const state = healthStates[key];
  const def = HEALTH_PROVIDERS[key];
  const config = providerHealthConfiguration(key);
  if (!config.healthConfigured) {
    state.online = true;
    state.initialized = false;
    state.failureStreak = 0;
    state.successStreak = 0;
    state.currentDowntime = null;
    state.lastError = null;
    return;
  }
  state.lastCheck = new Date().toISOString();
  try {
    await checkProviderHealth(key);
    state.lastError = null;
    state.failureStreak = 0;
    state.successStreak += 1;
    if (!state.initialized) {
      state.initialized = true;
      state.online = true;
      state.successStreak = 0;
      console.log(`[health] ${def.label} reachable via configured endpoint`);
      return;
    }
    if (!state.online && state.successStreak >= HEALTH_SUCCESSES_TO_RECOVER) {
      const now = new Date();
      const startedAt = state.currentDowntime?.startedAt || now.toISOString();
      const duration = Math.max(0, Math.floor((now - new Date(startedAt)) / 1000));
      state.log.unshift({ id: `${key}-${Date.now()}`, provider: key, providerLabel: def.label, startedAt, resolvedAt: now.toISOString(), duration, resolved: true });
      state.log = state.log.slice(0, 50);
      state.currentDowntime = null;
      state.online = true;
      state.successStreak = 0;
      await sendHealthPush(key, `✅ ${def.label} is back online`, `Back up after ${formatHealthDuration(duration)} downtime`);
    }
  } catch (error) {
    state.lastError = error.message;
    state.successStreak = 0;
    state.failureStreak += 1;
    console.warn(`[health] ${def.label} check failed ${state.failureStreak}/${HEALTH_FAILURES_TO_ALERT}: ${error.message}`);
    if (!state.initialized && state.failureStreak < HEALTH_FAILURES_TO_ALERT) return;
    state.initialized = true;
    if (state.online && state.failureStreak >= HEALTH_FAILURES_TO_ALERT) {
      const now = new Date();
      state.currentDowntime = { startedAt: now.toISOString() };
      state.online = false;
      await sendHealthPush(key, `⚠️ ${def.label} is offline`, `${def.label} has been unreachable for three consecutive health checks.`);
    }
  }
}

function formatHealthDuration(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function healthServicesForRequest(req) {
  const session = req.session?.user || {};
  if (session.admin_login === true) return availableHealthProviders();
  return availableHealthProviders().filter(key => {
    if (key === 'emby') return Boolean(session.has_emby || session.emby_user_id);
    if (key === 'silo') return Boolean(session.has_silo || session.silo_user_id);
    if (key === 'plex') return Boolean(session.has_plex || session.plex_user_id);
    if (key === 'jellyfin') return Boolean(session.has_jellyfin || session.jellyfin_user_id);
    return false;
  });
}

function healthEventView(key, event) {
  return { ...event, provider: key, providerLabel: HEALTH_PROVIDERS[key].label };
}

function healthSnapshotForRequest(req, days = 7) {
  const keys = healthServicesForRequest(req);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const services = keys.map(key => {
    const state = healthStates[key];
    const events = state.log.filter(event => new Date(event.startedAt).getTime() >= cutoff || !event.resolved).map(event => healthEventView(key, event));
    return {
      key,
      label: HEALTH_PROVIDERS[key].label,
      online: state.online,
      endpointConfigured: true,
      currentDowntime: state.currentDowntime,
      log: events,
      health: { initialized: state.initialized, failureStreak: state.failureStreak, successStreak: state.successStreak, lastCheck: state.lastCheck, lastError: state.lastError },
    };
  });
  const log = services.flatMap(service => service.log).sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  const current = services.filter(service => !service.online && service.currentDowntime);
  return {
    online: services.every(service => service.online),
    services,
    currentDowntime: current[0]?.currentDowntime || null,
    log: log.slice(0, 50),
    health: services.map(service => ({ provider: service.key, ...service.health })),
  };
}

app.get('/api/server-status', requireAuth, (req, res) => {
  res.json(healthSnapshotForRequest(req));
});

app.get('/api/downtime-history', requireAuth, (req, res) => {
  const days = Math.min(30, Math.max(1, parseInt(req.query.days) || 7));
  const snapshot = healthSnapshotForRequest(req, days);
  const windowMs = days * 24 * 60 * 60 * 1000;
  const totalDowntimeMs = snapshot.log.reduce((sum, event) => sum + (event.duration ? event.duration * 1000 : 0), 0);
  const uptimePct = parseFloat(Math.max(0, Math.min(100, ((windowMs - totalDowntimeMs) / windowMs) * 100)).toFixed(4));
  res.json({
    days,
    services: snapshot.services,
    log: snapshot.log,
    uptimePct,
    downtimePct: parseFloat((100 - uptimePct).toFixed(4)),
    totalDowntimeSeconds: Math.floor(totalDowntimeMs / 1000),
    eventCount: snapshot.log.length,
  });
});

function startHealthMonitoring() {
  availableHealthProviders().forEach(key => monitorProviderHealth(key));
  setInterval(() => availableHealthProviders().forEach(key => monitorProviderHealth(key)), HEALTH_INTERVAL_MS);
}
settingsReady.then(startHealthMonitoring).catch(error => console.warn('[health] monitor startup', error.message));

// ─── API: Push notifications ──────────────────────────────────────────────────

app.get('/api/push/vapid-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || null });
});

app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  const { subscription, test } = req.body;
  if (!subscription?.endpoint) return res.json({ error: 'Invalid subscription' });
  const { emby_user_id, discord_id } = req.session.user;
  const userId = emby_user_id || discord_id;
  try {
    await db.from('push_subscriptions').upsert({
      user_id: userId,
      endpoint: subscription.endpoint,
      subscription: JSON.stringify(subscription),
      created_at: new Date().toISOString(),
    }, { onConflict: 'endpoint' });
    if (test && webpush) {
      const payload = JSON.stringify({
        title: '🔔 Portal v1 notifications enabled',
        body: 'You’ll be pinged when Emby goes offline or comes back online.',
        url: '/',
        icon: '/logo.png',
        tag: 'portal-push-test'
      });
      webpush.sendNotification(subscription, payload).catch(e => {
        console.warn('[push test]', e.statusCode || '', e.message);
      });
    }
    res.json({ success: true });
  } catch(e) { res.json({ error: e.message }); }
});

app.post('/api/push/unsubscribe', requireAuth, async (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.json({ error: 'Missing endpoint' });
  await db.from('push_subscriptions').delete().eq('endpoint', endpoint);
  res.json({ success: true });
});

async function sendPushToAll(title, body, url = '/') {
  if (!webpush) return;
  try {
    const { data: subs } = await db.from('push_subscriptions').select('endpoint, subscription');
    if (!subs?.length) return;
    const payload = JSON.stringify({ title, body, url, icon: '/logo.png' });
    let sent = 0, failed = 0;
    await Promise.all(subs.map(async sub => {
      try {
        await webpush.sendNotification(JSON.parse(sub.subscription), payload);
        sent++;
      } catch(e) {
        if (e.statusCode === 410 || e.statusCode === 404) {
          // Subscription expired — clean it up
          await db.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
        }
        failed++;
      }
    }));
    console.log(`[push] Sent ${sent}, failed ${failed}`);
  } catch(e) { console.error('[push]', e.message); }
}

// ─── API: Sub user stream status ─────────────────────────────────────────────
app.get('/api/sub-stream-status', requireAuth, async (req, res) => {
  const { emby_user_id } = req.session.user;
  if (!emby_user_id) return res.json({ streams: {}, mainActive: 0, mainTotal: 0 });
  try {
    const [{ data: subs }, { data: mainAccount }] = await Promise.all([
      db.from('emby_accounts').select('emby_user_id, connections').eq('parent_emby_user_id', emby_user_id),
      db.from('emby_accounts').select('connections').eq('emby_user_id', emby_user_id).maybeSingle(),
    ]);

    const { data: sessions } = await axios.get(`${process.env.EMBY_URL}/emby/Sessions`, {
      headers: { 'X-Emby-Token': process.env.EMBY_API_KEY },
      timeout: 5000
    });

    const activeSessions = (sessions || []).filter(s => s.NowPlayingItem);

    // Main account streams
    const mainActive = activeSessions.filter(s => s.UserId === emby_user_id).length;
    const mainTotal = mainAccount?.connections || 0;

    // Sub user streams
    const streamMap = {};
    for (const sub of (subs || [])) {
      const active = activeSessions.filter(s => s.UserId === sub.emby_user_id).length;
      streamMap[sub.emby_user_id] = { active, total: sub.connections || 1 };
    }
    res.json({ streams: streamMap, mainActive, mainTotal });
  } catch(e) {
    res.json({ streams: {}, mainActive: 0, mainTotal: 0 });
  }
});

// ─── API: Admin — active sessions ────────────────────────────────────────────
app.get('/api/admin/sessions', requireAdmin, async (req, res) => {
  try {
    const { data } = await axios.get(`${process.env.EMBY_URL}/emby/Sessions`, {
      headers: { 'X-Emby-Token': process.env.EMBY_API_KEY }, timeout: 8000
    });
    const sessions = (data || []).filter(s => s.NowPlayingItem).map(s => ({
      username: s.UserName, userId: s.UserId,
      client: s.Client, device: s.DeviceName,
      item: s.NowPlayingItem?.Name,
      seriesName: s.NowPlayingItem?.SeriesName || null,
      playState: s.PlayState?.IsPaused ? 'Paused' : 'Playing',
      playMethod: s.PlayState?.PlayMethod,
      progress: s.PlayState?.PositionTicks && s.NowPlayingItem?.RunTimeTicks
        ? Math.round((s.PlayState.PositionTicks / s.NowPlayingItem.RunTimeTicks) * 100) : 0,
    }));
    res.json({ sessions, total: sessions.length });
  } catch (e) { res.json({ sessions: [], total: 0 }); }
});

// ─── API: Admin — bulk actions ────────────────────────────────────────────────
app.post('/api/admin/bulk', requireAdmin, async (req, res) => {
  const { action, userIds } = req.body;
  if (!action || !Array.isArray(userIds) || !userIds.length) return res.json({ error: 'Missing action or userIds' });
  try {
    let updated = 0;
    for (const emby_user_id of userIds) {
      if (action === 'enable') {
        await db.from('emby_accounts').update({ is_disabled: false }).eq('emby_user_id', emby_user_id);
        await axios.post(`${process.env.EMBY_URL}/emby/Users/${emby_user_id}/Policy`,
          { IsDisabled: false }, { headers: { 'X-Emby-Token': process.env.EMBY_API_KEY, 'Content-Type': 'application/json' }, timeout: 8000 }
        ).catch(() => {});
        updated++;
      } else if (action === 'disable') {
        await db.from('emby_accounts').update({ is_disabled: true }).eq('emby_user_id', emby_user_id);
        await axios.post(`${process.env.EMBY_URL}/emby/Users/${emby_user_id}/Policy`,
          { IsDisabled: true }, { headers: { 'X-Emby-Token': process.env.EMBY_API_KEY, 'Content-Type': 'application/json' }, timeout: 8000 }
        ).catch(() => {});
        updated++;
      } else if (action === 'delete') {
        await db.from('emby_accounts').delete().eq('emby_user_id', emby_user_id);
        await axios.delete(`${process.env.EMBY_URL}/emby/Users/${emby_user_id}`,
          { headers: { 'X-Emby-Token': process.env.EMBY_API_KEY }, timeout: 8000 }
        ).catch(() => {});
        updated++;
      }
    }
    res.json({ success: true, updated });
  } catch (e) { res.json({ error: e.message }); }
});

// ─── API: Admin — search users ────────────────────────────────────────────────
app.get('/api/admin/search', requireAuth, async (req, res) => {
  if (!req.session.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.json({ users: [] });
  const { data, error } = await db.from('emby_accounts')
    .select('emby_user_id, username, is_disabled, is_lifetime, is_trial, expires_at, connections, discord_user_id')
    .ilike('username', `%${q.trim()}%`)
    .limit(20);
  if (error) return res.json({ users: [] });
  res.json({ users: data || [] });
});

app.get('/api/playback-hours', requireAuth, async (req, res) => {
  try {
    const [r1, r2, r3] = await Promise.all([
      // Hourly plays
      axios.post(
        `${process.env.EMBY_DIRECT_URL || process.env.EMBY_URL || ""}/emby/user_usage_stats/submit_custom_query`,
        { CustomQueryString: "SELECT strftime('%H', DateCreated) as HourOfDay, COUNT(*) as PlayCount FROM PlaybackActivity GROUP BY HourOfDay ORDER BY HourOfDay ASC", ReplaceUserId: false },
        { headers: { 'X-Emby-Token': process.env.EMBY_API_KEY, 'Content-Type': 'application/json' }, timeout: 10000 }
      ),
      // Most recent 10 plays with timestamps
      axios.post(
        `${process.env.EMBY_DIRECT_URL || process.env.EMBY_URL || ""}/emby/user_usage_stats/submit_custom_query`,
        { CustomQueryString: "SELECT UserId, ItemName, DateCreated FROM PlaybackActivity ORDER BY DateCreated DESC LIMIT 10", ReplaceUserId: true },
        { headers: { 'X-Emby-Token': process.env.EMBY_API_KEY, 'Content-Type': 'application/json' }, timeout: 10000 }
      ),
      // Current server UTC time for reference
      axios.get(`${process.env.EMBY_DIRECT_URL || process.env.EMBY_URL || ""}/emby/System/Info`, {
        headers: { 'X-Emby-Token': process.env.EMBY_API_KEY }, timeout: 5000
      })
    ]);
    res.json({
      hourly: r1.data,
      recentPlays: r2.data,
      serverTime: r3.data?.ServerName ? new Date().toISOString() : null,
      queryTime: new Date().toISOString()
    });
  } catch(e) {
    res.json({ error: e.response?.status + ' ' + e.message });
  }
});

// ─── API: Emby user stats ─────────────────────────────────────────────────────
app.get('/api/emby-stats', requireAuth, async (req, res) => {
  const { emby_user_id } = req.session.user;
  if (!emby_user_id) return res.json({ error: 'No Emby account' });
  const cacheKey = String(emby_user_id);
  const cached = EMBY_STATS_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < 20000 && (cached.data.recentlyWatched.length || cached.data.newReleases.length)) return res.json(cached.data);
  try {
    const headers = { 'X-Emby-Token': process.env.EMBY_API_KEY };
    const base = embyApiBase().replace(/\/emby\/?$/i, '');
    const itemsFrom = result => Array.isArray(result?.data) ? result.data : (result?.data?.Items || []);
    // The profile only needs the last-played timestamp. Do not fetch resume or
    // latest media lists unless a dedicated page explicitly asks for them.
    if (req.query.summary === '1') {
      const activityRes = await axios.get(`${base}/emby/Users/${emby_user_id}/Items?SortBy=DatePlayed&SortOrder=Descending&Filters=IsPlayed&Recursive=true&Fields=UserData&Limit=1`, { headers, timeout: 5000 }).catch(() => null);
      return res.json({ lastSeen: activityRes?.data?.Items?.[0]?.UserData?.LastPlayedDate || null });
    }
    const mapResumeItems = result => itemsFrom(result).map(i => {
      const isEpisode = i.Type === 'Episode';
      const seriesId = i.SeriesId || null;
      const artworkId = isEpisode && seriesId ? seriesId : i.Id;
      const artworkTag = isEpisode ? (i.SeriesPrimaryImageTag || i.ParentPrimaryImageTag) : i.ImageTags?.Primary;
      return {
        id: i.Id, openId: isEpisode && seriesId ? seriesId : i.Id, name: i.Name, type: i.Type,
        seriesName: i.SeriesName || null, overview: i.Overview || '',
        year: i.ProductionYear || (i.PremiereDate ? String(i.PremiereDate).slice(0, 4) : null),
        genres: i.Genres || [], rating: i.CommunityRating || null,
        thumb: artworkTag ? `${base}/emby/Items/${artworkId}/Images/Primary?maxHeight=300&tag=${encodeURIComponent(artworkTag)}&api_key=${process.env.EMBY_API_KEY}` : null,
        progress: i.UserData?.PlayedPercentage || 0,
        runtime: i.RunTimeTicks ? Math.round(i.RunTimeTicks / 600000000) : null,
      };
    });
    if (req.query.fast === '1') {
      const [activityRes, recentRes, resumeFallbackRes, systemRes] = await Promise.all([
        axios.get(`${base}/emby/Users/${emby_user_id}/Items?SortBy=DatePlayed&SortOrder=Descending&Filters=IsPlayed&Recursive=true&Fields=UserData&Limit=1`, { headers, timeout: 5000 }).catch(() => null),
        axios.get(`${base}/emby/Users/${emby_user_id}/Items/Resume?Limit=6&Fields=Overview,ProductionYear,PremiereDate,RunTimeTicks,UserData,SeriesId,SeriesName,SeriesPrimaryImageTag,ParentPrimaryImageTag,ImageTags`, { headers, timeout: 5000 }).catch(() => null),
        axios.get(`${base}/emby/Users/${emby_user_id}/Items?Recursive=true&IncludeItemTypes=Movie,Episode&Filters=IsResumable&SortBy=DatePlayed&SortOrder=Descending&Limit=6&Fields=Overview,ProductionYear,PremiereDate,RunTimeTicks,UserData,SeriesId,SeriesName,SeriesPrimaryImageTag,ParentPrimaryImageTag,ImageTags`, { headers, timeout: 5000 }).catch(() => null),
        axios.get(`${base}/emby/System/Info`, { headers, timeout: 5000 }).catch(() => null),
      ]);
      const fastItems = itemsFrom(recentRes);
      const fastData = { lastSeen: activityRes?.data?.Items?.[0]?.UserData?.LastPlayedDate || null, recentlyWatched: mapResumeItems(fastItems.length ? recentRes : resumeFallbackRes), nextUp: [], newReleases: [], embyServerId: systemRes?.data?.Id || null };
      res.json(fastData);
      return;
    }
    const [activityRes, recentRes, systemRes, releasesRes, releasesBroadRes, releasesFallbackRes] = await Promise.all([
      axios.get(`${base}/emby/Users/${emby_user_id}/Items?SortBy=DatePlayed&SortOrder=Descending&Filters=IsPlayed&Recursive=true&Fields=DateCreated,RunTimeTicks&Limit=1`, { headers, timeout: 8000 }).catch(() => null),
      axios.get(`${base}/emby/Users/${emby_user_id}/Items/Resume?Limit=6&Fields=PrimaryImageAspectRatio,Overview,RunTimeTicks,UserData,SeriesId,SeriesName,SeriesPrimaryImageTag,ParentId,ParentPrimaryImageTag,ImageTags`, { headers, timeout: 8000 }).catch(() => null),
      axios.get(`${base}/emby/System/Info`, { headers, timeout: 8000 }).catch(() => null),
      axios.get(`${base}/emby/Users/${emby_user_id}/Items/Latest?Limit=8&IncludeItemTypes=Movie,Series,Episode&Fields=Overview,PremiereDate,ProductionYear,Genres,PrimaryImageAspectRatio,ImageTags,SeriesId,SeriesName,SeriesPrimaryImageTag,ParentPrimaryImageTag`, { headers, timeout: 8000 }).catch(() => null),
      axios.get(`${base}/emby/Users/${emby_user_id}/Items/Latest?Limit=12&Fields=Overview,PremiereDate,ProductionYear,Genres,PrimaryImageAspectRatio,ImageTags,SeriesId,SeriesName,SeriesPrimaryImageTag,ParentPrimaryImageTag`, { headers, timeout: 8000 }).catch(() => null),
      axios.get(`${base}/emby/Users/${emby_user_id}/Items?SortBy=DateCreated&SortOrder=Descending&IncludeItemTypes=Movie,Series,Episode&Recursive=true&Limit=8&Fields=Overview,PremiereDate,ProductionYear,Genres,PrimaryImageAspectRatio,ImageTags,SeriesId,SeriesName,SeriesPrimaryImageTag,ParentPrimaryImageTag`, { headers, timeout: 8000 }).catch(() => null),
    ]);
    // Recently played (last 6 with posters)
    const resumeItems = itemsFrom(recentRes);
    const recentlyWatched = resumeItems.map(i => {
      const isEpisode = i.Type === 'Episode';
      const seriesId = i.SeriesId || null;
      const seriesName = i.SeriesName || null;
      const artworkId = isEpisode && seriesId ? seriesId : i.Id;
      const artworkTag = isEpisode
        ? (i.SeriesPrimaryImageTag || i.ParentPrimaryImageTag)
        : i.ImageTags?.Primary;
      return {
      id: i.Id, openId: isEpisode && seriesId ? seriesId : i.Id, name: i.Name, type: i.Type,
      seriesName,
      overview: i.Overview || '',
      year: i.ProductionYear || (i.PremiereDate ? String(i.PremiereDate).slice(0, 4) : null),
      genres: i.Genres || [],
      rating: i.CommunityRating || null,
      thumb: artworkTag ? `${base}/emby/Items/${artworkId}/Images/Primary?maxHeight=300&tag=${encodeURIComponent(artworkTag)}&api_key=${process.env.EMBY_API_KEY}` : null,
      progress: i.UserData?.PlayedPercentage || 0,
      runtime: i.RunTimeTicks ? Math.round(i.RunTimeTicks / 600000000) : null,
      };
    });
    // Last seen
    const lastItem = activityRes?.data?.Items?.[0];
    const lastSeen = lastItem?.UserData?.LastPlayedDate || null;
    const releaseItems = (itemsFrom(releasesRes).length
      ? itemsFrom(releasesRes)
      : (itemsFrom(releasesBroadRes).length ? itemsFrom(releasesBroadRes) : itemsFrom(releasesFallbackRes)))
      .filter(i => ['Movie', 'Series', 'Episode'].includes(i.Type));
    const newReleases = (releaseItems.length ? releaseItems : itemsFrom(releasesFallbackRes)).map(i => {
      const isEpisode = i.Type === 'Episode';
      const seriesId = i.SeriesId || null;
      const artworkId = isEpisode && seriesId ? seriesId : i.Id;
      const artworkTag = isEpisode
        ? (i.SeriesPrimaryImageTag || i.ParentPrimaryImageTag)
        : i.ImageTags?.Primary;
      return {
        id: i.Id,
        openId: isEpisode && seriesId ? seriesId : i.Id,
        name: isEpisode ? (i.SeriesName || i.Name) : i.Name,
        episodeName: isEpisode ? i.Name : null,
        type: i.Type,
        seriesName: i.SeriesName || null,
        overview: i.Overview || '',
        year: i.ProductionYear || (i.PremiereDate ? String(i.PremiereDate).slice(0, 4) : null),
        genres: i.Genres || [],
        rating: i.CommunityRating || null,
        thumb: artworkTag ? `${base}/emby/Items/${artworkId}/Images/Primary?maxHeight=500&tag=${encodeURIComponent(artworkTag)}&api_key=${process.env.EMBY_API_KEY}` : null,
      };
    });
    const responseData = { lastSeen, recentlyWatched, newReleases, embyServerId: systemRes?.data?.Id || null };
    EMBY_STATS_CACHE.set(cacheKey, { createdAt: Date.now(), data: responseData });
    res.json(responseData);
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ─── API: Recently added items for one enabled Emby library ──────────────────
app.get('/api/emby-recent', requireAuth, async (req, res) => {
  const { emby_user_id } = req.session.user;
  const libraryId = String(req.query.libraryId || '').trim();
  if (!emby_user_id || !libraryId || !/^[a-zA-Z0-9_-]+$/.test(libraryId)) {
    return res.json({ items: [] });
  }
  try {
    const base = process.env.EMBY_URL;
    const { data } = await axios.get(`${base}/emby/Users/${emby_user_id}/Items`, {
      headers: { 'X-Emby-Token': process.env.EMBY_API_KEY },
      params: {
        ParentId: libraryId,
        Recursive: true,
        IncludeItemTypes: 'Movie,Series,Episode',
        SortBy: 'DateCreated',
        SortOrder: 'Descending',
        Limit: 12,
        Fields: 'Overview,PremiereDate,ProductionYear,Genres,RunTimeTicks,ImageTags,SeriesId,SeriesName,SeriesPrimaryImageTag,ParentPrimaryImageTag'
      },
      timeout: 8000
    });
    const items = (data?.Items || []).filter(i => ['Movie', 'Series', 'Episode'].includes(i.Type)).map(i => {
      const isEpisode = i.Type === 'Episode';
      const seriesId = i.SeriesId || null;
      const artworkId = isEpisode && seriesId ? seriesId : i.Id;
      const artworkTag = isEpisode ? (i.SeriesPrimaryImageTag || i.ParentPrimaryImageTag) : i.ImageTags?.Primary;
      return {
        id: i.Id,
        openId: isEpisode && seriesId ? seriesId : i.Id,
        name: isEpisode ? (i.SeriesName || i.Name) : i.Name,
        episodeName: isEpisode ? i.Name : null,
        type: i.Type,
        seriesName: i.SeriesName || null,
        overview: i.Overview || '',
        year: i.ProductionYear || (i.PremiereDate ? String(i.PremiereDate).slice(0, 4) : null),
        genres: i.Genres || [],
        thumb: artworkTag ? `${base}/emby/Items/${artworkId}/Images/Primary?maxHeight=500&tag=${encodeURIComponent(artworkTag)}&api_key=${process.env.EMBY_API_KEY}` : null,
        runtime: i.RunTimeTicks ? Math.round(i.RunTimeTicks / 600000000) : null
      };
    });
    res.json({ items });
  } catch (e) {
    console.error('[emby recent library]', libraryId, e.response?.status, e.message);
    res.json({ items: [] });
  }
});

// ─── API: TMDB poster proxy (fetch poster by tmdb ID) ────────────────────────
const _tmdbPosterCache = {};
app.get('/api/tmdb-poster/:type/:id', requireAuth, async (req, res) => {
  const { type, id } = req.params;
  if (!['movie','tv'].includes(type) || !/^\d+$/.test(id)) return res.status(400).json({ error: 'Invalid' });
  const cacheKey = `${type}/${id}`;
  if (_tmdbPosterCache[cacheKey]) return res.json(_tmdbPosterCache[cacheKey]);
  try {
    const TMDB_KEY = process.env.TMDB_API_KEY;
    if (!TMDB_KEY) return res.json({ poster: null });
    const { data } = await axios.get(`https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_KEY}`, { timeout: 6000 });
    const poster = data.poster_path ? `https://image.tmdb.org/t/p/w200${data.poster_path}` : null;
    _tmdbPosterCache[cacheKey] = { poster };
    res.json({ poster });
  } catch { res.json({ poster: null }); }
});

// ─── API: Trending debug ──────────────────────────────────────────────────────
app.get('/api/trending-debug', requireAuth, async (req, res) => {
  try {
    const r = await axios.get('https://mdblist.com/lists/snoak/trending-movies/json/', {
      timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const first = r.data?.[0] || {};
    res.json({
      total: r.data?.length,
      firstItem: first,
      tmdbKey: !!process.env.TMDB_API_KEY,
      keys: Object.keys(first),
    });
  } catch(e) { res.json({ error: e.message }); }
});

// ─── API: Trending from MDBList ───────────────────────────────────────────────
let _trendingCache = null, _trendingCacheTs = 0;
app.get('/api/trending', requireAuth, async (req, res) => {
  if (_trendingCache && Date.now() - _trendingCacheTs < 30 * 60 * 1000) return res.json(_trendingCache);
  try {
    const TMDB_KEY = process.env.TMDB_API_KEY;
    const [moviesRes, showsRes] = await Promise.all([
      axios.get('https://mdblist.com/lists/snoak/trending-movies/json/', {
        timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' }
      }).catch(() => null),
      axios.get('https://mdblist.com/lists/snoak/trakt-s-trending-shows/json/', {
        timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' }
      }).catch(() => null),
    ]);

    const fetchPosters = async (items, mediaType) => {
      return Promise.all(items.slice(0, 10).map(async (item, idx) => {
        // MDBList fields: imdb_id, release_year, title — no tmdbid
        const imdbId = item.imdb_id || item.imdbid;
        let poster = null;
        if (imdbId && TMDB_KEY) {
          try {
            // Use TMDB find endpoint to look up by IMDb ID
            const r = await axios.get(
              `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id`,
              { timeout: 5000 }
            );
            const results = r.data?.movie_results?.[0] || r.data?.tv_results?.[0];
            poster = results?.poster_path
              ? `https://image.tmdb.org/t/p/w200${results.poster_path}`
              : null;
          } catch {}
        }
        return {
          rank: idx + 1,
          title: item.title,
          year: item.release_year || item.year,
          imdb: imdbId,
          rating: item.imdbrating ? parseFloat(item.imdbrating).toFixed(1) : null,
          poster,
        };
      }));
    };

    const movies = moviesRes?.data?.length ? await fetchPosters(moviesRes.data, 'movie') : [];
    const shows  = showsRes?.data?.length  ? await fetchPosters(showsRes.data,  'tv')    : [];

    _trendingCache = { movies, shows };
    _trendingCacheTs = Date.now();
    res.json(_trendingCache);
  } catch (e) {
    console.error('[trending]', e.message);
    res.json({ error: e.message, movies: [], shows: [] });
  }
});

// ─── API: Active Emby sessions (admin only) ───────────────────────────────────
app.get('/api/active-sessions', requireAuth, async (req, res) => {
  if (!req.session.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  try {
    const { data } = await axios.get(`${process.env.EMBY_URL}/emby/Sessions`, {
      headers: { 'X-Emby-Token': process.env.EMBY_API_KEY }, timeout: 8000
    });
    const sessions = (data || []).filter(s => s.NowPlayingItem).map(s => ({
      userName: s.UserName, userId: s.UserId,
      client: s.Client, deviceName: s.DeviceName,
      nowPlaying: s.NowPlayingItem?.Name,
      seriesName: s.NowPlayingItem?.SeriesName || null,
      type: s.NowPlayingItem?.Type,
      playMethod: s.PlayState?.PlayMethod,
      progress: s.PlayState?.PositionTicks && s.NowPlayingItem?.RunTimeTicks
        ? Math.round((s.PlayState.PositionTicks / s.NowPlayingItem.RunTimeTicks) * 100) : 0,
    }));
    res.json({ sessions, count: sessions.length });
  } catch (e) { res.json({ sessions: [], count: 0 }); }
});

// ─── API: Expiry reminders (cron-style, call manually or via scheduled job) ────
app.post('/api/send-expiry-reminders', requireAuth, async (req, res) => {
  if (!req.session.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  const { days = 7 } = req.body;
  const cutoffDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const cutoffStr = cutoffDate.toISOString();
  const nowStr = new Date().toISOString();
  try {
    const { data: expiring } = await db.from('emby_accounts')
      .select('username, recovery_email, expires_at, is_lifetime')
      .eq('is_lifetime', false).eq('is_disabled', false).not('recovery_email', 'is', null)
      .lte('expires_at', cutoffStr).gte('expires_at', nowStr);
    let sent = 0;
    for (const acc of expiring || []) {
      if (!acc.recovery_email) continue;
      const daysLeft = Math.ceil((new Date(acc.expires_at) - new Date()) / (1000 * 60 * 60 * 24));
      await sendReminderEmail(acc.recovery_email, acc.username, daysLeft);
      sent++;
    }
    res.json({ success: true, sent, checked: expiring?.length || 0 });
  } catch (e) { res.json({ error: e.message }); }
});

async function sendReminderEmail(toEmail, username, daysLeft) {
  const config = getAdminMailConfig();
  if (!config.apiKey || !config.fromEmail) return;
  const PORTAL_URL = process.env.PORTAL_URL || '';
  await sendAdminMail({
    label: 'Portal v1',
    to: toEmail,
    subject: `Your Portal v1 subscription expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`,
    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#0d0d0d;color:#e2e8f0;padding:2rem;border-radius:12px">
      <img src="${PORTAL_URL}/logo.png" alt="Portal v1" style="height:48px;margin-bottom:1.5rem">
      <h2 style="margin:0 0 0.75rem;color:#fff">Subscription expiring soon</h2>
      <p style="color:#94a3b8;margin:0 0 1rem">Hi <strong style="color:#e2e8f0">${username}</strong>, your Portal v1 subscription expires in <strong style="color:#f97316">${daysLeft} day${daysLeft !== 1 ? 's' : ''}</strong>.</p>
      <p style="color:#94a3b8;margin:0 0 1.5rem">Visit the portal to renew or contact support on Discord.</p>
      <a href="${PORTAL_URL}" style="display:inline-block;background:#6366f1;color:#fff;padding:0.75rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:600">Go to Portal</a>
      <hr style="border:none;border-top:1px solid #1e293b;margin:1.5rem 0">
      <p style="color:#475569;font-size:0.75rem;margin:0">Portal v1 · Streaming Portal</p>
    </div>`
  }).catch(e => console.error('[reminder]', e.message));
}

// Auto-run expiry reminders daily at startup + every 24h
(async () => {
  await new Promise(r => setTimeout(r, 30000)); // wait 30s after boot
  const runReminders = async () => {
    const cutoff = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();
    let data = [];
    try {
      const result = await db.from('emby_accounts')
        .select('username, recovery_email, expires_at')
        .eq('is_lifetime', false).eq('is_disabled', false).not('recovery_email', 'is', null)
        .lte('expires_at', cutoff).gte('expires_at', now);
      data = result.data || [];
    } catch (err) {
      console.error('[reminders] Query failed:', err.message);
    }
    for (const acc of data) {
      const daysLeft = Math.ceil((new Date(acc.expires_at) - new Date()) / (1000 * 60 * 60 * 24));
      await sendReminderEmail(acc.recovery_email, acc.username, daysLeft);
    }
    if (data.length) console.log(`[reminders] Sent ${data.length} expiry reminders`);
  };
  runReminders();
  setInterval(runReminders, 24 * 60 * 60 * 1000);
})();

// ─── LibreSpeed — bundled JS served statically, test data generated locally ────
// speedtest.js and speedtest_worker.js are bundled in public/ folder
// Test data is generated on the portal server — measures user → portal speed

app.get('/speedtest/garbage.php', requireAuth, (req, res) => {
  const chunks = Math.min(parseInt(req.query.ckSize || 4), 100);
  const size = chunks * 1024 * 1024;
  const chunk = require('crypto').randomBytes(65536);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store, no-cache');
  let sent = 0;
  function send() {
    if (sent >= size || res.destroyed) { res.end(); return; }
    const toSend = Math.min(chunk.length, size - sent);
    sent += toSend;
    if (!res.write(chunk.slice(0, toSend))) res.once('drain', send);
    else setImmediate(send);
  }
  send();
});

app.post('/speedtest/empty.php', requireAuth, (req, res) => {
  req.resume();
  req.on('end', () => { res.setHeader('Content-Type', 'text/plain'); res.end(''); });
});

app.get('/speedtest/empty.php', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.end('');
});

app.get('/speedtest/getIP.php', requireAuth, (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.connection.remoteAddress || 'unknown';
  res.json({ ip, processedString: ip });
});


// ─── LIBRARY (BookWarehouse proxy) ───────────────────────────────────────────
function normaliseBookWarehouseBase(value) {
  const raw = String(value || '${process.env.BOOKWAREHOUSE_URL || ""}').trim().replace(/\/+$/, '');
  return /\/api\/v1$/i.test(raw) ? raw : `${raw}/api/v1`;
}
let BW_BASE = normaliseBookWarehouseBase(process.env.BOOKWAREHOUSE_URL);
const BW_HEADERS = () => ({
  'X-API-Key': process.env.BOOKWAREHOUSE_API_KEY,
  'Content-Type': 'application/json'
});

// Normalise a raw BW book object into { title, author, year, format, cover, _cacheKey, _raw }
function extractAuthors(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) {
    return val.map(a => (a && typeof a === 'object') ? (a.name || a.author || a.sort || '') : String(a)).filter(Boolean).join(', ');
  }
  return '';
}
function normBook(b) {
  const author = extractAuthors(b.authors) || b.author || '';
  // Cover: proxy through our own route to keep API key server-side
  const cover = b.has_cover && b.id
    ? `/api/library/cover/book/${b.id}`
    : (b.cover_url || null);
  const genres = Array.isArray(b.genres) ? b.genres.map(g => g.name || g).filter(Boolean) : [];
  const lang = (b.language || '').toLowerCase().trim();
  return {
    title: b.title,
    author,
    year: b.published_date || b.pubdate || b.year || null,
    format: b.file_format || b.format || null,
    language: lang || null,
    cover,
    publisher: b.publisher || null,
    description: b.description || null,
    isbn: b.isbn13 || b.isbn10 || null,
    series: b.series_name ? `${b.series_name}${b.series_index ? ' #' + b.series_index : ''}` : null,
    genres,
    rating: b.rating ? Math.round(b.rating / 2) + '/5' : null,
    id: b.id ? String(b.id) : null,
    _cacheKey: String(b.id || b.title),
    _raw: b,
  };
}
function normAudiobook(b) {
  // External results (AudiobookBay) have title like "Book Title - Author Name"
  // and no separate author field
  let title = b.title || '';
  let author = b.author || extractAuthors(b.authors) || '';
  if (!author && title.includes(' - ')) {
    const parts = title.split(' - ');
    author = parts.pop().trim();
    title = parts.join(' - ').trim();
  }
  // Format string cleanup — "M4B / Bitrate: 128 KbpsFile Size: 698 MBs" → "M4B · 128 Kbps"
  let format = null;
  if (b.format) {
    const fmtMatch = b.format.match(/^([A-Z0-9]+)\s*\/\s*Bitrate:\s*([\w\s]+?)(?:File|$)/i);
    format = fmtMatch ? `${fmtMatch[1]} · ${fmtMatch[2].trim()}` : b.format.split('/')[0].trim();
  } else if (b.duration_seconds) {
    format = `${Math.floor(b.duration_seconds/3600)}h ${Math.floor((b.duration_seconds%3600)/60)}m${b.abridged ? ' · Abridged' : ''}`;
  }
  const narrator = Array.isArray(b.narrators) ? b.narrators.map(n => n.name || n).filter(Boolean).join(', ') : null;
  const genres = b.files?.[0]?.tag_genre ? b.files[0].tag_genre.split(',').map(g => g.trim()).filter(Boolean) : [];
  const cover = b.has_cover && b.id
    ? `/api/library/cover/audiobook/${b.id}`
    : (b.cover_url || null);
  return {
    title,
    author,
    year: b.published_date ? new Date(b.published_date).getFullYear() : (b.year || null),
    format,
    cover,
    publisher: b.publisher || null,
    description: b.description || null,
    isbn: b.asin ? `ASIN: ${b.asin}` : null,
    series: b.series_name ? `${b.series_name}${b.series_index ? ' #' + b.series_index : ''}` : null,
    genres,
    rating: null,
    narrator,
    id: b.id || null,
    language: (b.language || '').toLowerCase().trim() || null,
    status: 'available',
    source: 'bookwarehouse',
    lm_url: process.env.SHELFMARK_URL || '',
    type: 'audiobook',
    _cacheKey: String(b.id || b.title),
    _raw: b,
  };
}
function normComic(b) {
  const title = b.title || b.name || '';
  const id = b.id ? String(b.id) : null;
  return {
    title,
    author: b.author || b.creator || b.publisher || '',
    year: b.year || b.start_year || b.published_date || null,
    format: 'CBZ',
    language: (b.language || 'en').toLowerCase(),
    cover: b.cover_url || b.image_url || b.thumbnail || null,
    publisher: b.publisher || null,
    description: b.description || null,
    isbn: null,
    series: null,
    genres: b.genres || b.tags || [],
    rating: null,
    id,
    status: 'available',
    source: 'bookwarehouse',
    lm_url: null,
    type: 'comic',
    _cacheKey: String(id || title),
    _raw: b,
  };
}

function comicItemTitle(item) {
  const series = item.series_name || item.series?.title || item.series_title || '';
  const title = item.title || item.name || '';
  const issue = item.issue_number || item.number || item.issue || null;
  if (title) return title;
  if (series && issue) return `${series} #${issue}`;
  return series || 'Comic Issue';
}

function normComicIssue(item) {
  const id = item.id || item._id || item.item_id;
  const seriesId = item.series_id || item.series?.id || null;
  const title = comicItemTitle(item);
  return {
    id: id ? String(id) : null,
    title,
    series: item.series_name || item.series?.title || item.series_title || '',
    cover: id ? `/api/library/comics/items/${id}/pages/0` : null,
    issue_number: item.issue_number || item.number || item.issue || null,
    page_count: comicPageCount(item),
    volume_number: item.volume_number || item.volume || null,
    publisher: item.publisher || item.series?.publisher || null,
    year: item.year || item.published_year || item.release_year || item.published_date || null,
    format: (item.format || item.file_format || item.item_type || 'CBZ').toString().toUpperCase(),
    series_id: seriesId ? String(seriesId) : null,
    source: 'bookwarehouse',
    type: 'comic',
    _raw: item,
  };
}

const OPDS_AUTH_CACHE = new Map();

function opdsBaseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').toString().split(',')[0];
  const host = req.get('host');
  const publicProto = host && !host.includes('localhost') && !host.startsWith('127.') ? 'https' : proto;
  return `${publicProto}://${host}`;
}

function opdsCoverSig(id) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET || 'opds-cover-secret')
    .update(String(id || ''))
    .digest('hex')
    .slice(0, 24);
}

function opdsAuthChallenge(res) {
  res.set('WWW-Authenticate', 'Basic realm="Portal v1 Comics OPDS"');
  return res.status(401).send('Authentication required');
}

async function requireOpdsAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return opdsAuthChallenge(res);
  let decoded = '';
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch (_) {
    return opdsAuthChallenge(res);
  }
  const splitAt = decoded.indexOf(':');
  const username = splitAt >= 0 ? decoded.slice(0, splitAt).trim() : '';
  const password = splitAt >= 0 ? decoded.slice(splitAt + 1) : '';
  if (!username || !password) return opdsAuthChallenge(res);

  const cacheKey = crypto.createHash('sha256').update(`${username}\n${password}`).digest('hex');
  const cached = OPDS_AUTH_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
    req.opdsUser = cached.user;
    return next();
  }

  const auth = await embyAuthenticate(username, password);
  if (!auth?.User?.Id) return opdsAuthChallenge(res);
  const { data: account } = await db.from('emby_accounts')
    .select('is_disabled, username, emby_user_id')
    .eq('emby_user_id', auth.User.Id)
    .maybeSingle();
  if (account?.is_disabled) return opdsAuthChallenge(res);

  const user = { id: auth.User.Id, username: auth.User.Name };
  OPDS_AUTH_CACHE.set(cacheKey, { ts: Date.now(), user });
  req.opdsUser = user;
  next();
}

function opdsEntryForIssue(req, issue) {
  const base = opdsBaseUrl(req);
  const id = encodeURIComponent(issue.id || '');
  const coverHref = `${base}/opds/public/comics/${id}/cover?sig=${opdsCoverSig(issue.id)}`;
  const streamHref = `${base}/opds/comics/${id}/stream?title=${encodeURIComponent(issue.title || `comic-${issue.id}`)}`;
  const pageStreamHref = `${base}/opds/comics/${id}/page?pageNumber={pageNumber}`;
  const title = xmlEsc(issue.title || 'Comic Issue');
  const author = xmlEsc(issue.publisher || issue.series || 'Portal v1');
  const updated = new Date().toISOString();
  const summary = xmlEsc(`File Type: x-cbz${issue.series ? ` · ${issue.series}` : ''}${issue.issue_number ? ` · Issue #${issue.issue_number}` : ''}${issue.year ? ` · ${issue.year}` : ''}`);
  const pageCount = Number(issue.page_count) > 0 ? Number(issue.page_count) : null;
  return `<entry>
    <title>${title}</title>
    <id>urn:portal-v1:comic:${xmlEsc(issue.id || issue.title)}</id>
    <updated>${updated}</updated>
    <author><name>${author}</name></author>
    <summary>${summary}</summary>
    ${issue.cover ? `<link rel="http://opds-spec.org/image" href="${coverHref}" type="image/jpeg"/>` : ''}
    ${issue.cover ? `<link rel="http://opds-spec.org/image/thumbnail" href="${coverHref}" type="image/jpeg"/>` : ''}
    ${issue.cover ? `<link rel="http://opds-spec.org/cover" href="${coverHref}" type="image/jpeg"/>` : ''}
    ${issue.cover ? `<link rel="http://opds-spec.org/thumbnail" href="${coverHref}" type="image/jpeg"/>` : ''}
    <link rel="http://opds-spec.org/acquisition/open-access" type="application/x-cbz" href="${streamHref}" title="${title}"${pageCount ? ` p5:count="${pageCount}" xmlns:p5="http://vaemendis.net/opds-pse/ns"` : ''}/>
    <link rel="http://vaemendis.net/opds-pse/stream" type="image/jpeg" href="${pageStreamHref}"${pageCount ? ` p5:count="${pageCount}" xmlns:p5="http://vaemendis.net/opds-pse/ns"` : ''}/>
    <content type="text">application/x-cbz</content>
  </entry>`;
}

function opdsEntryForSeries(req, series) {
  const base = opdsBaseUrl(req);
  const id = encodeURIComponent(series.id || '');
  const title = xmlEsc(series.title || 'Comic Series');
  const author = xmlEsc(series.publisher || series.author || 'Portal v1');
  const summary = xmlEsc([series.publisher, series.year].filter(Boolean).join(' · '));
  return `<entry>
    <title>${title}</title>
    <id>urn:portal-v1:comic-series:${xmlEsc(series.id || series.title)}</id>
    <updated>${new Date().toISOString()}</updated>
    <author><name>${author}</name></author>
    <summary>${summary}</summary>
    ${series.id ? `<link rel="http://opds-spec.org/image" href="${base}/opds/series/${id}/cover" type="image/jpeg"/>` : ''}
    ${series.id ? `<link rel="http://opds-spec.org/image/thumbnail" href="${base}/opds/series/${id}/cover" type="image/jpeg"/>` : ''}
    ${series.id ? `<link rel="http://opds-spec.org/cover" href="${base}/opds/series/${id}/cover" type="image/jpeg"/>` : ''}
    ${series.id ? `<link rel="http://opds-spec.org/thumbnail" href="${base}/opds/series/${id}/cover" type="image/jpeg"/>` : ''}
    <link rel="subsection" href="${base}/opds/series/${id}" type="application/atom+xml;profile=opds-catalog"/>
  </entry>`;
}

async function attachComicPageCounts(issues) {
  const limit = 5;
  const out = new Array(issues.length);
  let index = 0;
  async function worker() {
    while (index < issues.length) {
      const current = index++;
      const issue = issues[current];
      if (!issue?.id || Number(issue.page_count) > 0) {
        out[current] = issue;
        continue;
      }
      const metaRes = await axios.get(`${BW_BASE}/comics/items/${encodeURIComponent(issue.id)}/pages`, {
        headers: BW_HEADERS(),
        timeout: 6000
      }).catch(() => null);
      out[current] = { ...issue, page_count: comicPageCount(metaRes?.data) };
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, issues.length) }, worker));
  return out;
}

function sendOpds(res, xml) {
  res.set('Content-Type', 'application/atom+xml;profile=opds-catalog;charset=utf-8');
  res.set('Cache-Control', 'private, max-age=60');
  res.send(xml);
}

app.get('/opds/search.xml', requireOpdsAuth, (req, res) => {
  const base = opdsBaseUrl(req);
  res.set('Content-Type', 'application/opensearchdescription+xml;charset=utf-8');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>Portal v1 Comics</ShortName>
  <Description>Search Portal v1 comics</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <Url type="application/atom+xml;profile=opds-catalog" template="${base}/opds/comics?q={searchTerms}"/>
</OpenSearchDescription>`);
});

app.get('/opds', requireOpdsAuth, (req, res) => {
  const base = opdsBaseUrl(req);
  sendOpds(res, `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog" xmlns:pse="http://vaemendis.net/opds-pse/ns">
  <id>urn:portal-v1:opds:root</id>
  <title>Portal v1 Comics</title>
  <updated>${new Date().toISOString()}</updated>
  <author><name>Portal v1</name></author>
  <link rel="self" href="${base}/opds" type="application/atom+xml;profile=opds-catalog"/>
  <link rel="search" href="${base}/opds/search.xml" type="application/opensearchdescription+xml"/>
  <entry>
    <title>Issues</title>
    <id>urn:portal-v1:opds:comics</id>
    <updated>${new Date().toISOString()}</updated>
    <link rel="subsection" href="${base}/opds/comics" type="application/atom+xml;profile=opds-catalog"/>
  </entry>
  <entry>
    <title>Series</title>
    <id>urn:portal-v1:opds:series</id>
    <updated>${new Date().toISOString()}</updated>
    <link rel="subsection" href="${base}/opds/series" type="application/atom+xml;profile=opds-catalog"/>
  </entry>
</feed>`);
});

app.get('/opds/series', requireOpdsAuth, async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 60);
  const q = String(req.query.q || '').trim();
  const base = opdsBaseUrl(req);
  try {
    const url = q
      ? `${BW_BASE}/comics/series/search?q=${encodeURIComponent(q)}&limit=${limit}&page=${page}`
      : `${BW_BASE}/comics/series?limit=${limit}&page=${page}`;
    const r = await axios.get(url, { headers: BW_HEADERS(), timeout: 10000 });
    const raw = bwList(r.data, 'series', 'results');
    const series = raw.map(normComic).filter(s => s.id);
    const total = bwTotal(r.data, series.length);
    const next = total > page * limit ? `<link rel="next" href="${base}/opds/series?page=${page + 1}${q ? `&amp;q=${encodeURIComponent(q)}` : ''}" type="application/atom+xml;profile=opds-catalog"/>` : '';
    const prev = page > 1 ? `<link rel="previous" href="${base}/opds/series?page=${page - 1}${q ? `&amp;q=${encodeURIComponent(q)}` : ''}" type="application/atom+xml;profile=opds-catalog"/>` : '';
    sendOpds(res, `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog" xmlns:pse="http://vaemendis.net/opds-pse/ns">
  <id>urn:portal-v1:opds:series:${xmlEsc(q || 'all')}:${page}</id>
  <title>${q ? `Series Search: ${xmlEsc(q)}` : 'Comic Series'}</title>
  <updated>${new Date().toISOString()}</updated>
  <author><name>Portal v1</name></author>
  <link rel="self" href="${base}/opds/series?page=${page}${q ? `&amp;q=${encodeURIComponent(q)}` : ''}" type="application/atom+xml;profile=opds-catalog"/>
  <link rel="start" href="${base}/opds" type="application/atom+xml;profile=opds-catalog"/>
  <link rel="search" href="${base}/opds/search.xml" type="application/opensearchdescription+xml"/>
  ${prev}
  ${next}
  ${series.map(s => opdsEntryForSeries(req, s)).join('\n')}
</feed>`);
  } catch(e) {
    console.error('[opds series]', e.message);
    res.status(502).send('Could not load OPDS series');
  }
});

app.get('/opds/series/:id', requireOpdsAuth, async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 40, 1), 80);
  const base = opdsBaseUrl(req);
  const seriesId = encodeURIComponent(req.params.id);
  try {
    const r = await axios.get(`${BW_BASE}/comics/series/${seriesId}/items?limit=${limit}&page=${page}`, {
      headers: BW_HEADERS(),
      timeout: 10000
    });
    const raw = bwList(r.data, 'items', 'results');
    const issues = await attachComicPageCounts(raw.map(normComicIssue).filter(issue => issue.id));
    const total = bwTotal(r.data, issues.length);
    const title = xmlEsc(issues[0]?.series || 'Comic Series');
    const next = total > page * limit ? `<link rel="next" href="${base}/opds/series/${seriesId}?page=${page + 1}" type="application/atom+xml;profile=opds-catalog"/>` : '';
    const prev = page > 1 ? `<link rel="previous" href="${base}/opds/series/${seriesId}?page=${page - 1}" type="application/atom+xml;profile=opds-catalog"/>` : '';
    sendOpds(res, `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog" xmlns:pse="http://vaemendis.net/opds-pse/ns">
  <id>urn:portal-v1:opds:series:${xmlEsc(req.params.id)}:${page}</id>
  <title>${title}</title>
  <updated>${new Date().toISOString()}</updated>
  <author><name>Portal v1</name></author>
  <link rel="self" href="${base}/opds/series/${seriesId}?page=${page}" type="application/atom+xml;profile=opds-catalog"/>
  <link rel="start" href="${base}/opds" type="application/atom+xml;profile=opds-catalog"/>
  ${prev}
  ${next}
  ${issues.map(issue => opdsEntryForIssue(req, issue)).join('\n')}
</feed>`);
  } catch(e) {
    console.error('[opds series items]', e.message);
    res.status(502).send('Could not load OPDS series issues');
  }
});

app.get('/opds/series/:id/cover', requireOpdsAuth, async (req, res) => {
  try {
    const itemsRes = await axios.get(`${BW_BASE}/comics/series/${encodeURIComponent(req.params.id)}/items?limit=1&page=1`, {
      headers: BW_HEADERS(),
      timeout: 10000
    });
    const first = bwList(itemsRes.data, 'items', 'results')[0];
    const itemId = first?.id || first?._id || first?.item_id;
    if (!itemId) return res.status(404).end();
    const pageRes = await axios.get(`${BW_BASE}/comics/items/${itemId}/pages/0`, {
      headers: BW_HEADERS(),
      responseType: 'arraybuffer',
      timeout: 10000
    });
    res.set('Content-Type', pageRes.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(pageRes.data);
  } catch(e) {
    res.status(404).end();
  }
});

app.get('/opds/comics', requireOpdsAuth, async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 60);
  const q = String(req.query.q || '').trim();
  const base = opdsBaseUrl(req);
  try {
    let raw = [];
    let total = 0;
    if (q) {
      const seriesRes = await axios.get(`${BW_BASE}/comics/series/search?q=${encodeURIComponent(q)}&limit=10&page=1`, {
        headers: BW_HEADERS(),
        timeout: 10000
      });
      const matches = bwList(seriesRes.data, 'series', 'results').slice(0, 10);
      const itemResults = await Promise.all(matches.map(s => {
        const id = s.id || s._id;
        return id
          ? axios.get(`${BW_BASE}/comics/series/${id}/items?limit=20&page=1`, { headers: BW_HEADERS(), timeout: 10000 }).catch(() => null)
          : Promise.resolve(null);
      }));
      const seen = new Set();
      raw = itemResults.flatMap(r => bwList(r?.data, 'items', 'results')).filter(item => {
        const key = item.id || item._id || item.item_id || comicItemTitle(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      total = raw.length;
      raw = raw.slice((page - 1) * limit, page * limit);
    } else {
      const r = await axios.get(`${BW_BASE}/comics/items?limit=${limit}&page=${page}`, {
        headers: BW_HEADERS(),
        timeout: 10000
      });
      raw = bwList(r.data, 'items', 'results');
      total = bwTotal(r.data, raw.length);
    }
    const issues = await attachComicPageCounts(raw.map(normComicIssue).filter(issue => issue.id));
    const next = total > page * limit ? `<link rel="next" href="${base}/opds/comics?page=${page + 1}${q ? `&amp;q=${encodeURIComponent(q)}` : ''}" type="application/atom+xml;profile=opds-catalog"/>` : '';
    const prev = page > 1 ? `<link rel="previous" href="${base}/opds/comics?page=${page - 1}${q ? `&amp;q=${encodeURIComponent(q)}` : ''}" type="application/atom+xml;profile=opds-catalog"/>` : '';
    sendOpds(res, `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog" xmlns:pse="http://vaemendis.net/opds-pse/ns">
  <id>urn:portal-v1:opds:comics:${xmlEsc(q || 'latest')}:${page}</id>
  <title>${q ? `Search: ${xmlEsc(q)}` : 'Issues'}</title>
  <updated>${new Date().toISOString()}</updated>
  <author><name>Portal v1</name></author>
  <link rel="self" href="${base}/opds/comics?page=${page}${q ? `&amp;q=${encodeURIComponent(q)}` : ''}" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
  <link rel="start" href="${base}/opds" type="application/atom+xml;profile=opds-catalog"/>
  <link rel="search" href="${base}/opds/search.xml" type="application/opensearchdescription+xml"/>
  ${prev}
  ${next}
  ${issues.map(issue => opdsEntryForIssue(req, issue)).join('\n')}
</feed>`);
  } catch(e) {
    console.error('[opds comics]', e.message);
    res.status(502).send('Could not load OPDS comics');
  }
});

app.get('/opds/comics/:id/cover', requireOpdsAuth, async (req, res) => {
  try {
    const r = await axios.get(`${BW_BASE}/comics/items/${req.params.id}/pages/0`, {
      headers: BW_HEADERS(),
      responseType: 'arraybuffer',
      timeout: 10000
    });
    res.set('Content-Type', r.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(r.data);
  } catch(e) {
    res.status(404).end();
  }
});

app.get('/opds/public/comics/:id/cover', async (req, res) => {
  if (req.query.sig !== opdsCoverSig(req.params.id)) return res.status(403).end();
  try {
    const r = await axios.get(`${BW_BASE}/comics/items/${req.params.id}/pages/0`, {
      headers: BW_HEADERS(),
      responseType: 'arraybuffer',
      timeout: 10000
    });
    res.set('Content-Type', r.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(r.data);
  } catch(e) {
    res.status(404).end();
  }
});

app.get('/opds/comics/:id/page', requireOpdsAuth, async (req, res) => {
  try {
    const page = Math.max(0, parseInt(req.query.pageNumber, 10) || 0);
    const r = await axios.get(`${BW_BASE}/comics/items/${req.params.id}/pages/${page}`, {
      headers: BW_HEADERS(),
      responseType: 'arraybuffer',
      timeout: 15000
    });
    res.set('Content-Type', r.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(r.data);
  } catch(e) {
    console.error('[opds comic page]', e.response?.status, e.message);
    res.status(404).end();
  }
});

async function streamOpdsComic(req, res) {
  try {
    const headers = BW_HEADERS();
    if (req.headers.range) headers.Range = req.headers.range;
    const r = await axios.get(`${BW_BASE}/comics/items/${req.params.id}/download`, {
      headers,
      responseType: 'stream',
      timeout: 30000,
      validateStatus: status => status === 200 || status === 206
    });
    const title = safeDownloadName(req.query.title || `comic-${req.params.id}`, `comic-${req.params.id}`);
    res.status(r.status);
    res.set('Content-Type', 'application/x-cbz');
    res.set('Accept-Ranges', r.headers['accept-ranges'] || 'bytes');
    if (r.headers['content-length']) res.set('Content-Length', r.headers['content-length']);
    if (r.headers['content-range']) res.set('Content-Range', r.headers['content-range']);
    res.set('Content-Disposition', `inline; filename="${title}.cbz"`);
    res.set('Cache-Control', 'private, max-age=60');
    if (req.method === 'HEAD') {
      r.data.destroy();
      return res.end();
    }
    r.data.pipe(res);
  } catch(e) {
    console.error('[opds comic stream]', e.response?.status, e.message);
    res.status(404).send('Comic file not found');
  }
}

app.head('/opds/comics/:id/stream', requireOpdsAuth, streamOpdsComic);
app.get('/opds/comics/:id/stream', requireOpdsAuth, streamOpdsComic);

app.get('/opds/comics/:id/download', requireOpdsAuth, async (req, res) => {
  try {
    const r = await axios.get(`${BW_BASE}/comics/items/${req.params.id}/download`, {
      headers: BW_HEADERS(),
      responseType: 'stream',
      timeout: 30000
    });
    const title = safeDownloadName(req.query.title || `comic-${req.params.id}`, `comic-${req.params.id}`);
    res.set('Content-Type', 'application/x-cbz');
    if (r.headers['content-length']) res.set('Content-Length', r.headers['content-length']);
    res.set('Content-Disposition', `attachment; filename="${title}.cbz"`);
    r.data.pipe(res);
  } catch(e) {
    console.error('[opds comic download]', e.response?.status, e.message);
    res.status(404).send('Comic file not found');
  }
});

function bwList(data, ...keys) {
  for (const key of keys) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  if (Array.isArray(data)) return data;
  return [];
}

function bwTotal(data, fallback) {
  return data?.pagination?.total_items || data?.pagination?.total || data?.total_items || data?.total || fallback;
}

function safeDownloadName(name, fallback = 'comic') {
  return (name || fallback).toString().replace(/[^\w\s.-]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || fallback;
}

function safeCacheKey(name, fallback = 'comic') {
  return safeDownloadName(name, fallback).replace(/[^\w.-]+/g, '_') || fallback;
}

function contentDispositionExt(value) {
  const m = String(value || '').match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
  if (!m) return null;
  const filename = decodeURIComponent(m[1].replace(/"/g, '').trim());
  const ext = path.extname(filename).toLowerCase().replace('.', '');
  return ext || null;
}

function runCommand(command, args, timeoutMs = 120000, cwd = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], ...(cwd ? { cwd } : {}) });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Conversion timed out'));
    }, timeoutMs);
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `Conversion failed with code ${code}`));
    });
  });
}

function streamToFile(readable, filePath) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(filePath);
    readable.pipe(out);
    readable.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
  });
}

function xmlEsc(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function imageExt(contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('png')) return { ext: 'png', media: 'image/png' };
  if (type.includes('webp')) return { ext: 'webp', media: 'image/webp' };
  if (type.includes('gif')) return { ext: 'gif', media: 'image/gif' };
  return { ext: 'jpg', media: 'image/jpeg' };
}

function comicPageCount(data) {
  if (Array.isArray(data)) return data.length;
  if (Array.isArray(data?.pages)) return data.pages.length;
  const n = data?.total_pages || data?.page_count || data?.pages_count || data?.count || data?.total || data?.pagination?.total_items;
  return Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : null;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

async function listFilesRecursive(root, dir = root) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listFilesRecursive(root, full));
    else files.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return files;
}

async function writeZipFromDir(root, outputPath) {
  const allFiles = await listFilesRecursive(root);
  const files = ['mimetype', ...allFiles.filter(f => f !== 'mimetype').sort()];
  const locals = [];
  const centrals = [];
  let offset = 0;
  const dt = dosDateTime();
  for (const file of files) {
    const raw = await fs.promises.readFile(path.join(root, file));
    const name = Buffer.from(file);
    const method = file === 'mimetype' ? 0 : 8;
    const data = method === 0 ? raw : zlib.deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dt.time, 10);
    local.writeUInt16LE(dt.day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dt.time, 12);
    central.writeUInt16LE(dt.day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  await fs.promises.writeFile(outputPath, Buffer.concat([...locals, ...centrals, end]));
}

async function writeZipSingleFile(inputPath, outputPath, filename) {
  const raw = await fs.promises.readFile(inputPath);
  const name = Buffer.from(filename);
  const data = zlib.deflateRawSync(raw);
  const crc = crc32(raw);
  const dt = dosDateTime();

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(dt.time, 10);
  local.writeUInt16LE(dt.day, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(dt.time, 12);
  central.writeUInt16LE(dt.day, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);

  const centralSize = central.length + name.length;
  const offset = local.length + name.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  await fs.promises.writeFile(outputPath, Buffer.concat([local, name, data, central, name, end]));
}

async function writeStoredZipSingleFile(inputPath, outputPath, filename) {
  const raw = await fs.promises.readFile(inputPath);
  const name = Buffer.from(filename);
  const crc = crc32(raw);
  const dt = dosDateTime();

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(dt.time, 10);
  local.writeUInt16LE(dt.day, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(raw.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(dt.time, 12);
  central.writeUInt16LE(dt.day, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(raw.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);

  const centralSize = central.length + name.length;
  const offset = local.length + name.length + raw.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  await fs.promises.writeFile(outputPath, Buffer.concat([local, name, raw, central, name, end]));
}

async function buildComicEpubFromPages(itemId, title, outputPath, tempDir) {
  const metaRes = await axios.get(`${BW_BASE}/comics/items/${itemId}/pages`, {
    headers: BW_HEADERS(),
    timeout: 12000
  }).catch(() => null);
  const knownCount = comicPageCount(metaRes?.data);
  const bookDir = path.join(tempDir, 'epub');
  const metaInf = path.join(bookDir, 'META-INF');
  const oebps = path.join(bookDir, 'OEBPS');
  const imageDir = path.join(oebps, 'images');
  const textDir = path.join(oebps, 'text');
  await fs.promises.mkdir(metaInf, { recursive: true });
  await fs.promises.mkdir(imageDir, { recursive: true });
  await fs.promises.mkdir(textDir, { recursive: true });

  const pages = [];
  const maxPages = knownCount || 500;
  for (let i = 0; i < maxPages; i++) {
    const pageRes = await axios.get(`${BW_BASE}/comics/items/${itemId}/pages/${i}`, {
      headers: BW_HEADERS(),
      responseType: 'arraybuffer',
      timeout: 20000
    }).catch(() => null);
    if (!pageRes?.data?.byteLength) {
      if (pages.length) break;
      throw new Error('No comic pages available');
    }
    const img = imageExt(pageRes.headers['content-type']);
    const num = String(i + 1).padStart(4, '0');
    const imageName = `page_${num}.${img.ext}`;
    const xhtmlName = `page_${num}.xhtml`;
    await fs.promises.writeFile(path.join(imageDir, imageName), Buffer.from(pageRes.data));
    await fs.promises.writeFile(path.join(textDir, xhtmlName), `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${xmlEsc(title)} ${i + 1}</title><style>html,body{margin:0;padding:0;background:#000;}img{display:block;width:100%;height:auto;}</style></head>
<body><img src="../images/${imageName}" alt="Page ${i + 1}"/></body>
</html>`);
    pages.push({ imageName, xhtmlName, media: img.media });
  }

  if (!pages.length) throw new Error('No comic pages available');
  await fs.promises.writeFile(path.join(bookDir, 'mimetype'), 'application/epub+zip');
  await fs.promises.writeFile(path.join(metaInf, 'container.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);
  await fs.promises.writeFile(path.join(oebps, 'nav.xhtml'), `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${xmlEsc(title)}</title></head>
<body><nav epub:type="toc"><h1>${xmlEsc(title)}</h1><ol>${pages.map((p, i) => `<li><a href="text/${p.xhtmlName}">Page ${i + 1}</a></li>`).join('')}</ol></nav></body>
</html>`);
  await fs.promises.writeFile(path.join(oebps, 'content.opf'), `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:identifier id="bookid">portal-comic-${xmlEsc(itemId)}</dc:identifier>
  <dc:title>${xmlEsc(title)}</dc:title>
  <dc:language>en</dc:language>
  <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}</meta>
</metadata>
<manifest>
  <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  ${pages.map((p, i) => `<item id="page${i + 1}" href="text/${p.xhtmlName}" media-type="application/xhtml+xml"/>`).join('\n  ')}
  ${pages.map((p, i) => `<item id="img${i + 1}" href="images/${p.imageName}" media-type="${p.media}"${i === 0 ? ' properties="cover-image"' : ''}/>`).join('\n  ')}
</manifest>
<spine>${pages.map((p, i) => `<itemref idref="page${i + 1}"/>`).join('')}</spine>
</package>`);

  await writeZipFromDir(bookDir, outputPath);
}

async function ensureComicEpub(itemId, title) {
  let tempDir = null;
  const cleanTitle = safeDownloadName(title || `comic-${itemId}`, `comic-${itemId}`);
  const cacheDir = path.join(os.tmpdir(), 'portal-comic-epub-pages-v3');
  await fs.promises.mkdir(cacheDir, { recursive: true });
  const cachedPath = path.join(cacheDir, `${safeCacheKey(itemId)}.epub`);
  if (fs.existsSync(cachedPath)) return { path: cachedPath, title: cleanTitle };
  try {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'portal-comic-'));
    const outputPath = path.join(tempDir, 'output.epub');
    try {
      await buildComicEpubFromPages(itemId, cleanTitle, outputPath, tempDir);
    } catch(pageErr) {
      console.error('[comic epub pages fallback]', pageErr.message);
      const r = await axios.get(`${BW_BASE}/comics/items/${itemId}/download`, {
        headers: BW_HEADERS(),
        responseType: 'stream',
        timeout: 60000
      });
      const dispositionExt = contentDispositionExt(r.headers['content-disposition']);
      const type = String(r.headers['content-type'] || '').toLowerCase();
      const ext = dispositionExt || (type.includes('rar') ? 'cbr' : type.includes('zip') ? 'cbz' : 'cbz');
      const inputPath = path.join(tempDir, `input.${ext}`);
      await streamToFile(r.data, inputPath);
      const calibreBin = fs.existsSync('/opt/calibre/ebook-convert') ? '/opt/calibre/ebook-convert' : 'ebook-convert';
      await runCommand(calibreBin, [inputPath, outputPath], 180000);
    }
    await fs.promises.copyFile(outputPath, cachedPath);
    return { path: cachedPath, title: cleanTitle };
  } finally {
    if (tempDir) fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Return the operator's Kavita OPDS URL to an authenticated member. Kavita's
// OPDS feed is the supported source for comic-reader apps (Panels, Chunky,
// Moon+ Reader, etc.); Portal does not proxy or store comic files itself.
app.get('/api/library/kavita/opds', requireAuth, (req, res) => {
  const url = kavitaOpdsUrl();
  if (!url) return res.status(503).json({ error: 'Kavita OPDS is not configured.' });
  res.json({ url, provider: 'kavita', message: 'Add this URL to your comic reader app.' });
});

// Search: returns { library: [...], external: [...] }
app.get('/api/library/search', requireAuth, async (req, res) => {
  const { type, q } = req.query;
  if (!q) return res.json({ error: 'Query required' });
  try {
    let libraryUrl, externalUrl, normFn;
    if (type === 'ebook') {
      libraryUrl  = `${BW_BASE}/books/search?q=${encodeURIComponent(q)}&limit=8`;
      externalUrl = `${BW_BASE}/search/external?q=${encodeURIComponent(q)}`;
      normFn = normBook;
    } else if (type === 'audiobook') {
      libraryUrl  = `${BW_BASE}/audiobooks/search?q=${encodeURIComponent(q)}&limit=8`;
      externalUrl = `${BW_BASE}/audiobooks/abiplayer/search?q=${encodeURIComponent(q)}`;
      normFn = normAudiobook;
    } else if (type === 'comic') {
      libraryUrl = `${BW_BASE}/comics/series/search?q=${encodeURIComponent(q)}&limit=8`;
      externalUrl = null;
      normFn = normComic;
    } else {
      return res.json({ error: 'Invalid type' });
    }

    const [libRes, extRes] = await Promise.all([
      axios.get(libraryUrl, { headers: BW_HEADERS(), timeout: 10000 }).catch(() => null),
      externalUrl ? axios.get(externalUrl, { headers: BW_HEADERS(), timeout: 10000 }).catch(() => null) : Promise.resolve(null),
    ]);

    const libRaw = libRes?.data?.series || libRes?.data?.results || libRes?.data?.comics || libRes?.data?.books || libRes?.data?.audiobooks || libRes?.data || [];
    const extRaw = extRes?.data?.results || extRes?.data?.series || extRes?.data || [];

    res.json({
      library:  (Array.isArray(libRaw) ? libRaw : []).slice(0, 8).map(normFn),
      external: (Array.isArray(extRaw) ? extRaw : []).slice(0, 8).map(normFn),
    });
  } catch(e) {
    console.error('[library search]', e.response?.status, e.message);
    res.json({ error: 'Search failed — try again shortly' });
  }
});

// Cover proxy — serves book/audiobook covers without exposing the API key
app.get('/api/library/cover/book/:id', requireAuth, async (req, res) => {
  try {
    const r = await axios.get(`${BW_BASE}/books/${req.params.id}/cover/medium`, {
      headers: BW_HEADERS(),
      responseType: 'arraybuffer',
      timeout: 8000
    });
    res.set('Content-Type', r.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(r.data);
  } catch(e) {
    res.status(404).end();
  }
});

app.get('/api/library/books', requireAuth, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(40, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const q = (req.query.q || '').trim();
  try {
    const url = q
      ? `${BW_BASE}/books/search?q=${encodeURIComponent(q)}&limit=${limit}`
      : `${BW_BASE}/books?page=${page}&limit=${limit}&sort=updated_at&order=desc`;
    const r = await axios.get(url, { headers: BW_HEADERS(), timeout: 10000 });
    const raw = bwList(r.data, 'books', 'results', 'items');
    const total = q ? raw.length : bwTotal(r.data, raw.length);
    res.json({ books: raw.map(normBook), total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) });
  } catch(e) {
    console.error('[ebook books]', e.message);
    res.json({ books: [], total: 0, page, limit, pages: 0 });
  }
});

app.get('/api/library/audiobooks', requireAuth, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(40, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const q = (req.query.q || '').trim();
  try {
    const url = q
      ? `${BW_BASE}/audiobooks/search?q=${encodeURIComponent(q)}&limit=${limit}`
      : `${BW_BASE}/audiobooks?page=${page}&limit=${limit}&sort=updated_at&order=desc`;
    const r = await axios.get(url, { headers: BW_HEADERS(), timeout: 10000 });
    const raw = bwList(r.data, 'audiobooks', 'results', 'items');
    const total = q ? raw.length : bwTotal(r.data, raw.length);
    res.json({ audiobooks: raw.map(normAudiobook), total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) });
  } catch(e) {
    console.error('[audiobook books]', e.message);
    res.json({ audiobooks: [], total: 0, page, limit, pages: 0 });
  }
});

async function ensureBookEpub(bookId, title) {
  let tempDir = null;
  const cleanTitle = safeDownloadName(title || `book-${bookId}`, `book-${bookId}`);
  const cacheDir = path.join(os.tmpdir(), 'portal-bw-book-epub-v1');
  await fs.promises.mkdir(cacheDir, { recursive: true });
  const cachedPath = path.join(cacheDir, `${safeCacheKey(bookId)}.epub`);
  if (fs.existsSync(cachedPath)) return { path: cachedPath, title: cleanTitle };
  try {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'portal-book-'));
    const r = await axios.get(`${BW_BASE}/books/${bookId}/download`, {
      headers: BW_HEADERS(),
      responseType: 'stream',
      timeout: 60000
    });
    const dispositionExt = contentDispositionExt(r.headers['content-disposition']);
    const type = String(r.headers['content-type'] || '').toLowerCase();
    const ext = dispositionExt || (type.includes('epub') ? 'epub' : type.includes('pdf') ? 'pdf' : 'epub');
    const inputPath = path.join(tempDir, `input.${ext}`);
    const outputPath = path.join(tempDir, 'output.epub');
    await streamToFile(r.data, inputPath);
    if (ext === 'epub') {
      const calibreBin = fs.existsSync('/opt/calibre/calibre/ebook-convert')
        ? '/opt/calibre/calibre/ebook-convert'
        : (fs.existsSync('/opt/calibre/ebook-convert') ? '/opt/calibre/ebook-convert' : null);
      if (calibreBin) {
        try {
          await runCommand(calibreBin, [
            inputPath, outputPath,
            '--title', cleanTitle,
            '--epub-version', '3',
            '--no-default-epub-cover',
            '--subset-embedded-fonts',
          ], 120000);
        } catch(e) {
          await fs.promises.copyFile(inputPath, outputPath);
        }
      } else {
        await fs.promises.copyFile(inputPath, outputPath);
      }
    } else {
      const calibreBin = fs.existsSync('/opt/calibre/calibre/ebook-convert')
        ? '/opt/calibre/calibre/ebook-convert'
        : (fs.existsSync('/opt/calibre/ebook-convert') ? '/opt/calibre/ebook-convert' : 'ebook-convert');
      await runCommand(calibreBin, [inputPath, outputPath, '--title', cleanTitle, '--epub-version', '3'], 180000);
    }
    await fs.promises.copyFile(outputPath, cachedPath);
    return { path: cachedPath, title: cleanTitle };
  } finally {
    if (tempDir) fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

app.get('/api/library/books/:id/epub', requireAuth, async (req, res) => {
  try {
    const { path: epubPath, title } = await ensureBookEpub(req.params.id, req.query.title || `book-${req.params.id}`);
    res.setHeader('Content-Type', 'application/epub+zip');
    res.download(epubPath, `${safeDownloadName(title, 'book')}.epub`);
  } catch(e) {
    console.error('[book epub]', e.message);
    res.status(500).json({ error: 'Could not prepare EPUB' });
  }
});

app.post('/api/library/books/:id/send-kindle', requireAuth, async (req, res) => {
  const { emby_user_id } = req.session.user;
  if (!emby_user_id) return res.json({ error: 'No Emby account linked' });
  const { data: account } = await db.from('emby_accounts')
    .select('kindle_email').eq('emby_user_id', emby_user_id).maybeSingle();
  if (!account?.kindle_email) return res.json({ error: 'No Kindle email set — add it in your profile first' });
  try {
    const { path: epubPath, title } = await ensureBookEpub(req.params.id, req.body?.title || `book-${req.params.id}`);
    const fileSizeMB = fs.statSync(epubPath).size / 1024 / 1024;
    if (fileSizeMB > 29) return res.json({ error: `File is too large to email (${fileSizeMB.toFixed(1)}MB — limit is 30MB). Download it instead.` });
    const cleanTitle = safeDownloadName(title, 'book');
    const fileContent = fs.readFileSync(epubPath).toString('base64');
    const delivery = await sendKindleMail({
      label: 'Portal v1 Library',
      to: account.kindle_email,
      subject: '',
      text: `"${title}" is ready on your Kindle.`,
      attachments: [{ filename: `${cleanTitle}.epub`, content: fileContent }]
    });
    console.log(`[book kindle] Sent "${cleanTitle}.epub" (${fileSizeMB.toFixed(1)}MB) via ${getKindleMailConfig().provider} — id: ${delivery?.id || delivery?.messageId || 'sent'}`);
    res.json({ success: true });
  } catch(e) {
    console.error('[book kindle]', e.message, e.response?.data);
    res.json({ error: `Failed to send: ${e.response?.data?.message || e.message}` });
  }
});

app.get('/api/library/comics/items/:id/pages/:page', requireAuth, async (req, res) => {
  try {
    const page = Math.max(0, parseInt(req.params.page, 10) || 0);
    const cacheDir = path.join(os.tmpdir(), 'portal-comic-page-cache');
    await fs.promises.mkdir(cacheDir, { recursive: true });
    const key = `${safeCacheKey(req.params.id)}_${page}`;
    const cachePath = path.join(cacheDir, `${key}.img`);
    const typePath = path.join(cacheDir, `${key}.type`);
    if (fs.existsSync(cachePath)) {
      const contentType = fs.existsSync(typePath) ? await fs.promises.readFile(typePath, 'utf8') : 'image/jpeg';
      res.set('Content-Type', contentType || 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=86400');
      return res.sendFile(cachePath);
    }
    const r = await axios.get(`${BW_BASE}/comics/items/${req.params.id}/pages/${page}`, {
      headers: BW_HEADERS(),
      responseType: 'arraybuffer',
      timeout: 10000
    });
    const contentType = r.headers['content-type'] || 'image/jpeg';
    await fs.promises.writeFile(cachePath, Buffer.from(r.data)).catch(() => {});
    await fs.promises.writeFile(typePath, contentType).catch(() => {});
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(r.data);
  } catch(e) { res.status(404).end(); }
});

app.get('/api/library/comics/series/:id/cover', requireAuth, async (req, res) => {
  try {
    const cacheDir = path.join(os.tmpdir(), 'portal-comic-series-cover-cache');
    await fs.promises.mkdir(cacheDir, { recursive: true });
    const key = safeCacheKey(req.params.id);
    const cachePath = path.join(cacheDir, `${key}.img`);
    const typePath = path.join(cacheDir, `${key}.type`);
    if (fs.existsSync(cachePath)) {
      const contentType = fs.existsSync(typePath) ? await fs.promises.readFile(typePath, 'utf8') : 'image/jpeg';
      res.set('Content-Type', contentType || 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=86400');
      return res.sendFile(cachePath);
    }
    const itemsRes = await axios.get(`${BW_BASE}/comics/series/${req.params.id}/items?limit=1&page=1`, {
      headers: BW_HEADERS(),
      timeout: 8000
    });
    const first = bwList(itemsRes.data, 'items', 'results')[0];
    const itemId = first?.id || first?._id || first?.item_id;
    if (!itemId) return res.status(404).end();
    const pageRes = await axios.get(`${BW_BASE}/comics/items/${itemId}/pages/0`, {
      headers: BW_HEADERS(),
      responseType: 'arraybuffer',
      timeout: 10000
    });
    const contentType = pageRes.headers['content-type'] || 'image/jpeg';
    await fs.promises.writeFile(cachePath, Buffer.from(pageRes.data)).catch(() => {});
    await fs.promises.writeFile(typePath, contentType).catch(() => {});
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(pageRes.data);
  } catch(e) {
    res.status(404).end();
  }
});

app.get('/api/library/comics/items/:id/download', requireAuth, async (req, res) => {
  try {
    const r = await axios.get(`${BW_BASE}/comics/items/${req.params.id}/download`, {
      headers: BW_HEADERS(),
      responseType: 'stream',
      timeout: 30000
    });
    res.set('Content-Type', r.headers['content-type'] || 'application/octet-stream');
    if (r.headers['content-length']) res.set('Content-Length', r.headers['content-length']);
    if (r.headers['content-disposition']) res.set('Content-Disposition', r.headers['content-disposition']);
    else res.set('Content-Disposition', `attachment; filename="comic-${req.params.id}.cbz"`);
    r.data.pipe(res);
  } catch(e) {
    console.error('[comic download]', e.response?.status, e.message);
    res.status(404).json({ error: 'Comic file not found' });
  }
});

app.get('/api/library/comics/items/:id/epub', requireAuth, async (req, res) => {
  try {
    const { path: epubPath, title } = await ensureComicEpub(req.params.id, req.query.title || `comic-${req.params.id}`);
    res.set('Content-Type', 'application/epub+zip');
    res.set('Content-Disposition', `attachment; filename="${title}.epub"`);
    res.set('Cache-Control', 'private, max-age=0, no-store');
    res.sendFile(epubPath, err => {
      if (err) console.error('[comic epub send]', err.message);
    });
  } catch(e) {
    console.error('[comic epub]', e.response?.status, e.message);
    res.status(500).json({ error: 'Could not prepare comic ePub' });
  }
});

app.post('/api/library/comics/items/:id/send-kindle', requireAuth, async (req, res) => {
  const { emby_user_id } = req.session.user;
  if (!emby_user_id) return res.json({ error: 'No Emby account linked' });
  if (!kindleMailConfigured()) return res.json({ error: 'Kindle email delivery is not configured' });
  let tempDir = null;
  try {
    const { data: account } = await db.from('emby_accounts')
      .select('kindle_email, username').eq('emby_user_id', emby_user_id).maybeSingle();
    if (!account?.kindle_email) return res.json({ error: 'No Kindle email set — add it in Settings first' });

    const { path: epubPath, title } = await ensureComicEpub(req.params.id, req.body?.title || `comic-${req.params.id}`);
    const cleanTitle = safeDownloadName(title, 'comic').slice(0, 80);
    const epubSizeMB = fs.statSync(epubPath).size / 1024 / 1024;
    const emailSafeMB = 18;
    if (epubSizeMB > emailSafeMB) {
      return res.json({ error: `This comic is too large to email quickly (${epubSizeMB.toFixed(1)}MB). Use Download instead.` });
    }

    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'portal-comic-kindle-'));
    const sendPath = path.join(tempDir, `${cleanTitle}.zip`);
    await writeStoredZipSingleFile(epubPath, sendPath, `${cleanTitle}.epub`);
    const sendFilename = `${cleanTitle}.zip`;
    let fileSizeMB = fs.statSync(sendPath).size / 1024 / 1024;

    if (fileSizeMB > emailSafeMB) {
      return res.json({ error: `This comic is too large to email quickly (${fileSizeMB.toFixed(1)}MB). Use Download instead.` });
    }

    const fileContent = fs.readFileSync(sendPath).toString('base64');
    const delivery = await sendKindleMail({
      label: 'Portal v1 Library',
      to: account.kindle_email,
      subject: '',
      text: `"${title}" is ready on your Kindle.`,
      attachments: [{ filename: sendFilename, content: fileContent }]
    });
    console.log(`[comic kindle] Sent "${sendFilename}" (${fileSizeMB.toFixed(1)}MB) to ${account.kindle_email} via ${getKindleMailConfig().provider} — id: ${delivery?.id || delivery?.messageId || 'sent'}`);
    res.json({ success: true });
  } catch(e) {
    console.error('[comic kindle]', e.message, e.response?.data);
    res.json({ error: `Failed to send: ${e.response?.data?.message || e.message}` });
  } finally {
    if (tempDir) fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

app.get('/api/library/cover/audiobook/:id', requireAuth, async (req, res) => {
  try {
    const r = await axios.get(`${BW_BASE}/audiobooks/${req.params.id}/cover`, {
      headers: BW_HEADERS(),
      responseType: 'arraybuffer',
      timeout: 8000
    });
    res.set('Content-Type', r.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(r.data);
  } catch(e) {
    res.status(404).end();
  }
});

app.get('/api/library/audiobooks/:id/download', requireAuth, async (req, res) => {
  try {
    const title = String(req.query.title || 'audiobook').replace(/[\\/:*?"<>|]+/g, '').slice(0, 120) || 'audiobook';
    const redirectRes = await axios.head(`${BW_BASE}/audiobooks/${req.params.id}/download`, {
      headers: BW_HEADERS(),
      timeout: 15000,
      maxRedirects: 0,
      validateStatus: status => status >= 200 && status < 400,
    }).catch(e => e.response || null);
    const redirectLocation = redirectRes?.headers?.location;
    if (redirectLocation) {
      return res.redirect(302, redirectLocation);
    }

    const r = await axios.get(`${BW_BASE}/audiobooks/${req.params.id}/download`, {
      headers: {
        ...BW_HEADERS(),
        'Accept-Encoding': 'identity',
        ...(req.headers.range ? { Range: req.headers.range } : {})
      },
      responseType: 'stream',
      timeout: 10 * 60 * 1000,
      maxRedirects: 5,
      decompress: false,
      validateStatus: status => status >= 200 && status < 300,
    });
    const contentType = r.headers['content-type'] || 'application/octet-stream';
    const upstreamName = /filename="?([^";]+)"?/i.exec(r.headers['content-disposition'] || '')?.[1];
    const ext = upstreamName?.split('.').pop() || (contentType.includes('zip') ? 'zip' : contentType.includes('mpeg') ? 'mp3' : contentType.includes('mp4') ? 'm4b' : 'download');
    const filename = upstreamName || `${title}.${ext}`;
    if (r.status === 206) res.status(206);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', 'no-store');
    if (r.headers['accept-ranges']) res.setHeader('Accept-Ranges', r.headers['accept-ranges']);
    if (r.headers['content-range']) res.setHeader('Content-Range', r.headers['content-range']);
    await pipeline(r.data, res);
  } catch(e) {
    const aborted = e.code === 'ERR_STREAM_PREMATURE_CLOSE' || e.message === 'Premature close';
    if (!aborted) console.error('[audiobook download]', e.response?.status, e.message);
    if (res.headersSent) return res.end();
    res.status(500).json({ error: 'Could not prepare audiobook download' });
  }
});

app.get('/api/library/audiobooks/:id/prepare', requireAuth, async (req, res) => {
  let tempPath = null;
  try {
    const title = String(req.query.title || 'audiobook').replace(/[\\/:*?"<>|]+/g, '').slice(0, 120) || 'audiobook';
    const cacheDir = path.join(os.tmpdir(), 'portal-audiobook-downloads-v1');
    await fs.promises.mkdir(cacheDir, { recursive: true });

    const r = await axios.get(`${BW_BASE}/audiobooks/${req.params.id}/download`, {
      headers: { ...BW_HEADERS(), 'Accept-Encoding': 'identity' },
      responseType: 'stream',
      timeout: 20 * 60 * 1000,
      maxRedirects: 5,
      decompress: false,
      validateStatus: status => status >= 200 && status < 300,
    });

    const contentType = r.headers['content-type'] || 'audio/mp4';
    const upstreamName = /filename="?([^";]+)"?/i.exec(r.headers['content-disposition'] || '')?.[1];
    const ext = upstreamName?.split('.').pop() || (contentType.includes('mpeg') ? 'mp3' : contentType.includes('mp4') ? 'm4b' : 'm4b');
    const filename = (upstreamName || `${title}.${ext}`).replace(/[\\/:*?"<>|]+/g, '').slice(0, 160) || `${title}.${ext}`;
    const cacheKey = safeCacheKey(`${req.params.id}-${filename}`, req.params.id);
    const finalPath = path.join(cacheDir, `${cacheKey}.${ext}`);
    const metaPath = `${finalPath}.json`;

    if (!fs.existsSync(finalPath)) {
      tempPath = `${finalPath}.part-${Date.now()}`;
      await pipeline(r.data, fs.createWriteStream(tempPath));
      await fs.promises.rename(tempPath, finalPath);
      tempPath = null;
      await fs.promises.writeFile(metaPath, JSON.stringify({ filename, contentType, createdAt: new Date().toISOString() }));
      console.log(`[audiobook prepare] Ready ${filename} (${(fs.statSync(finalPath).size / 1024 / 1024).toFixed(1)}MB)`);
    } else if (r.data?.destroy) {
      r.data.destroy();
    }

    res.json({
      success: true,
      downloadUrl: `/api/library/audiobooks/${encodeURIComponent(req.params.id)}/file?key=${encodeURIComponent(path.basename(finalPath))}`,
      filename
    });
  } catch(e) {
    if (tempPath) fs.promises.rm(tempPath, { force: true }).catch(() => {});
    console.error('[audiobook prepare]', e.response?.status, e.message);
    res.status(500).json({ error: 'Could not prepare audiobook download' });
  }
});

app.get('/api/library/audiobooks/:id/file', requireAuth, async (req, res) => {
  try {
    const cacheDir = path.join(os.tmpdir(), 'portal-audiobook-downloads-v1');
    const key = path.basename(String(req.query.key || ''));
    if (!key || key.includes('..')) return res.status(400).json({ error: 'Invalid download key' });
    const filePath = path.join(cacheDir, key);
    const metaPath = `${filePath}.json`;
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Audiobook file is no longer ready' });
    let meta = {};
    try { meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8')); } catch (_) {}
    const filename = (meta.filename || key).replace(/"/g, '');
    res.setHeader('Content-Type', meta.contentType || 'audio/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', fs.statSync(filePath).size);
    res.setHeader('Cache-Control', 'no-store');
    res.download(filePath, filename, async err => {
      if (err) {
        console.error('[audiobook file]', err.message);
        return;
      }
      await fs.promises.rm(filePath, { force: true }).catch(() => {});
      await fs.promises.rm(metaPath, { force: true }).catch(() => {});
    });
  } catch(e) {
    console.error('[audiobook file]', e.message);
    res.status(500).json({ error: 'Could not download audiobook' });
  }
});

// Request — accepts either a full raw result object or a plain title/author fallback
app.post('/api/library/request', requireAuth, async (req, res) => {
  const { type, raw, title, author } = req.body;
  const label = raw?.title || title || '(unknown)';
  const username = req.session.user.emby_username || req.session.user.discord_username;
  try {
    let url, body;

    if (type === 'ebook') {
      url = `${BW_BASE}/monitoring/add`;
      if (raw?.isbn) {
        body = { isbn: String(raw.isbn), preferred_format: 'epub' };
      } else if (raw?.search_result) {
        body = { search_result: raw.search_result };
      } else if (raw && (raw.title || raw.name)) {
        const extRes = await axios.get(
          `${BW_BASE}/search/external?q=${encodeURIComponent([raw.title || raw.name, raw.author].filter(Boolean).join(' '))}`,
          { headers: BW_HEADERS(), timeout: 10000 }
        );
        const results = extRes.data?.results || extRes.data || [];
        if (!results.length) return res.json({ error: 'No request source found — try a more specific title.' });
        body = { search_result: results[0] };
      } else if (raw) {
        body = { search_result: raw };
      } else {
        const extRes = await axios.get(
          `${BW_BASE}/search/external?q=${encodeURIComponent(title)}`,
          { headers: BW_HEADERS(), timeout: 10000 }
        );
        const results = extRes.data?.results || extRes.data || [];
        if (!results.length) return res.json({ error: 'No results found — try a more specific title.' });
        body = { search_result: results[0] };
      }
    } else if (type === 'audiobook') {
      url = `${BW_BASE}/audiobooks/abiplayer/requests`;
      body = raw
        ? { title: raw.request_title || raw.bay_title || raw.title, ...(raw.request_author || raw.bay_author || raw.author ? { author: raw.request_author || raw.bay_author || raw.author } : raw.authors?.length ? { author: raw.authors[0] } : {}) }
        : { title, ...(author ? { author } : {}) };
    } else if (type === 'comic') {
      url = `${BW_BASE}/comics/requests`;
      const parsedYear = raw?.year ? parseInt(String(raw.year).slice(0, 4), 10) : null;
      body = raw
        ? {
            series_title: raw.title || raw.name,
            ...(raw.publisher ? { publisher: raw.publisher } : {}),
            ...(Number.isInteger(parsedYear) ? { year: parsedYear } : {}),
            ...(raw.mylar_series_id ? { mylar_series_id: String(raw.mylar_series_id) } : {})
          }
        : { series_title: title };
    } else {
      return res.json({ error: 'Invalid type' });
    }

    try {
      await axios.post(url, body, { headers: BW_HEADERS(), timeout: 15000 });
    } catch(reqErr) {
      const errMsg = reqErr.response?.data?.error || reqErr.response?.data?.message || '';
      // BW returns book_exists when already in library — treat as success
      const alreadyExists = typeof errMsg === 'string' && (
        errMsg.includes('book_exists') || errMsg.includes('already exists') ||
        errMsg.includes('already in') || errMsg.includes('duplicate')
      );
      if (!alreadyExists) throw reqErr;
      console.log(`[library request] ${type} — "${label}" already in library (book_exists)`);
      return res.json({ success: true, already_exists: true });
    }
    console.log(`[library request] ${type} — "${label}" by ${username}`);

    // Save request locally for My Requests tab
    const coverUrl = raw?.cover_url || raw?.cover || raw?.thumbnail || null;
    const description = raw?.description || raw?.summary || null;
    const authorStr = raw?.author || (Array.isArray(raw?.authors) ? raw.authors[0] : null) || author || null;
    const yearStr = raw?.year || raw?.publish_year || (raw?.publishedDate ? String(raw.publishedDate).slice(0,4) : null) || null;
    await db.from('library_requests').insert({
      title: label,
      author: authorStr,
      cover_url: coverUrl,
      description,
      year: yearStr,
      type,
      status: 'pending',
      source: 'bookwarehouse',
      requested_by: username,
      raw_data: raw || null,
    }).select().maybeSingle();

    res.json({ success: true });
  } catch(e) {
    const msg = e.response?.data?.error || e.message;
    console.error('[library request]', e.response?.status, msg);
    res.json({ error: 'Request failed — ' + (typeof msg === 'string' ? msg : 'try again shortly') });
  }
});

app.get('/api/library/comics/request-history', requireAuth, async (req, res) => {
  const username = req.session.user.emby_username || req.session.user.discord_username;
  const cleanTitle = t => (t || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  try {
    const { data, error } = await db
      .from('library_requests')
      .select('id,title,author,cover_url,year,status,created_at,raw_data')
      .eq('requested_by', username)
      .eq('type', 'comic')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    const rows = data || [];
    const checked = await Promise.all(rows.map(async row => {
      const q = (row.title || '').split(' ').slice(0, 6).join(' ');
      let inLibrary = row.status === 'complete' || row.status === 'available';
      let matchId = null;
      if (q) {
        const r = await axios.get(`${BW_BASE}/comics/series/search?q=${encodeURIComponent(q)}&limit=5`, {
          headers: BW_HEADERS(),
          timeout: 5000
        }).catch(() => null);
        const target = cleanTitle(row.title);
        const match = bwList(r?.data, 'series', 'results').find(s => {
          const st = cleanTitle(s.title || s.name || '');
          return st === target || (target.length > 8 && (st.includes(target) || target.includes(st)));
        });
        if (match) {
          inLibrary = true;
          matchId = match.id || match._id || null;
        }
      }
      return {
        id: row.id,
        title: row.title || 'Comic',
        author: row.author || row.raw_data?.publisher || null,
        cover: row.cover_url || row.raw_data?.cover || row.raw_data?.cover_url || null,
        year: row.year || null,
        status: inLibrary ? 'available' : (row.status || 'pending'),
        in_library: inLibrary,
        bw_id: matchId,
        requested_at: row.created_at,
      };
    }));
    res.json({ requests: checked });
  } catch(e) {
    console.error('[comic request history]', e.message);
    res.json({ requests: [] });
  }
});

// Remove book from My Books (handles both my_books and shelfmark_downloads)
app.post('/api/my-books/remove', requireAuth, async (req, res) => {
  const { title, source_id } = req.body;
  const username = req.session.user.emby_username || req.session.user.discord_username;
  if (!title) return res.json({ error: 'Title required' });
  try {
    // Delete from my_books
    await db.from('my_books').delete().eq('saved_by', username)
      .or(`title.eq.${title},title.ilike.${title.slice(0,30)}%`);
    // Delete from library_requests
    await db.from('library_requests').delete().eq('requested_by', username)
      .or(`title.eq.${title},title.ilike.${title.slice(0,30)}%`);
    // Delete from shelfmark_downloads if source_id provided or title matches
    if (source_id) {
      await db.from('shelfmark_downloads').delete().eq('source_id', source_id);
    } else {
      await db.from('shelfmark_downloads').delete().eq('requested_by', username)
        .ilike('title', `%${title.slice(0,30)}%`);
    }
    res.json({ success: true });
  } catch(e) {
    console.error('[my-books remove]', e.message);
    res.json({ error: 'Failed to remove' });
  }
});

// Save book to user's My Books
app.post('/api/my-books/add', requireAuth, async (req, res) => {
  const { title, author, cover, year, description, type, source, source_id, format } = req.body;
  const username = req.session.user.emby_username || req.session.user.discord_username;
  if (!title) return res.json({ error: 'Title required' });
  try {
  const { language } = req.body;
    const { error } = await db.from('my_books').upsert({
      title, author: author || null, cover_url: cover || null,
      year: year || null, description: description || null,
      format: format || null, language: language || null,
      type: type || 'ebook', saved_by: username,
      book_source: source || null, book_source_id: source_id || null,
      saved_at: new Date().toISOString(),
    }, { onConflict: 'title,saved_by' });
    if (error) throw error;
    res.json({ success: true });
  } catch(e) {
    console.error('[my-books add]', e.message);
    res.json({ error: 'Failed to save' });
  }
});

// My Books — shows only manually saved books (my_books table)
// Shelfmark downloads are NOT shown here — only explicit "Add to My Books" saves
app.get('/api/my-requests', requireAuth, async (req, res) => {
  const username = req.session.user.emby_username || req.session.user.discord_username;
  try {
    const [myBooksResult, smResult] = await Promise.all([
      db.from('my_books').select('*').eq('saved_by', username).order('saved_at', { ascending: false }).limit(100),
      db.from('shelfmark_downloads').select('title, format, language, author, cover_url, description, year').eq('requested_by', username),
    ]);

    // Build a lookup from shelfmark_downloads by title for enrichment
    const smByTitle = new Map();
    for (const d of (smResult.data || [])) {
      if (d.title && !smByTitle.has(d.title.toLowerCase())) {
        smByTitle.set(d.title.toLowerCase(), d);
      }
    }

    const results = (myBooksResult.data || []).map(r => {
      const mbSource = r.book_source || 'mybooks';
      // Enrich with shelfmark_downloads data if format/language missing
      const sm = smByTitle.get((r.title || '').toLowerCase());
      return {
        id: `mb_${r.id}`,
        title: r.title || 'Unknown',
        author: r.author || sm?.author || null,
        cover: r.cover_url || sm?.cover_url || null,
        description: r.description || sm?.description || null,
        year: r.year || sm?.year || null,
        format: r.format || sm?.format || null,
        language: r.language || sm?.language || null,
        status: ['shelfmark', 'comicvine'].includes(mbSource) ? 'available' : 'saved',
        source: mbSource,
        source_id: r.book_source_id || null,
        lm_url: ['shelfmark', 'comicvine'].includes(mbSource) ? null : '${process.env.SHELFMARK_URL || ""}',
        created_at: r.saved_at || new Date().toISOString(),
        type: r.type || 'ebook',
      };
    });

    res.json({ requests: results });
  } catch(e) {
    console.error('[my-requests]', e.message);
    res.json({ requests: [] });
  }
});


// Batch check which titles are in BW library
app.post('/api/library/check-titles', requireAuth, async (req, res) => {
  const { titles, type } = req.body;
  if (!Array.isArray(titles) || !titles.length) return res.json({ found: [] });
  try {
    const found = [];
    const cleanTitle = t => (t || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    // Check all titles in parallel (cap at 20)
    const checks = titles.slice(0, 20).map(async title => {
      const q = title.split(' ').slice(0, 5).join(' ');
      let url;
      if (type === 'ebook') url = `${BW_BASE}/books/search?q=${encodeURIComponent(q)}&limit=5`;
      else if (type === 'audiobook') url = `${BW_BASE}/audiobooks/search?q=${encodeURIComponent(q)}&limit=5`;
      else url = `${BW_BASE}/comics/series/search?q=${encodeURIComponent(q)}&limit=5`;
      const r = await axios.get(url, { headers: BW_HEADERS(), timeout: 5000 }).catch(() => null);
      const results = r?.data?.series || r?.data?.results || r?.data?.comics || r?.data?.books || r?.data?.audiobooks || [];
      const tc = cleanTitle(title);
      const match = results.find(b => {
        const bc = cleanTitle(b.title || b.name || '');
        // Exact match, or one contains the other's significant words
        if (bc === tc) return true;
        if (bc.includes(tc.slice(0, 20)) || tc.includes(bc.slice(0, 20))) return true;
        // Word-based match — all significant words of the shorter title appear in longer
        const tcWords = tc.split(' ').filter(w => w.length > 3);
        const bcWords = bc.split(' ').filter(w => w.length > 3);
        const shorter = tcWords.length <= bcWords.length ? tcWords : bcWords;
        const longer = tcWords.length <= bcWords.length ? bc : tc;
        return shorter.length >= 2 && shorter.every(w => longer.includes(w));
      });
      if (match) found.push(title);
    });
    await Promise.all(checks);
    res.json({ found });
  } catch(e) {
    res.json({ found: [] });
  }
});

// Look up book in BW library to get direct LM URL
// ── Comic library browse endpoints ──────────────────────────────────────────

// Fetch CV cover for a series title via SM metadata API
app.get('/api/shelfmark/metadata-cover', requireAuth, async (req, res) => {
  const { title } = req.query;
  if (!title) return res.json({ cover: null });
  try {
    const r = await smGet(`/api/metadata/search?query=${encodeURIComponent(title)}&provider=comicvine&limit=1`);
    const book = r.data?.books?.[0];
    if (!book?.cover_url) return res.json({ cover: null });
    const coverUrl = book.cover_url.startsWith('/api/covers/')
      ? `/api/shelfmark/cover?path=${encodeURIComponent(book.cover_url)}`
      : book.cover_url;
    res.json({ cover: coverUrl });
  } catch(e) { res.json({ cover: null }); }
});

// List all series from BW library (paginated)
app.get('/api/library/comics/series', requireAuth, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 30;
  const q = req.query.q || '';
  try {
    const url = q
      ? `${BW_BASE}/comics/series/search?q=${encodeURIComponent(q)}&limit=${limit}&page=${page}`
      : `${BW_BASE}/comics/series?limit=${limit}&page=${page}`;
    const r = await axios.get(url, { headers: BW_HEADERS(), timeout: 10000 });
    const raw = bwList(r.data, 'series', 'results');
    const series = raw.map(normComic);
    const total = bwTotal(r.data, series.length);
    res.json({ series, total, page, limit, pages: Math.ceil(total / limit) });
  } catch(e) {
    console.error('[comic series]', e.message);
    res.json({ series: [], total: 0, page, limit, pages: 0 });
  }
});

// List all issues from BW library (paginated)
app.get('/api/library/comics/issues', requireAuth, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 30;
  const q = req.query.q || '';
  const seriesId = req.query.series || '';
  try {
    let raw = [];
    let total = 0;
    if (seriesId) {
      const url = `${BW_BASE}/comics/series/${seriesId}/items?limit=${limit}&page=${page}`;
      const r = await axios.get(url, { headers: BW_HEADERS(), timeout: 10000 });
      raw = bwList(r.data, 'items', 'results');
      total = bwTotal(r.data, raw.length);
    } else if (q) {
      const seriesRes = await axios.get(`${BW_BASE}/comics/series/search?q=${encodeURIComponent(q)}&limit=6&page=1`, {
        headers: BW_HEADERS(),
        timeout: 10000
      });
      const matches = bwList(seriesRes.data, 'series', 'results').slice(0, 6);
      const itemResults = await Promise.all(matches.map(s => {
        const id = s.id || s._id;
        return id
          ? axios.get(`${BW_BASE}/comics/series/${id}/items?limit=12&page=1`, { headers: BW_HEADERS(), timeout: 10000 }).catch(() => null)
          : Promise.resolve(null);
      }));
      const seen = new Set();
      raw = itemResults.flatMap(r => bwList(r?.data, 'items', 'results')).filter(item => {
        const id = item.id || item._id || item.item_id || comicItemTitle(item);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      total = raw.length;
      raw = raw.slice((page - 1) * limit, page * limit);
    } else {
      const url = `${BW_BASE}/comics/items?limit=${limit}&page=${page}`;
      const r = await axios.get(url, { headers: BW_HEADERS(), timeout: 10000 });
      raw = bwList(r.data, 'items', 'results');
      total = bwTotal(r.data, raw.length);
    }
    const issues = raw.map(normComicIssue);
    res.json({ issues, total, page, limit, pages: Math.ceil(total / limit) });
  } catch(e) {
    console.error('[comic issues]', e.message);
    res.json({ issues: [], total: 0, page, limit, pages: 0 });
  }
});

app.get('/api/library/book-url', requireAuth, async (req, res) => {
  const { title, type = 'ebook', id: knownId } = req.query;
  if (!title) return res.json({ url: null });
  try {
    // If we already know the BW ID, skip search and build URL directly
    if (knownId) {
      const lmBase = process.env.SHELFMARK_URL || '';
      let url;
      if (type === 'audiobook') url = `${lmBase}/audiobooks/${knownId}`;
      else if (type === 'comic') url = null;
      else url = `${lmBase}/ebooks/${knownId}/read`;
      console.log(`[book-url] using known id=${knownId}, url=${url}`);
      return res.json({ url, id: knownId, title });
    }
    if (type === 'comic') {
      return res.json({ url: null, title });
    }
    // For audiobooks, strip suffixes and normalise punctuation that breaks BW search
    const searchTitle = type === 'audiobook'
      ? title
          .replace(/,?\s*(Book\s*\d+|Vol\.?\s*\d+|Part\s*\d+|#\d+)$/i, '')
          .replace(/:\s*.+$/, '')
          .replace(/-/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      : title;
    let searchUrl;
    if (type === 'ebook') searchUrl = `${BW_BASE}/books/search?q=${encodeURIComponent(searchTitle)}&limit=3`;
    else if (type === 'audiobook') searchUrl = `${BW_BASE}/audiobooks/search?q=${encodeURIComponent(searchTitle)}&limit=3`;
    else if (type === 'comic') searchUrl = `${BW_BASE}/comics/series/search?q=${encodeURIComponent(searchTitle)}&limit=3`;
    else return res.json({ url: null });
    const r = await axios.get(searchUrl, { headers: BW_HEADERS(), timeout: 8000 });
    const results = r.data?.series || r.data?.results || r.data?.comics || r.data?.books || r.data?.audiobooks || r.data?.items || [];
    const qt = title.toLowerCase().trim();
    // Score each result: exact match = 3, starts-with = 2, contains = 1, else 0
    const scored = results.map(b => {
      const bt = (b.title || b.name || '').toLowerCase().trim();
      let score = 0;
      if (bt === qt) score = 3;
      else if (bt.startsWith(qt) || qt.startsWith(bt)) score = 2;
      else if (bt.includes(qt) || qt.includes(bt)) score = 1;
      return { b, score };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
    const match = scored.length ? scored[0].b : null;
    if (!match) return res.json({ url: type === 'audiobook' ? `${process.env.SHELFMARK_URL || ""}/audiobooks?q=${encodeURIComponent(title)}` : `${process.env.SHELFMARK_URL || ""}/search?query=${encodeURIComponent(title)}` });
    // Try all possible ID fields BW might use
    const id = match.uuid || match.id || match._id || match.calibre_id || match.book_id;
    const lmBase = process.env.SHELFMARK_URL || '';
    let url;
    if (id) {
      if (type === 'audiobook') {
        url = `${lmBase}/audiobooks/${id}`;
      } else if (type === 'comic') {
        url = `${lmBase}/comics?series=${id}`;
      } else {
        url = `${lmBase}/ebooks/${id}/read`;
      }
    } else {
      if (type === 'audiobook') url = `${lmBase}/audiobooks?q=${encodeURIComponent(title)}`;
      else if (type === 'comic') url = `${lmBase}/comics?q=${encodeURIComponent(title)}`;
      else url = `${lmBase}/search?query=${encodeURIComponent(title)}`;
    }
    console.log(`[book-url] "${title}" (${type}) -> id=${id}, url=${url}, fields=${Object.keys(match).join(',')}, sample=${JSON.stringify(match).slice(0,300)}`);
    res.json({ url, id, title: match.title || match.name });
  } catch(e) {
    console.error('[book-url]', e.response?.status, e.message, 'knownId:', knownId, 'title:', title, 'type:', type);
    res.json({ url: type === 'audiobook' 
      ? `${process.env.SHELFMARK_URL || ""}/audiobooks?q=${encodeURIComponent(title)}`
      : `${process.env.SHELFMARK_URL || ""}/search?query=${encodeURIComponent(title)}` });
  }
});

// Trending books — NYT bestsellers for ebooks, Google Books for audiobooks/comics
app.get('/api/library/trending', requireAuth, async (req, res) => {
  const { type = 'ebook', genre } = req.query;
  const cleanYear = (val) => {
    if (!val) return null;
    const s = String(val);
    const m = s.match(/\b(1[0-9]{3}|2[0-9]{3})\b/);
    return m ? m[1] : null;
  };
  try {
    let items = [];
    if (type === 'ebook') {
      // If genre looks like a Google Books query (has spaces), use GB; otherwise use NYT list
      const isGBQuery = genre && genre.includes(' ');
      if (genre && isGBQuery) {
        const gbRes = await axios.get('https://www.googleapis.com/books/v1/volumes', {
          params: { q: genre, key: process.env.GOOGLE_BOOKS_API_KEY, maxResults: 20, langRestrict: 'en', orderBy: 'relevance' },
          timeout: 8000
        });
        items = (gbRes.data?.items || []).map(item => {
          const info = item.volumeInfo || {};
          return {
            title: info.title || '—',
            author: (info.authors || []).join(', ') || null,
            cover: info.imageLinks?.thumbnail?.replace('http://', 'https://') || null,
            description: info.description ? info.description.slice(0, 300) : null,
            year: cleanYear(info.publishedDate),
            format: 'EPUB',
            status: 'available',
            source: 'bookwarehouse',
            lm_url: process.env.SHELFMARK_URL || '',
            type,
          };
        });
      } else {
        const lists = genre
          ? [genre]
          : ['combined-print-and-e-book-fiction', 'combined-print-and-e-book-nonfiction'];
        const results = await Promise.all(lists.map(list =>
          axios.get(`https://api.nytimes.com/svc/books/v3/lists/current/${list}.json`, {
            params: { 'api-key': process.env.NYT_BOOKS_API_KEY },
            timeout: 8000
          }).catch(() => null)
        ));
        for (const r of results) {
          if (!r?.data?.results?.books) continue;
          for (const b of r.data.results.books) {
            items.push({
              title: b.title,
              author: b.author,
              cover: b.book_image || null,
              description: b.description || null,
              year: null,
              format: 'EPUB',
              language: 'en',
              status: 'available',
              source: 'bookwarehouse',
              lm_url: process.env.SHELFMARK_URL || '',
              type,
              rank: b.rank,
            });
          }
        }
        items = items
          .sort((a, b) => (a.rank || 99) - (b.rank || 99))
          .filter((item, idx, arr) => arr.findIndex(x => x.title === item.title) === idx)
          .slice(0, 20);
        // If NYT list returned nothing, fallback to Google Books
        if (!items.length && genre) {
          const gbFallback = await axios.get('https://www.googleapis.com/books/v1/volumes', {
            params: { q: genre + ' fiction bestseller', key: process.env.GOOGLE_BOOKS_API_KEY, maxResults: 20, langRestrict: 'en' },
            timeout: 8000
          }).catch(() => null);
          items = (gbFallback?.data?.items || []).map(item => {
            const info = item.volumeInfo || {};
            return { title: info.title || '—', author: (info.authors||[]).join(', ')||null, cover: info.imageLinks?.thumbnail?.replace('http://','https://')||null, description: info.description?.slice(0,300)||null, year: cleanYear(info.publishedDate), format: 'EPUB', language: (info.language||'en').toLowerCase(), status: 'available', source: 'bookwarehouse', lm_url: process.env.SHELFMARK_URL || '', type };
          });
        }
      }
    } else if (type === 'audiobook') {
      // Use BW audiobook library search — has full metadata including narrator, duration, cover
      // Use the genre value directly as BW search query (already mapped by frontend GENRES)
      const q = genre || '';
      // Fetch from BW audiobooks — returns rich metadata
      const bwAudioUrl = q
        ? `${BW_BASE}/audiobooks/search?q=${encodeURIComponent(q)}&limit=20`
        : `${BW_BASE}/audiobooks/search?q=bestseller&limit=20`;
      const bwRes = await axios.get(bwAudioUrl, { headers: BW_HEADERS(), timeout: 10000 }).catch(() => null);
      const rawAudio = bwRes?.data?.audiobooks || bwRes?.data?.results || bwRes?.data || [];
      items = (Array.isArray(rawAudio) ? rawAudio : []).slice(0, 20).map(b => {
        const norm = normAudiobook(b);
        return {
          ...norm,
          status: 'available',
          source: 'bookwarehouse',
          lm_url: process.env.SHELFMARK_URL || '',
          type,
        };
      });
    } else if (type === 'comic') {
      try {
        const queries = genre
          ? (COMIC_GENRE_QUERIES[genre.toLowerCase()] || [genre])
          : COMIC_TRENDING_QUERIES;

        const seen = new Set();

        if (!genre) {
          // Trending: serve from pre-built cache (multiple issues per popular title)
          for (const entry of _comicCache.values()) {
            if (seen.has(entry.source_id)) continue;
            seen.add(entry.source_id);
            items.push({ ...entry, status: 'available', source: 'comicvine', lm_url: null, type: 'comic' });
          }
        } else {
          // Genre pill: fetch ALL issues for ALL genre queries in parallel, deduplicate
          const batches = await Promise.all(
            queries.map(q => smReleasesForQuery(q, 20).catch(() => ({ releases: [], cvCover: null })))
          );
          for (let i = 0; i < queries.length; i++) {
            const { releases, cvCover } = batches[i];
            for (const rel of releases) {
              if (!rel.source_id || seen.has(rel.source_id)) continue;
              const tk = (rel.title||'').toLowerCase().replace(/[^a-z0-9]/g,'');
              if (seen.has(tk)) continue;
              seen.add(rel.source_id);
              seen.add(tk);
              const entry = smRelToItem(rel, cvCover);
              items.push({ ...entry, status: 'available', source: 'comicvine', lm_url: null, type: 'comic' });
            }
          }
        }

        // Fallback if cache not ready
        if (!items.length) {
          const { releases, cvCover } = await smReleasesForQuery('batman', 5).catch(() => ({ releases: [], cvCover: null }));
          for (const rel of releases) {
            items.push({ ...smRelToItem(rel, cvCover), status: 'available', source: 'comicvine', lm_url: null, type: 'comic' });
          }
        }
      } catch(e) {
        console.error('[comic trending]', e.message);
        items = [];
      }
    }
    res.json({ items });
  } catch(e) {
    console.error('[trending]', e.message);
    res.json({ items: [] });
  }
});



let SM_URL = process.env.SHELFMARK_URL || 'http://localhost:8084';
let SM_USER = process.env.SHELFMARK_USER || '';
let SM_PASS = process.env.SHELFMARK_PASS || '';
let BOOKS_DIR = process.env.BOOKS_DIR || '/opt/shelfmark/books';
let HC_API_KEY = process.env.HARDCOVER_API_KEY || '';
let CV_API_KEY = process.env.COMICVINE_API_KEY || '';
let KAVITA_URL = process.env.KAVITA_URL || '';
let KAVITA_API_KEY = process.env.KAVITA_API_KEY || '';
let KAVITA_OPDS_URL = process.env.KAVITA_OPDS_URL || '';
const CV_BASE = 'https://comicvine.gamespot.com/api';
const CV_HEADERS = { 'User-Agent': 'Portal v1/1.0 (portal.example.invalid)' };

function kavitaOpdsUrl() {
  const direct = String(KAVITA_OPDS_URL || process.env.KAVITA_OPDS_URL || '').trim();
  if (direct) return direct.replace(/\/$/, '');
  const base = String(KAVITA_URL || process.env.KAVITA_URL || '').trim().replace(/\/$/, '');
  const key = String(KAVITA_API_KEY || process.env.KAVITA_API_KEY || '').trim();
  return base && key ? `${base}/api/opds/${encodeURIComponent(key)}` : '';
}

function kavitaConfigured() {
  return Boolean(kavitaOpdsUrl());
}

// ComicVine search helper
async function cvSearch(query, limit = 10) {
  const r = await axios.get(`${CV_BASE}/volumes/`, {
    headers: CV_HEADERS,
    params: {
      api_key: CV_API_KEY,
      format: 'json',
      filter: `name:${query}`,
      field_list: 'id,name,image,publisher,count_of_issues,description,start_year,site_detail_url',
      limit,
      sort: 'count_of_issues:desc',
    },
    timeout: 8000,
  });
  return r.data?.results || [];
}

// ComicVine trending — popular series by issue count
// BW-native comic trending — fetches directly from the library so titles/IDs/covers are real.
// Genre pills map to parallel BW searches; trending uses a broad multi-query fetch.
// ComicVine trending — rich metadata, good covers, genre support
async function cvTrending(genre, limit = 20) {
  const genreFilterMap = {
    superhero: 'batman|spider-man|superman|x-men|avengers',
    manga: 'one piece|naruto|dragon ball|attack on titan|demon slayer',
    'graphic novel': 'saga|sandman|watchmen|maus|walking dead',
    fantasy: 'elfquest|bone|fables|east of west|monstress',
    horror: 'locke and key|wytches|swamp thing|hellblazer|something is killing',
  };
  const queries = genre
    ? (genreFilterMap[genre.toLowerCase()] || genre).split('|')
    : ['batman', 'spider-man', 'x-men', 'saga', 'invincible', 'walking dead', 'one piece', 'sandman'];
  const results = await Promise.all(queries.slice(0, 6).map(q => cvSearch(q, 4).catch(() => [])));
  const seen = new Set();
  const items = [];
  for (const batch of results) {
    for (const v of batch) {
      if (!v.name || seen.has(v.name.toLowerCase())) continue;
      seen.add(v.name.toLowerCase());
      items.push({
        title: v.name,
        author: v.publisher?.name || null,
        cover: v.image?.medium_url || v.image?.small_url || null,
        description: v.description ? v.description.replace(/<[^>]+>/g, '').slice(0, 400) : null,
        year: v.start_year ? String(v.start_year) : null,
        format: 'CBZ',
        status: 'available',
        source: 'comicvine',
        lm_url: null,
        type: 'comic',
        cv_id: String(v.id),
        issue_count: v.count_of_issues,
      });
      if (items.length >= limit) break;
    }
    if (items.length >= limit) break;
  }
  return items;
}
const BOOKS_MAX_GB = 15;           // Hard server cap
const BOOKS_MAX_AGE_DAYS = 14;     // Inactivity delete after 14 days
const BOOKS_DAILY_CAP = 5;         // Max downloads per user per day
const BOOKS_UNLIMITED_USER = 'blur'; // This user has no cap
const BOOKS_FINISH_THRESHOLD = 0.95; // 95%+ = finished

// Session cookie cache
let _smCookie = null;
let _smCookieTs = 0;

async function smLogin(force = false) {
  const now = Date.now();
  if (!force && _smCookie && now - _smCookieTs < 30 * 60 * 1000) return _smCookie;
  const res = await axios.post(`${SM_URL}/api/auth/login`,
    { username: SM_USER, password: SM_PASS },
    { headers: { 'Content-Type': 'application/json' }, timeout: 8000 }
  );
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) throw new Error('Shelfmark login failed — no cookie');
  _smCookie = setCookie.map(c => c.split(';')[0]).join('; ');
  _smCookieTs = now;
  console.log('[shelfmark] Session refreshed');
  return _smCookie;
}

async function smGet(path) {
  const cookie = await smLogin();
  try {
    return await axios.get(`${SM_URL}${path}`, {
      headers: { Cookie: cookie },
      timeout: 15000
    });
  } catch(e) {
    // If 401/403, force re-login and retry once
    if (e.response?.status === 401 || e.response?.status === 403) {
      const freshCookie = await smLogin(true);
      return axios.get(`${SM_URL}${path}`, {
        headers: { Cookie: freshCookie },
        timeout: 15000
      });
    }
    throw e;
  }
}

// Search Shelfmark — proxies direct search, one card per release, enriched with Hardcover or ComicVine metadata
app.get('/api/shelfmark/search', requireAuth, async (req, res) => {
  const { q, type } = req.query;
  if (!q) return res.json({ error: 'Query required' });
  const isComic = type === 'comic';
  try {
    // 1. Get releases from Shelfmark direct search
    const params = new URLSearchParams({ source: 'direct_download', query: q, sort: 'relevance' });
    if (isComic) {
      ['cbz','cbr'].forEach(f => params.append('format', f));
    } else {
      ['epub','mobi','azw3','fb2','djvu','cbz','cbr'].forEach(f => params.append('format', f));
    }
    const r = await smGet(`/api/releases?${params.toString()}`);
    const releases = r.data?.releases || [];

    // 2. Fetch Hardcover metadata for enrichment (cover, description)
    let hcBooks = [];
    try {
      const hcRes = await axios.post('https://api.hardcover.app/v1/graphql', {
        query: `query SearchBooks($q: String!) { search(query: $q, query_type: "Book", per_page: 10) { results } }`,
        variables: { q }
      }, {
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${HC_API_KEY}` },
        timeout: 6000
      });
      hcBooks = hcRes.data?.data?.search?.results?.hits || [];
    } catch(e) { /* enrichment optional */ }

    // Build Hardcover lookup by normalised title — store array for fuzzy matching
    const hcEntries = [];
    for (const hit of hcBooks) {
      const b = hit.document || {};
      const t = (b.title || '').toLowerCase().trim();
      if (!t) continue;
      const ed = b.featured_edition || b.editions?.[0] || {};
      hcEntries.push({
        title: t,
        cover: (b.image?.url || ed.image?.url || '').replace('http://', 'https://') || null,
        description: b.description ? b.description.slice(0, 400) : null,
        rating: b.rating ? `${parseFloat(b.rating).toFixed(1)}/5` : null,
      });
    }
    // Fuzzy HC lookup: exact first, then startsWith, then includes
    function findHC(title) {
      const t = title.toLowerCase().trim();
      return hcEntries.find(e => e.title === t)
        || hcEntries.find(e => t.startsWith(e.title) || e.title.startsWith(t))
        || hcEntries.find(e => t.includes(e.title) || e.title.includes(t))
        || {};
    }

    // 3. Filter to English only, deduplicate by title
    const seenTitles = new Set();
    const seenCovers = new Set();
    const filteredReleases = releases.filter(rel => {
      const lang = (rel.language || rel.extra?.language || 'en').toLowerCase();
      if (lang && lang !== 'en') return false;
      const title = (rel.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();
      const fmt = (rel.format || '').toLowerCase();
      const coverPath = rel.extra?.preview || null;
      if (seenTitles.has(title)) return false;
      seenTitles.add(title);
      if (coverPath && seenCovers.has(coverPath)) return false;
      if (coverPath) seenCovers.add(coverPath);
      return true;
    });

    // 4. For comics: multi-source title discovery (GB + HC + OL + SM) + CV enrichment.
    //    SM releases are the download source of truth. Title discovery from all sources
    //    expands what we can find, then CV enriches with covers + descriptions.
    //    For books: enrich SM releases with Hardcover metadata.
    let books;
    if (isComic) {
      // Live SM search + CV enrichment via liveComicSearch
      const results = await liveComicSearch(q);
      books = results.map(entry => ({
        title: entry.title,
        author: entry.author,
        year: entry.year,
        publisher: entry.author,
        description: entry.description,
        cover: entry.cover,
        format: entry.format || 'cbz',
        size: entry.size || null,
        language: 'en',
        provider: 'direct_download',
        provider_id: entry.source_id,
        source: 'direct_download',
        source_id: entry.source_id,
        isbn13: null,
        isbn10: null,
      }));
    } else {
      books = filteredReleases.map(rel => {
        const title = rel.title || '';
        const smCoverPath = rel.extra?.preview || null;
        const smCover = smCoverPath ? `/api/shelfmark/cover?path=${encodeURIComponent(smCoverPath)}` : null;
        const hc = findHC(title);
        return {
          title,
          author: rel.extra?.author || '',
          year: rel.extra?.year || null,
          publisher: rel.extra?.publisher || null,
          description: hc.description || null,
          cover: hc.cover || smCover,
          format: rel.format || null,
          size: rel.size || null,
          language: rel.language || rel.extra?.language || 'en',
          provider: 'direct_download',
          provider_id: rel.source_id,
          source: rel.source,
          source_id: rel.source_id,
          isbn13: null,
          isbn10: null,
        };
      });
    }

    res.json({ books });
  } catch(e) {
    console.error('[shelfmark search direct]', e.message);
    res.json({ books: [] });
  }
});

// Fetch book/comic description from Shelfmark metadata search
app.get('/api/shelfmark/detail/:source_id', requireAuth, async (req, res) => {
  const { title } = req.query;
  if (!title) return res.json({ description: null });
  try {
    const titleLower = title.toLowerCase().trim();
    // Try with hardcover first (books), then without provider (comics/fallback)
    const attempts = [
      smGet(`/api/metadata/search?query=${encodeURIComponent(title)}&provider=hardcover`).catch(() => null),
      smGet(`/api/metadata/search?query=${encodeURIComponent(title)}`).catch(() => null),
    ];
    const results = await Promise.all(attempts);
    let description = null;
    for (const r of results) {
      const books = r?.data?.books || [];
      const match = books.find(b => (b.title||'').toLowerCase().trim() === titleLower)
        || books.find(b => titleLower.includes((b.title||'').toLowerCase().trim().slice(0,15)))
        || books.find(b => (b.title||'').toLowerCase().includes(titleLower.slice(0,15)))
        || books[0];
      if (match?.description) { description = match.description; break; }
    }
    res.json({ description });
  } catch(e) {
    res.json({ description: null });
  }
});

// ComicVine search endpoint for comic metadata
app.get('/api/comicvine/search', requireAuth, async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ results: [] });
  try {
    const volumes = await cvSearch(q, 20);
    const results = volumes.map(v => ({
      id: String(v.id),
      title: v.name,
      author: v.publisher?.name || null,
      cover: v.image?.medium_url || v.image?.small_url || null,
      description: v.description ? v.description.replace(/<[^>]+>/g, '').slice(0, 400) : null,
      year: v.start_year ? String(v.start_year) : null,
      issue_count: v.count_of_issues,
      format: 'CBZ',
      // CV results are displayed as portal items — download via Shelfmark search at click time
      status: 'available',
      source: 'comicvine',
      lm_url: process.env.SHELFMARK_URL || '',
      type: 'comic',
      cv_id: String(v.id),
    }));
    res.json({ results });
  } catch(e) {
    console.error('[comicvine search]', e.message);
    res.json({ results: [] });
  }
});

app.get('/api/library/comics/request-search', requireAuth, async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ results: [] });
  const clean = t => (t || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  try {
    const volumes = await cvSearch(q, 20);
    const results = await Promise.all(volumes.map(async v => {
      const title = v.name || '';
      let inLibrary = false;
      let bwId = null;
      const bw = await axios.get(`${BW_BASE}/comics/series/search?q=${encodeURIComponent(title)}&limit=5`, {
        headers: BW_HEADERS(),
        timeout: 5000
      }).catch(() => null);
      const target = clean(title);
      const match = bwList(bw?.data, 'series', 'results').find(s => {
        const st = clean(s.title || s.name || '');
        return st === target || (target.length > 8 && (st.includes(target) || target.includes(st)));
      });
      if (match) {
        inLibrary = true;
        bwId = match.id || match._id || null;
      }
      return {
        id: String(v.id),
        title,
        author: v.publisher?.name || null,
        cover: v.image?.medium_url || v.image?.small_url || null,
        description: v.description ? v.description.replace(/<[^>]+>/g, '').slice(0, 400) : null,
        year: v.start_year ? String(v.start_year) : null,
        issue_count: v.count_of_issues,
        in_library: inLibrary,
        bw_id: bwId,
      };
    }));
    res.json({ results });
  } catch(e) {
    console.error('[comic request search]', e.message);
    res.json({ results: [] });
  }
});

app.get('/api/library/ebooks/request-search', requireAuth, async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ results: [] });
  const fold = t => String(t || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[-_'.’]/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const clean = fold;
  const queryWords = fold(q).split(' ').filter(w => w.length > 1);
  const meaningfulWords = queryWords.filter(w => w.length > 2);
  const wordsMatch = value => {
    const text = fold(value);
    return queryWords.length ? queryWords.every(w => text.includes(w)) : true;
  };
  const titleMatchesQuery = title => {
    const t = fold(title);
    return meaningfulWords.length ? meaningfulWords.every(w => t.includes(w)) : wordsMatch(title);
  };
  const authorMatchesQuery = author => wordsMatch(author);
  const matchesQuery = item => titleMatchesQuery(item.title || '') || authorMatchesQuery(extractAuthors(item.authors) || item.author || item.author_name || '');
  try {
    const [bwSearchRes, bwAuthorRes, hcRes] = await Promise.all([
      axios.get(`${BW_BASE}/books/search?q=${encodeURIComponent(q)}&limit=12`, {
        headers: BW_HEADERS(),
        timeout: 6000
      }).catch(() => null),
      axios.get(`${BW_BASE}/books?author=${encodeURIComponent(q)}&limit=40`, {
        headers: BW_HEADERS(),
        timeout: 6000
      }).catch(() => null),
      axios.post('https://api.hardcover.app/v1/graphql', {
        query: `query SearchBooks($q: String!) { search(query: $q, query_type: "Book", per_page: 30) { results } }`,
        variables: { q }
      }, {
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${HC_API_KEY}` },
        timeout: 8000
      }).catch(() => null)
    ]);
    const bwSeen = new Set();
    const bwRaw = [
      ...bwList(bwSearchRes?.data, 'books', 'results', 'items'),
      ...bwList(bwAuthorRes?.data, 'books', 'results', 'items')
    ]
      .filter(b => matchesQuery(b))
      .filter(b => {
        const id = b.id || b._id || b.calibre_id || b.book_id || `${b.title}|${extractAuthors(b.authors) || b.author || ''}`;
        if (bwSeen.has(id)) return false;
        bwSeen.add(id);
        return true;
      })
      .map(b => {
        const n = normBook(b);
        return {
          id: `bw_${n.id || n.title}`,
          title: n.title,
          author: n.author || null,
          cover: n.cover || null,
          description: n.description || null,
          year: n.year ? String(n.year).slice(0, 4) : null,
          genres: n.genres || [],
          isbn: n.isbn || null,
          in_library: true,
          bw_id: n.id || null,
          source: 'bookwarehouse',
        };
      });
    const hits = hcRes?.data?.data?.search?.results?.hits || [];
    const results = await Promise.all(hits.map(async hit => {
      const b = hit.document || {};
      const ed = b.featured_edition || b.editions?.[0] || {};
      const title = b.title || ed.title || '';
      const author = Array.isArray(b.author_names) ? b.author_names.join(', ') : (b.author_name || b.author || null);
      if (!titleMatchesQuery(title) && !authorMatchesQuery(author)) return null;
      const yearRaw = b.release_year || ed.release_year || ed.year || b.first_published_year || null;
      const genres = (b.genres || b.cached_tags || []).map(g => g.name || g).filter(Boolean).slice(0, 4);
      let inLibrary = false;
      let bwId = null;
      const bw = await axios.get(`${BW_BASE}/books/search?q=${encodeURIComponent(title)}&limit=5`, {
        headers: BW_HEADERS(),
        timeout: 5000
      }).catch(() => null);
      const target = clean(title);
      const match = bwList(bw?.data, 'books', 'results').find(book => {
        const bt = clean(book.title || '');
        const ba = clean(extractAuthors(book.authors) || book.author || '');
        const aa = clean(author || '');
        return bt === target || (target.length > 8 && (bt.includes(target) || target.includes(bt))) ||
          (bt && bt === target && (!aa || !ba || aa.includes(ba) || ba.includes(aa)));
      });
      if (match) {
        inLibrary = true;
        bwId = match.id || match._id || match.calibre_id || match.book_id || null;
      }
      return {
        id: String(b.id || ed.id || title),
        title,
        author,
        cover: (b.image?.url || ed.image?.url || '').replace('http://', 'https://') || null,
        description: b.description ? String(b.description).replace(/<[^>]+>/g, '').slice(0, 500) : null,
        year: yearRaw ? String(yearRaw).slice(0, 4) : null,
        genres,
        isbn: ed.isbn_13 || ed.isbn_10 || null,
        in_library: inLibrary,
        bw_id: bwId,
      };
    }));
    const seen = new Set();
    const merged = [...bwRaw, ...results.filter(r => r?.title)].filter(item => {
      const key = `${clean(item.title)}|${clean(item.author)}|${item.year || ''}`;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    res.json({ results: merged.slice(0, 24) });
  } catch(e) {
    console.error('[ebook request search]', e.message);
    res.json({ results: [] });
  }
});

app.get('/api/library/ebooks/request-history', requireAuth, async (req, res) => {
  const username = req.session.user.emby_username || req.session.user.discord_username;
  const cleanTitle = t => (t || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  try {
    const { data, error } = await db
      .from('library_requests')
      .select('id,title,author,cover_url,year,status,created_at,raw_data')
      .eq('requested_by', username)
      .eq('type', 'ebook')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    const rows = data || [];
    const checked = await Promise.all(rows.map(async row => {
      let inLibrary = row.status === 'complete' || row.status === 'available';
      let matchId = null;
      const bw = await axios.get(`${BW_BASE}/books/search?q=${encodeURIComponent(row.title || '')}&limit=5`, {
        headers: BW_HEADERS(),
        timeout: 5000
      }).catch(() => null);
      const target = cleanTitle(row.title);
      const match = bwList(bw?.data, 'books', 'results').find(book => {
        const bt = cleanTitle(book.title || '');
        return bt === target || (target.length > 8 && (bt.includes(target) || target.includes(bt)));
      });
      if (match) {
        inLibrary = true;
        matchId = match.id || match._id || match.calibre_id || match.book_id || null;
      }
      return {
        id: row.id,
        title: row.title || 'Book',
        author: row.author || row.raw_data?.author || null,
        cover: row.cover_url || row.raw_data?.cover || row.raw_data?.cover_url || null,
        year: row.year || null,
        status: inLibrary ? 'available' : (row.status || 'pending'),
        in_library: inLibrary,
        bw_id: matchId,
        requested_at: row.created_at,
      };
    }));
    res.json({ requests: checked });
  } catch(e) {
    console.error('[ebook request history]', e.message);
    res.json({ requests: [] });
  }
});

app.get('/api/library/audiobooks/request-search', requireAuth, async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ results: [] });
  const fold = t => String(t || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[-_'.’]/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const words = fold(q).split(' ').filter(w => w.length > 1);
  const matches = item => {
    const title = fold(item.title || item.name || '');
    const author = fold(item.author || extractAuthors(item.authors) || '');
    return words.length ? words.every(w => title.includes(w) || author.includes(w)) : true;
  };
  const scoreCandidate = (target, candidate) => {
    const targetTitle = fold(target.title || target.name || '');
    const targetAuthor = fold(target.author || extractAuthors(target.authors) || '');
    const candTitle = fold(candidate.title || candidate.name || '');
    const candAuthor = fold(candidate.author || extractAuthors(candidate.authors) || '');
    let score = 0;
    if (candTitle === targetTitle) score += 80;
    else if (candTitle.includes(targetTitle) || targetTitle.includes(candTitle)) score += 45;
    const titleWords = targetTitle.split(' ').filter(w => w.length > 2);
    score += titleWords.filter(w => candTitle.includes(w)).length * 8;
    if (targetAuthor && candAuthor) {
      if (candAuthor === targetAuthor) score += 35;
      else if (candAuthor.includes(targetAuthor) || targetAuthor.includes(candAuthor)) score += 20;
      const authorWords = targetAuthor.split(' ').filter(w => w.length > 2);
      score += authorWords.filter(w => candAuthor.includes(w) || candTitle.includes(w)).length * 5;
    }
    return score;
  };
  try {
    const [bwRes, audibleRes] = await Promise.all([
      axios.get(`${BW_BASE}/audiobooks/search?q=${encodeURIComponent(q)}&limit=20`, { headers: BW_HEADERS(), timeout: 8000 }).catch(() => null),
      axios.get(`${BW_BASE}/audiobooks/search/external?q=${encodeURIComponent(q)}`, { headers: BW_HEADERS(), timeout: 10000 }).catch(() => null),
    ]);
    const bwRaw = bwList(bwRes?.data, 'audiobooks', 'results', 'items')
      .filter(matches)
      .map(b => ({ ...normAudiobook(b), in_library: true, source: 'bookwarehouse', bw_id: b.id || b._id || null }));
    let audibleRaw = bwList(audibleRes?.data, 'results', 'audiobooks', 'items').filter(matches).slice(0, 12);
    if (!audibleRaw.length) {
      const bayFallback = await axios.get(`${BW_BASE}/audiobooks/abiplayer/search?q=${encodeURIComponent(q)}`, {
        headers: BW_HEADERS(),
        timeout: 10000
      }).catch(() => null);
      audibleRaw = bwList(bayFallback?.data, 'results', 'audiobooks', 'items').filter(matches).slice(0, 12);
    }
    const extRaw = await Promise.all(audibleRaw.map(async audible => {
      const audibleNorm = normAudiobook(audible);
      const bayQuery = [audibleNorm.title, audibleNorm.author].filter(Boolean).join(' ');
      const bayRes = await axios.get(`${BW_BASE}/audiobooks/abiplayer/search?q=${encodeURIComponent(bayQuery || audibleNorm.title || q)}`, {
        headers: BW_HEADERS(),
        timeout: 9000
      }).catch(() => null);
      const candidates = bwList(bayRes?.data, 'results', 'audiobooks', 'items');
      const scored = candidates
        .map(c => ({ c, score: scoreCandidate(audibleNorm, c) }))
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score);
      const best = scored[0]?.c || null;
      const bestNorm = best ? normAudiobook(best) : null;
      return {
        ...audibleNorm,
        in_library: false,
        source: 'audible',
        request_title: bestNorm?.title || audibleNorm.title,
        request_author: bestNorm?.author || audibleNorm.author || null,
        bay_title: bestNorm?.title || null,
        bay_author: bestNorm?.author || null,
        bay_format: bestNorm?.format || null,
        bay_match_score: scored[0]?.score || 0,
        has_download_match: !!best,
      };
    }));
    const seen = new Set();
    const results = [...bwRaw, ...extRaw].filter(item => {
      const key = `${fold(item.title)}|${fold(item.author)}`;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 24);
    res.json({ results });
  } catch(e) {
    console.error('[audiobook request search]', e.message);
    res.json({ results: [] });
  }
});

app.get('/api/library/audiobooks/request-history', requireAuth, async (req, res) => {
  const username = req.session.user.emby_username || req.session.user.discord_username;
  const cleanTitle = t => (t || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  try {
    const { data, error } = await db
      .from('library_requests')
      .select('id,title,author,cover_url,year,status,created_at,raw_data')
      .eq('requested_by', username)
      .eq('type', 'audiobook')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    const checked = await Promise.all((data || []).map(async row => {
      let inLibrary = row.status === 'complete' || row.status === 'available';
      let matchId = null;
      const bw = await axios.get(`${BW_BASE}/audiobooks/search?q=${encodeURIComponent(row.title || '')}&limit=5`, {
        headers: BW_HEADERS(),
        timeout: 5000
      }).catch(() => null);
      const target = cleanTitle(row.title);
      const match = bwList(bw?.data, 'audiobooks', 'results').find(book => {
        const bt = cleanTitle(book.title || book.name || '');
        return bt === target || (target.length > 8 && (bt.includes(target) || target.includes(bt)));
      });
      if (match) {
        inLibrary = true;
        matchId = match.id || match._id || null;
      }
      return {
        id: row.id,
        title: row.title || 'Audiobook',
        author: row.author || row.raw_data?.author || null,
        cover: row.cover_url || row.raw_data?.cover || row.raw_data?.cover_url || null,
        year: row.year || null,
        status: inLibrary ? 'available' : (row.status || 'pending'),
        in_library: inLibrary,
        bw_id: matchId,
        requested_at: row.created_at,
      };
    }));
    res.json({ requests: checked });
  } catch(e) {
    console.error('[audiobook request history]', e.message);
    res.json({ requests: [] });
  }
});

// Proxy Shelfmark cover images so browser doesn't need to reach localhost:8084
app.get('/api/shelfmark/cover', requireAuth, async (req, res) => {
  const { path: coverPath } = req.query;
  if (!coverPath) return res.status(400).end();
  try {
    const cookie = await smLogin();
    const r = await axios.get(`${SM_URL}${coverPath}`, {
      headers: { Cookie: cookie },
      responseType: 'arraybuffer',
      timeout: 8000
    });
    res.set('Content-Type', r.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(r.data);
  } catch(e) {
    res.status(404).end();
  }
});


// Get releases for a book
app.get('/api/shelfmark/releases', requireAuth, async (req, res) => {
  const { title, author } = req.query;
  if (!title) return res.json({ error: 'title required' });
  try {
    const query = [title, author].filter(Boolean).join(' ');
    const params = new URLSearchParams({ source: 'direct_download', query, sort: 'relevance' });
    ['epub','mobi','azw3','fb2','djvu','cbz','cbr'].forEach(f => params.append('format', f));
    const r = await smGet(`/api/releases?${params.toString()}`);
    const releases = (r.data?.releases || []).slice(0, 8).map(rel => ({
      source: rel.source, source_id: rel.source_id,
      title: rel.title, format: rel.format,
      size: rel.size, language: rel.language, extra: rel.extra || {},
    }));
    res.json({ releases });
  } catch(e) {
    console.error('[shelfmark releases]', e.message);
    res.json({ releases: [], error: 'Could not fetch releases' });
  }
});

// Helper: find a downloaded file on disk by title+author+format
function findBookOnDisk(title, author, format) {
  if (!fs.existsSync(BOOKS_DIR)) return null;
  const files = fs.readdirSync(BOOKS_DIR);
  const clean = s => (s || '').toLowerCase().replace(/[()[\]'":]/g, '').trim();
  const titleClean = clean(title);
  const authorClean = clean(author ? author.split(',')[0] : '');
  const titleWords = titleClean.split(/\s+/).filter(w => w.length > 3).slice(0, 6);
  const fmt = (format || '').toLowerCase();

  // 1. Author + title words + format (most specific)
  if (authorClean && fmt) {
    const hit = files.find(f => {
      const fl = clean(f);
      return fl.includes(authorClean.slice(0, 8)) &&
        titleWords.filter(w => fl.includes(w)).length >= Math.min(2, titleWords.length) &&
        f.toLowerCase().endsWith('.' + fmt);
    });
    if (hit) return hit;
  }
  // 2. Author + title words (no format)
  if (authorClean) {
    const hit = files.find(f => {
      const fl = clean(f);
      return fl.includes(authorClean.slice(0, 8)) &&
        titleWords.filter(w => fl.includes(w)).length >= Math.min(2, titleWords.length);
    });
    if (hit) return hit;
  }
  // 3. Title words + format
  if (titleWords.length >= 2 && fmt) {
    const hit = files.find(f => {
      const fl = clean(f);
      return titleWords.every(w => fl.includes(w)) && f.toLowerCase().endsWith('.' + fmt);
    });
    if (hit) return hit;
  }
  // 4. Title words only — require ALL words
  if (titleWords.length >= 2) {
    const hit = files.find(f => {
      const fl = clean(f);
      return titleWords.every(w => fl.includes(w));
    });
    if (hit) return hit;
  }
  return null;
}

async function getShelfmarkRecord(source_id) {
  const { data: record } = await db.from('shelfmark_downloads')
    .select('source_id, filename, title, format, source, author, cover_url, year, description')
    .eq('source_id', source_id).maybeSingle();
  return record || null;
}

async function locateShelfmarkFile(record) {
  let filename = record?.filename || null;
  if (filename && !fs.existsSync(path.join(BOOKS_DIR, filename))) filename = null;
  if (!filename) filename = findBookOnDisk(record?.title, record?.author, record?.format);
  if (!filename) return null;
  const filePath = path.join(BOOKS_DIR, filename);
  return fs.existsSync(filePath) ? { filename, filePath } : null;
}

async function ensureShelfmarkEpub(source_id) {
  const record = await getShelfmarkRecord(source_id);
  if (!record) throw new Error('Book record not found');
  const located = await locateShelfmarkFile(record);
  if (!located) throw new Error('File not found — it may still be downloading');

  const cleanTitle = safeDownloadName(record.title || located.filename.replace(/\.[^.]+$/, ''), 'book');
  const stat = fs.statSync(located.filePath);
  const cacheDir = path.join(os.tmpdir(), 'portal-ebook-epub-v1');
  await fs.promises.mkdir(cacheDir, { recursive: true });
  const cacheKey = safeCacheKey(`${source_id}-${stat.mtimeMs}-${stat.size}`, source_id);
  const cachedPath = path.join(cacheDir, `${cacheKey}.epub`);
  if (fs.existsSync(cachedPath)) return { path: cachedPath, title: cleanTitle, record };

  const ext = path.extname(located.filename).toLowerCase();
  const calibreBin = fs.existsSync('/opt/calibre/calibre/ebook-convert')
    ? '/opt/calibre/calibre/ebook-convert'
    : (fs.existsSync('/opt/calibre/ebook-convert') ? '/opt/calibre/ebook-convert' : 'ebook-convert');

  try {
    await runCommand(calibreBin, [
      located.filePath, cachedPath,
      '--title', cleanTitle,
      '--authors', record.author || 'Unknown',
      '--epub-version', '3',
      '--no-default-epub-cover',
      '--subset-embedded-fonts',
    ], 120000);
  } catch(e) {
    if (ext === '.epub') {
      await fs.promises.copyFile(located.filePath, cachedPath);
    } else {
      throw e;
    }
  }

  return { path: cachedPath, title: cleanTitle, record };
}

// Trigger Shelfmark download and track it
app.post('/api/shelfmark/download', requireAuth, async (req, res) => {
  const { source, source_id, title, format, size, extra, provider_id, provider, isbn, author, cover_url, year, description } = req.body;
  if (!source || !source_id || !title) return res.json({ error: 'source, source_id and title required' });
  const username = req.session.user.emby_username || req.session.user.discord_username;
  try {
    // Check if already on disk — skip triggering a new download
    const existingFile = findBookOnDisk(title, author, format);
    if (existingFile) {
      await db.from('shelfmark_downloads').upsert({
        source_id, source, title, format: format || 'epub', size,
        isbn: isbn || null, provider_id: provider_id || null, provider: provider || null,
        author: author || null, cover_url: cover_url || null, year: year || null, description: description || null,
        requested_by: username, status: 'complete', filename: existingFile,
        created_at: new Date().toISOString(),
      }, { onConflict: 'source_id' });
      console.log(`[shelfmark] File already on disk: "${existingFile}"`);
      return res.json({ success: true, source_id, already_complete: true });
    }
    // Check daily cap (skip for unlimited user)
    if (username !== BOOKS_UNLIMITED_USER) {
      const todayStart = new Date(); todayStart.setHours(0,0,0,0);
      const { count } = await db.from('shelfmark_downloads')
        .select('id', { count: 'exact', head: true })
        .eq('requested_by', username)
        .gte('created_at', todayStart.toISOString());
      if (count >= BOOKS_DAILY_CAP) {
        return res.json({ error: `Daily download limit reached (${BOOKS_DAILY_CAP}/day). Try again tomorrow.` });
      }
    }
    const cookie = await smLogin();
    try {
      await axios.post(`${SM_URL}/api/releases/download`,
        { source, source_id, title, format, size, extra: extra || {} },
        { headers: { Cookie: cookie, 'Content-Type': 'application/json' }, timeout: 15000 }
      );
    } catch(smErr) {
      console.warn(`[shelfmark download] Shelfmark trigger failed (${smErr.message}) — trying fresh search`);
      // Check disk first
      const diskFile = findBookOnDisk(title, author, format);
      if (diskFile) {
        await db.from('shelfmark_downloads').upsert({
          source_id, source, title, format: format || 'epub', size,
          isbn: isbn || null, provider_id: provider_id || null, provider: provider || null,
          author: author || null, cover_url: cover_url || null, year: year || null,
          requested_by: username, status: 'complete', filename: diskFile,
          created_at: new Date().toISOString(),
        }, { onConflict: 'source_id' });
        return res.json({ success: true, source_id, already_complete: true });
      }
      // source_id may be expired — try fresh direct search by title
      try {
        const params = new URLSearchParams({ source: 'direct_download', query: title, sort: 'relevance' });
        const fmts = format ? [format] : ['epub','mobi','azw3','cbz','cbr'];
        fmts.forEach(f => params.append('format', f));
        const searchRes = await smGet(`/api/releases?${params.toString()}`);
        const freshRel = (searchRes.data?.releases || [])[0];
        if (freshRel) {
          console.log(`[shelfmark download] Retrying with fresh source_id: ${freshRel.source_id}`);
          await axios.post(`${SM_URL}/api/releases/download`,
            { source: freshRel.source, source_id: freshRel.source_id, title: freshRel.title || title, format: freshRel.format || format, size: freshRel.size, extra: freshRel.extra || {} },
            { headers: { Cookie: cookie, 'Content-Type': 'application/json' }, timeout: 15000 }
          );
          await db.from('shelfmark_downloads').upsert({
            source_id: freshRel.source_id, source: freshRel.source, title: freshRel.title || title,
            format: freshRel.format || format || 'epub', size: freshRel.size,
            author: author || freshRel.extra?.author || null, cover_url: cover_url || null,
            year: year || freshRel.extra?.year || null, description: description || null,
            requested_by: username, status: 'queued', created_at: new Date().toISOString(),
          }, { onConflict: 'source_id' });
          console.log(`[shelfmark] Queued with fresh source: ${freshRel.source_id}`);
          return res.json({ success: true, source_id: freshRel.source_id });
        }
      } catch(retryErr) {
        console.error('[shelfmark download] Retry also failed:', retryErr.message);
      }
      return res.json({ error: 'Download failed — this source may be unavailable. Try searching for the book again.' });
    }
    await db.from('shelfmark_downloads').upsert({
      source_id, source, title, format: format || 'epub', size,
      isbn: isbn || null, provider_id: provider_id || null, provider: provider || null,
      author: author || null, cover_url: cover_url || null, year: year || null,
      description: description || null,
      requested_by: username, status: 'queued',
      created_at: new Date().toISOString(),
    }, { onConflict: 'source_id' });
    console.log(`[shelfmark] Download queued: "${title}" (${source_id})`);
    res.json({ success: true, source_id });
  } catch(e) {
    console.error('[shelfmark download]', e.message);
    res.json({ error: 'Download failed — try again' });
  }
});

// Poll download status
app.get('/api/shelfmark/status/:source_id', requireAuth, async (req, res) => {
  const { source_id } = req.params;
  if (String(source_id).startsWith('bw:')) {
    try {
      const bookId = String(source_id).slice(3);
      const prepared = await ensureBookEpub(bookId, req.query.title || `book-${bookId}`);
      res.setHeader('Content-Type', 'application/epub+zip');
      res.setHeader('Content-Disposition', 'inline');
      return res.sendFile(prepared.path);
    } catch (e) {
      return res.status(404).json({ error: 'Book file is not available.' });
    }
  }
  try {
    const { data: record } = await db.from('shelfmark_downloads')
      .select('title, status, filename, author').eq('source_id', source_id).maybeSingle();
    // Check exact filename first
    if (record?.filename && fs.existsSync(path.join(BOOKS_DIR, record.filename))) {
      return res.json({ status: 'complete', filename: record.filename });
    }
    // Use helper to find by title+author
    const match = findBookOnDisk(record?.title, record?.author);
    if (match) {
      await db.from('shelfmark_downloads').update({ status: 'complete', filename: match }).eq('source_id', source_id);
      return res.json({ status: 'complete', filename: match });
    }
    // kindle_sent means file was sent but may still be on disk
    if (record?.status === 'kindle_sent') return res.json({ status: 'complete' });
    res.json({ status: record?.status || 'pending' });
  } catch(e) { res.json({ status: 'unknown' }); }
});

// Serve a rebuilt EPUB for browser download. This mirrors the comic EPUB path.
app.get('/api/shelfmark/epub/:source_id', requireAuth, async (req, res) => {
  try {
    const { path: epubPath, title, record } = await ensureShelfmarkEpub(req.params.source_id);
    const filename = `${safeDownloadName(title, 'book')}.epub`;
    res.setHeader('Content-Type', 'application/epub+zip');
    res.download(epubPath, filename, async (err) => {
      if (err) {
        console.error('[shelfmark epub] download error:', err.message);
        return;
      }
      try {
        const original = await locateShelfmarkFile(record);
        if (original?.filePath && fs.existsSync(original.filePath)) {
          fs.unlinkSync(original.filePath);
          console.log(`[shelfmark] Deleted after EPUB download: ${original.filename}`);
        }
        if (fs.existsSync(epubPath)) fs.unlinkSync(epubPath);
        await db.from('shelfmark_downloads').update({ status: 'delivered', filename: null }).eq('source_id', req.params.source_id);
      } catch(delErr) {
        console.error('[shelfmark epub] cleanup failed:', delErr.message);
      }
    });
  } catch(e) {
    console.error('[shelfmark epub]', e.message);
    res.status(500).json({ error: 'Could not prepare EPUB' });
  }
});

// Serve downloaded file to browser
app.get('/api/shelfmark/file/:source_id', requireAuth, async (req, res) => {
  const { source_id } = req.params;
  try {
    const { data: record } = await db.from('shelfmark_downloads')
      .select('filename, title, format, author').eq('source_id', source_id).maybeSingle();

    let filename = record?.filename;
    // Verify the filename actually exists on disk (may have been cleaned up)
    if (filename && !fs.existsSync(path.join(BOOKS_DIR, filename))) filename = null;
    // Use helper to find by title+author
    if (!filename) filename = findBookOnDisk(record?.title, record?.author);

    if (!filename) return res.status(404).json({ error: 'File not found — it may still be downloading' });
    const filePath = path.join(BOOKS_DIR, filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });

    // Update DB with filename if not already set
    if (record && !record.filename) {
      await db.from('shelfmark_downloads').update({ status: 'complete', filename }).eq('source_id', source_id);
    }

    // Serve the file, then delete from disk after download completes
    res.download(filePath, filename, async (err) => {
      if (err) {
        console.error('[shelfmark file] download error:', err.message);
        return;
      }
      // Delete file from disk after successful delivery
      try {
        fs.unlinkSync(filePath);
        console.log(`[shelfmark] Deleted after download: ${filename}`);
        // Mark as delivered in DB
        await db.from('shelfmark_downloads').update({ status: 'delivered', filename: null }).eq('source_id', source_id);
      } catch(delErr) {
        console.error('[shelfmark] Delete failed:', delErr.message);
      }
    });
  } catch(e) {
    console.error('[shelfmark file]', e.message);
    res.status(500).json({ error: 'Could not serve file' });
  }
});

// Send file to Kindle via the provider selected in Kindle Email Delivery.
// nodemailer is already part of this portal's runtime and is only used when
// an administrator explicitly selects custom SMTP.
const nodemailer = require('nodemailer');

app.post('/api/shelfmark/send-kindle', requireAuth, async (req, res) => {
  const { source_id } = req.body;
  const { emby_user_id } = req.session.user;
  if (!emby_user_id) return res.json({ error: 'No Emby account linked' });

  // Get Kindle email from PostgreSQL
  const { data: account } = await db.from('emby_accounts')
    .select('kindle_email, username').eq('emby_user_id', emby_user_id).maybeSingle();
  if (!account?.kindle_email) return res.json({ error: 'No Kindle email set — add it in your profile first' });

  // Find the file — re-download if it was deleted after previous delivery
  const { data: record } = await db.from('shelfmark_downloads')
    .select('filename, title, format, source, author').eq('source_id', source_id).maybeSingle();

  let filename = record?.filename;
  // Verify file actually exists (may have been deleted after download)
  if (filename && !fs.existsSync(path.join(BOOKS_DIR, filename))) filename = null;
  // Try finding by title+author from shelfmark_downloads record
  if (!filename && record?.title) filename = findBookOnDisk(record.title, record.author, record.format);
  // Also check my_books for the title if source_id didn't match
  if (!filename) {
    const { data: mbRecord } = await db.from('my_books')
      .select('title, format').eq('book_source_id', source_id).maybeSingle();
    if (mbRecord?.title) filename = findBookOnDisk(mbRecord.title, null, mbRecord.format);
    if (!filename && mbRecord?.title && !record) {
      // Use my_books data as the record for re-download
      Object.assign(record || {}, { title: mbRecord.title, format: mbRecord.format, source: 'direct_download' });
    }
  }

  // File not on disk — trigger a fresh download and wait for it
  if (!filename) {
    if (!record?.source || !source_id || !record?.title) {
      return res.json({ error: 'File not on server — please download it first, then send to Kindle' });
    }
    try {
      const cookie = await smLogin();
      await axios.post(`${SM_URL}/api/releases/download`,
        { source: record.source, source_id, title: record.title, format: record.format || 'epub', extra: {} },
        { headers: { Cookie: cookie, 'Content-Type': 'application/json' }, timeout: 15000 }
      );
    } catch(smErr) {
      console.warn(`[kindle re-download] Shelfmark trigger failed: ${smErr.message}`);
      // Shelfmark may return 500 if it can't re-serve this exact source_id
      // Check if file somehow appeared anyway
    }
    // Poll for up to 2 minutes regardless of trigger result
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 5000));
      filename = findBookOnDisk(record.title, record.author, record.format);
      if (filename) break;
    }
    if (!filename) return res.json({ error: 'Book needs to be re-downloaded — search for it again, press Download, then Send to Kindle once it completes' });
  }

  let prepared;
  try {
    prepared = await ensureShelfmarkEpub(source_id);
  } catch(e) {
    console.error('[kindle epub prepare]', e.message);
    return res.json({ error: `Could not prepare EPUB: ${e.message}` });
  }
  const title = prepared.title;
  const cleanTitle = safeDownloadName(title, 'book').slice(0, 60).trim();
  const sendPath = prepared.path;
  const sendExt = '.epub';

  const fileSizeMB = fs.statSync(sendPath).size / 1024 / 1024;
  if (fileSizeMB > 29) {
    return res.json({ error: `File is too large to email (${fileSizeMB.toFixed(1)}MB — limit is 30MB). Download it instead.` });
  }

  try {
    const cleanFilename = cleanTitle + sendExt;
    console.log(`[kindle] Sending "${cleanFilename}" (${fileSizeMB.toFixed(1)}MB) to ${account.kindle_email} via ${getKindleMailConfig().provider}`);
    const fileContent = fs.readFileSync(sendPath).toString('base64');
    const delivery = await sendKindleMail({
      label: 'Portal v1 Library',
      to: account.kindle_email,
      subject: '',
      text: `"${title}" is ready on your Kindle.`,
      attachments: [{ filename: cleanFilename, content: fileContent }]
    });
    console.log(`[kindle] Sent via ${getKindleMailConfig().provider} — id: ${delivery?.id || delivery?.messageId || 'sent'}`);
    try {
      const delivered = await locateShelfmarkFile(record);
      if (delivered?.filePath && fs.existsSync(delivered.filePath)) {
        fs.unlinkSync(delivered.filePath);
        console.log(`[shelfmark] Deleted after Kindle send: ${delivered.filename}`);
      }
      if (fs.existsSync(sendPath)) fs.unlinkSync(sendPath);
    } catch(delErr) {
      console.error('[shelfmark] Kindle cleanup failed:', delErr.message);
    }
    await db.from('shelfmark_downloads').update({ status: 'kindle_sent', filename: null }).eq('source_id', source_id);
    res.json({ success: true });
  } catch(e) {
    console.error('[kindle send] FULL ERROR:', e.message, e.response?.data);
    res.json({ error: `Failed to send: ${e.message}` });
  }
});

// Save Kindle email
app.post('/api/user/kindle-email', requireAuth, async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.json({ error: 'Valid email required' });
  const { emby_user_id } = req.session.user;
  if (!emby_user_id) return res.json({ error: 'No Emby account linked' });
  const { error } = await db.from('emby_accounts')
    .update({ kindle_email: email.trim() }).eq('emby_user_id', emby_user_id);
  if (error) return res.json({ error: 'Failed to save' });
  res.json({ success: true });
});

// Background cleanup — delete files older than 30 days or when >20GB
async function cleanupShelfmarkBooks() {
  try {
    if (!fs.existsSync(BOOKS_DIR)) return;
    const files = fs.readdirSync(BOOKS_DIR).map(f => {
      const p = path.join(BOOKS_DIR, f);
      const stat = fs.statSync(p);
      return { name: f, path: p, mtime: stat.mtimeMs, size: stat.size, atime: stat.atimeMs };
    }).filter(f => {
      try { return fs.statSync(f.path).isFile(); } catch(e) { return false; }
    });

    const now = Date.now();
    const inactivityCutoff = now - BOOKS_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    let deleted = 0;

    // Rule 1: Delete books scheduled for deletion (finished by user)
    const { data: scheduledRows } = await db.from('shelfmark_downloads')
      .select('source_id, filename, title, delete_after')
      .not('delete_after', 'is', null)
      .lt('delete_after', new Date().toISOString());

    for (const row of (scheduledRows || [])) {
      const filename = row.filename;
      if (filename) {
        const fp = path.join(BOOKS_DIR, filename);
        if (fs.existsSync(fp)) {
          fs.unlinkSync(fp);
          console.log(`[cleanup] Deleted finished book: ${filename}`);
          deleted++;
        }
      }
      await db.from('shelfmark_downloads').delete().eq('source_id', row.source_id);
      await db.from('reading_progress').delete().eq('source_id', row.source_id);
    }

    // Rule 2: Delete books inactive for 14+ days (not opened since)
    const { data: progressRows } = await db.from('reading_progress')
      .select('source_id, book_title, last_read, filename')
      .lt('last_read', new Date(inactivityCutoff).toISOString());

    for (const row of (progressRows || [])) {
      if (!row.source_id) continue;
      const { data: dlRow } = await db.from('shelfmark_downloads')
        .select('filename, title').eq('source_id', row.source_id).maybeSingle();
      const filename = dlRow?.filename;
      if (filename) {
        const fp = path.join(BOOKS_DIR, filename);
        if (fs.existsSync(fp)) {
          fs.unlinkSync(fp);
          console.log(`[cleanup] Deleted inactive book (${BOOKS_MAX_AGE_DAYS}d): ${filename}`);
          deleted++;
        }
      }
    }

    // Rule 3: Delete files older than 14 days by mtime (catch ones without DB records)
    const remainingFiles = fs.readdirSync(BOOKS_DIR).map(f => {
      const p = path.join(BOOKS_DIR, f);
      try { const s = fs.statSync(p); return { name: f, path: p, mtime: s.mtimeMs, size: s.size }; }
      catch(e) { return null; }
    }).filter(Boolean);

    for (const f of remainingFiles) {
      if (f.mtime < inactivityCutoff) {
        fs.unlinkSync(f.path);
        console.log(`[cleanup] Deleted old file by mtime: ${f.name}`);
        deleted++;
      }
    }

    // Rule 4: Hard cap — if still over 15GB, delete oldest by access time
    const afterCleanup = fs.readdirSync(BOOKS_DIR).map(f => {
      const p = path.join(BOOKS_DIR, f);
      try { const s = fs.statSync(p); return { name: f, path: p, mtime: s.mtimeMs, size: s.size }; }
      catch(e) { return null; }
    }).filter(Boolean).sort((a, b) => a.mtime - b.mtime);

    let totalBytes = afterCleanup.reduce((s, f) => s + f.size, 0);
    const maxBytes = BOOKS_MAX_GB * 1024 * 1024 * 1024;

    for (const f of afterCleanup) {
      if (totalBytes <= maxBytes) break;
      try {
        fs.unlinkSync(f.path);
        totalBytes -= f.size;
        console.log(`[cleanup] Hard cap delete: ${f.name} (${(f.size/1024/1024).toFixed(1)}MB)`);
        deleted++;
      } catch(e) {}
    }

    if (deleted > 0) console.log(`[cleanup] Removed ${deleted} book file(s). Server: ${(totalBytes/1024/1024/1024).toFixed(2)}GB / ${BOOKS_MAX_GB}GB`);
  } catch(e) {
    console.error('[cleanup]', e.message);
  }
}

// Run cleanup every 6 hours
setInterval(cleanupShelfmarkBooks, 6 * 60 * 60 * 1000);
cleanupShelfmarkBooks();

// ─── COMIC CACHE ─────────────────────────────────────────────────────────────
// SM-issues-first: fetch real downloadable issues from Shelfmark, use their
// covers directly. No CV title matching needed — source_id is always exact.
// CV is queried per-issue to get a better cover if available, but SM cover
// is the reliable fallback. Ebook/audiobook paths are completely unaffected.

// Comic cache: one best-match issue per query term, enriched with CV metadata via SM.
// trending = curated cross-genre picks. Genre pills = per-genre queries, live from SM.

// Trending: one pick per term, spanning all genres for variety
const COMIC_TRENDING_QUERIES = [
  'batman', 'spider-man', 'walking dead', 'one piece', 'x-men',
  'invincible', 'sandman', 'saga', 'naruto', 'iron man',
  'thor', 'watchmen', 'preacher', 'berserk', 'conan',
  'hellblazer', 'daredevil', 'captain america', 'attack on titan', 'wonder woman',
];

// Genre pills: queries run live on SM when pill clicked
const COMIC_GENRE_QUERIES = {
  superhero:       ['batman', 'superman', 'spider-man', 'x-men', 'avengers', 'iron man', 'captain america', 'thor', 'daredevil', 'wonder woman', 'flash', 'hulk', 'deadpool', 'wolverine', 'justice league'],
  manga:           ['one piece', 'naruto', 'dragon ball', 'bleach', 'attack on titan', 'demon slayer', 'berserk', 'fullmetal alchemist', 'death note', 'chainsaw man', 'jujutsu kaisen', 'one punch man'],
  'graphic novel': ['saga', 'sandman', 'walking dead', 'watchmen', 'maus', 'preacher', 'v for vendetta', 'from hell', 'fables', 'transmetropolitan'],
  fantasy:         ['conan', 'elfquest', 'bone', 'monstress', 'east of west', 'rat queens', 'lazarus', 'black science'],
  horror:          ['walking dead', 'swamp thing', 'hellblazer', 'wytches', 'locke and key', 'nailbiter', 'revival'],
};

// Cache: source_id → enriched issue entry. Only trending queries are cached.
// Genre pills and search always go live to SM (fast enough, no caching needed).
let _comicCache = new Map();
let _comicCacheBuilding = false;

// Fetch best SM release for a query + CV metadata from SM metadata API
// Convert a SM release to a comic item, using SM cover + real file title
function smRelToItem(rel, cvCoverByQuery) {
  const smCover = rel.extra?.preview ? `/api/shelfmark/cover?path=${encodeURIComponent(rel.extra.preview)}` : null;
  // Use CV cover only if SM has no cover (CV cover is a series cover, not issue-specific)
  const cover = smCover || cvCoverByQuery || null;
  return {
    source_id: rel.source_id,
    title: rel.title,  // Always use real SM file title
    author: rel.extra?.author || null,
    year: rel.extra?.year || null,
    description: null,
    cover,
    format: rel.format || 'cbz',
    size: rel.size || null,
  };
}

// Fetch SM releases for a query, optionally get one CV cover for the query term
async function smReleasesForQuery(q, limit = 20) {
  const p = new URLSearchParams({ source: 'direct_download', query: q, sort: 'relevance', limit });
  ['cbz','cbr'].forEach(f => p.append('format', f));
  const [smRes, cvRes] = await Promise.all([
    smGet(`/api/releases?${p}`).catch(() => null),
    smGet(`/api/metadata/search?query=${encodeURIComponent(q)}&provider=comicvine&limit=1`).catch(() => null),
  ]);
  const releases = (smRes?.data?.releases || []).filter(r => {
    const lang = (r.language || r.extra?.language || 'en').toLowerCase();
    return !lang || lang === 'en';
  });
  // One CV cover for this query (series-level, used as fallback when SM has no preview)
  const cvBook = cvRes?.data?.books?.[0];
  const cvCoverRaw = cvBook?.cover_url || null;
  const cvCover = cvCoverRaw?.startsWith('/api/covers/')
    ? `/api/shelfmark/cover?path=${encodeURIComponent(cvCoverRaw)}`
    : cvCoverRaw;
  return { releases, cvCover };
}

async function buildComicCache() {
  if (_comicCacheBuilding) return;
  _comicCacheBuilding = true;
  console.log('[comic-cache] Building trending comic cache...');
  try {
    // Fetch 3 issues per trending query, all in parallel
    const batches = await Promise.all(COMIC_TRENDING_QUERIES.map(q => smReleasesForQuery(q, 3).catch(() => ({ releases: [], cvCover: null }))));
    const newCache = new Map();
    const seenTitles = new Set();
    for (let i = 0; i < COMIC_TRENDING_QUERIES.length; i++) {
      const { releases, cvCover } = batches[i];
      for (const rel of releases) {
        if (!rel.source_id) continue;
        const tk = (rel.title||'').toLowerCase().replace(/[^a-z0-9]/g,'');
        if (seenTitles.has(tk)) continue;
        seenTitles.add(tk);
        newCache.set(rel.source_id, smRelToItem(rel, cvCover));
      }
    }
    _comicCache = newCache;
    console.log(`[comic-cache] Cache built: ${newCache.size} trending issues`);
  } catch(e) {
    console.error('[comic-cache] Build failed:', e.message);
  } finally {
    _comicCacheBuilding = false;
  }
}

// Live SM search for a query — returns all matching issues with SM titles + SM covers
async function liveComicSearch(q) {
  const { releases, cvCover } = await smReleasesForQuery(q, 50);
  const seen = new Set();
  return releases.filter(r => {
    const k = (r.title||'').toLowerCase().replace(/[^a-z0-9]/g,'');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).map(rel => smRelToItem(rel, cvCover));
}

// Build cache on startup + refresh every 6h
setTimeout(() => buildComicCache(), 15000);
setInterval(() => buildComicCache(), 6 * 60 * 60 * 1000);


// Stream BookWarehouse audio for the in-app player. Range forwarding is
// required for seeking and for mobile browsers.
app.get('/api/library/audiobooks/:id/stream', requireAuth, async (req, res) => {
  try {
    const headers = BW_HEADERS();
    if (req.headers.range) headers.Range = req.headers.range;
    const r = await axios.get(`${BW_BASE}/audiobooks/${encodeURIComponent(req.params.id)}/download`, {
      headers, responseType: 'stream', timeout: 30000, validateStatus: () => true
    });
    if (r.status >= 400) return res.status(r.status).json({ error: 'Audiobook stream unavailable.' });
    ['content-type','content-length','content-range','accept-ranges'].forEach(name => {
      if (r.headers[name]) res.setHeader(name, r.headers[name]);
    });
    res.setHeader('Content-Disposition', 'inline');
    res.status(r.status);
    r.data.on('error', error => { if (!res.headersSent) res.status(502); res.end(); });
    r.data.pipe(res);
  } catch (e) {
    console.error('[audiobook stream]', e.message);
    if (!res.headersSent) res.status(502).json({ error: 'Audiobook stream unavailable.' });
  }
});

// Prepare book for reading — find existing file or trigger download
app.post('/api/reader/prepare', requireAuth, async (req, res) => {
  const { title, source_id, type } = req.body;
  const isComic = type === 'comic';
  // BookWarehouse books are normalized to EPUB once and then opened by the
  // same Portal reader used for Shelfmark downloads.
  if (!isComic && String(source_id || '').startsWith('bw:')) {
    const bookId = String(source_id).slice(3);
    try {
      await ensureBookEpub(bookId, title || `book-${bookId}`);
      return res.json({ ready: true, source_id: `bw:${bookId}`, title: title || `book-${bookId}` });
    } catch (e) {
      console.error('[reader prepare bookwarehouse]', e.message);
      return res.status(502).json({ error: 'Could not prepare this book for the Portal reader.' });
    }
  }
  const username = req.session.user.emby_username || req.session.user.discord_username;
  const crypto = require('crypto');
  try {
    // 1. Check existing DB record by source_id first (exact), then title+format
    const comicFormats = ['cbz','cbr'];
    const ebookFormats = ['epub','mobi','azw3','fb2','pdf'];
    if (source_id) {
      const { data: byId } = await db.from('shelfmark_downloads')
        .select('source_id, status, filename, title, format')
        .eq('source_id', source_id).maybeSingle();
      if (byId?.filename || byId?.status === 'complete') {
        return res.json({ ready: true, source_id: byId.source_id, title: byId.title || title });
      }
    }
    // Title match — must also match type (comic vs ebook) via format field
    const { data: existing } = await db.from('shelfmark_downloads')
      .select('source_id, status, filename, title, format')
      .ilike('title', `%${title.slice(0,30)}%`)
      .limit(10);
    const typeMatch = (existing || []).find(r => {
      if (!r.filename && r.status !== 'complete') return false;
      const fmt = (r.format || '').toLowerCase();
      const ext = (r.filename || '').split('.').pop().toLowerCase();
      if (isComic) return comicFormats.includes(fmt) || comicFormats.includes(ext);
      return ebookFormats.includes(fmt) || ebookFormats.includes(ext);
    });
    if (typeMatch) {
      return res.json({ ready: true, source_id: typeMatch.source_id, title: typeMatch.title || title });
    }
    // 2. Check disk by title - use ALL significant words, most specific first
    if (fs.existsSync(BOOKS_DIR)) {
      const files = fs.readdirSync(BOOKS_DIR);
      const cleanTitle = (title || '').toLowerCase().replace(/[()[\]'"]/g,'').trim();
      const words = cleanTitle.split(/\s+/).filter(w => w.length > 2);

      // Filter files by type — comics need cbz/cbr, books need epub/mobi etc
      const typeExts = isComic ? ['.cbz','.cbr'] : ['.epub','.mobi','.azw3','.fb2','.pdf'];
      const typeFiles = files.filter(f => typeExts.some(ext => f.toLowerCase().endsWith(ext)));
      const searchFiles = typeFiles.length ? typeFiles : files;

      // Title matching — strip extension and punctuation from filename for comparison
      const stripFile = f => f.toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      const cleanWords = cleanTitle.replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(w => w.length > 2);

      let match = null;
      // 1. Filename starts with the full clean title (strongest signal)
      match = searchFiles.find(f => stripFile(f).startsWith(cleanTitle.slice(0, 30)));
      // 2. Filename equals title exactly (ignoring ext/punctuation)
      if (!match) match = searchFiles.find(f => stripFile(f) === cleanTitle.replace(/[^a-z0-9 ]/g,' ').trim());
      // 3. All words present AND first word matches start of filename (prevents "batman noir" matching for query "batman")
      if (!match && cleanWords.length >= 2) {
        match = searchFiles.find(f => {
          const fl = stripFile(f);
          return fl.startsWith(cleanWords[0]) && cleanWords.every(w => fl.includes(w));
        });
      }

      if (match) {
        const fakeId = crypto.createHash('md5').update(title + username).digest('hex').slice(0,16);
        // Check if this fakeId already exists to avoid duplicates
        const { data: existing } = await db.from('shelfmark_downloads')
          .select('source_id').eq('source_id', fakeId).maybeSingle();
        if (!existing) {
          await db.from('shelfmark_downloads').insert({
            source_id: fakeId, source: 'direct', title, format: match.split('.').pop(),
            status: 'complete', filename: match, requested_by: username,
            created_at: new Date().toISOString(),
          });
        }
        return res.json({ ready: true, source_id: fakeId, title });
      }
    }
    // 3. Trigger direct download — use source_id if known, else search via direct mode
    let dlSource = 'direct_download';
    let dlSourceId = source_id || null;
    let dlTitle = title;
    let dlFormat = 'epub';
    let dlSize = null;

    if (!dlSourceId) {
      // Fall back to direct search — use type-appropriate formats
      const { type: reqType } = req.body;
      const isComic = reqType === 'comic' || (source_id || '').includes('comic');
      const params = new URLSearchParams({ source: 'direct_download', query: title, sort: 'relevance' });
      if (isComic) {
        ['cbz','cbr'].forEach(f => params.append('format', f));
      } else {
        ['epub','mobi','azw3','fb2'].forEach(f => params.append('format', f));
      }
      const smRes = await smGet(`/api/releases?${params.toString()}`).catch(() => null);
      const releases = smRes?.data?.releases || [];
      if (!releases.length) return res.json({ ready: false, error: 'No download sources found' });
      // Pick best-matching release — title must actually contain the query words
      const titleWords = title.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const bestRel = releases.find(r => {
        const rt = (r.title || '').toLowerCase();
        return titleWords.every(w => rt.includes(w));
      }) || releases.find(r => {
        const rt = (r.title || '').toLowerCase();
        return titleWords.length > 0 && rt.includes(titleWords[0]);
      }) || null;
      if (!bestRel) return res.json({ ready: false, error: 'No matching download found for this title' });
      const rel = bestRel;
      dlSourceId = rel.source_id;
      dlTitle = rel.title || title;
      dlFormat = rel.format || (isComic ? 'cbz' : 'epub');
      dlSize = rel.size || null;
    }

    const cookie = await smLogin();
    await axios.post(`${SM_URL}/api/releases/download`,
      { source: dlSource, source_id: dlSourceId, title: dlTitle, format: dlFormat, size: dlSize, extra: {} },
      { headers: { Cookie: cookie, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    await db.from('shelfmark_downloads').upsert({
      source_id: dlSourceId, source: dlSource, title: dlTitle,
      format: dlFormat, size: dlSize, requested_by: username, status: 'queued',
      created_at: new Date().toISOString(),
    }, { onConflict: 'source_id' });
    res.json({ ready: false, queued: true, source_id: dlSourceId, title: dlTitle });
  } catch(e) {
    console.error('[reader prepare]', e.message);
    res.json({ ready: false, error: e.message });
  }
});

// ─── READER API ───────────────────────────────────────────────────────────────
// Serve book file for reader
app.get('/api/reader/file/:source_id', requireAuth, async (req, res) => {
  const { source_id } = req.params;
  try {
    const { data: record } = await db.from('shelfmark_downloads')
      .select('filename, title').eq('source_id', source_id).maybeSingle();
    
    let filename = record?.filename;
    
    // If filename in DB, verify it exists
    if (filename) {
      const fp = path.join(BOOKS_DIR, filename);
      if (!fs.existsSync(fp)) filename = null; // reset if file moved
    }
    
    // Scan disk by title if no filename
    if (!filename && fs.existsSync(BOOKS_DIR)) {
      const files = fs.readdirSync(BOOKS_DIR);
      const title = (record?.title || '').toLowerCase().replace(/[()[\]'"]/g,'');
      const words = title.split(/\s+/).filter(w => w.length > 3);
      // Exact match first
      filename = files.find(f => f.toLowerCase().replace(/[()[\]'"]/g,'').includes(title.slice(0,20)));
      // Word match fallback
      if (!filename && words.length >= 2) {
        filename = files.find(f => { const fl = f.toLowerCase(); return words.every(w => fl.includes(w)); });
      }
    }

    if (!filename) return res.status(404).json({ error: 'File not found' });
    
    const filePath = path.join(BOOKS_DIR, filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });
    
    console.log(`[reader] Serving "${filename}" for source_id=${source_id}`);
    res.setHeader('Content-Type', filename.endsWith('.epub') ? 'application/epub+zip' : 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline');
    res.sendFile(path.resolve(filePath));
  } catch(e) { 
    console.error('[reader file]', e.message);
    res.status(500).json({ error: e.message }); 
  }
});

// Get reading progress
app.get('/api/reader/progress/:book_title', requireAuth, async (req, res) => {
  const username = req.session.user.emby_username || req.session.user.discord_username;
  const { data } = await db.from('reading_progress')
    .select('*').eq('user_id', username).eq('book_title', req.params.book_title).maybeSingle();
  res.json(data || {});
});

// Save reading progress
app.post('/api/reader/progress', requireAuth, async (req, res) => {
  const username = req.session.user.emby_username || req.session.user.discord_username;
  const { book_title, source_id, cfi, page, total_pages, bookmarks, percentage } = req.body;

  const isFinished = percentage >= (BOOKS_FINISH_THRESHOLD * 100);

  await db.from('reading_progress').upsert({
    user_id: username, book_title, source_id, cfi, page, total_pages,
    bookmarks: bookmarks || [],
    percentage: percentage || 0,
    finished: isFinished,
    last_read: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,book_title' });

  // If finished, schedule file for deletion after 24h (mark in DB)
  if (isFinished && source_id) {
    const deleteAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await db.from('shelfmark_downloads')
      .update({ delete_after: deleteAt })
      .eq('source_id', source_id)
      .is('delete_after', null); // only set once
    console.log(`[reader] "${book_title}" finished — scheduled deletion at ${deleteAt}`);
  }

  res.json({ success: true });
});

// In-app audiobook player page
app.get('/audio-reader', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'audio-reader.html'));
});

// Reader page
app.get('/reader', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'reader.html'));
});


// Confirmed quietest balanced hour from live playback data (93 plays)
// 🇺🇸 New York 5 PM Mon | 🇬🇧 London 10 PM Mon | 🇦🇺 Sydney 7 AM Tue
(function scheduleWeeklyRestart() {
  function msUntilNextRestart() {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(21, 0, 0, 0);
    const daysUntilMonday = (1 - now.getUTCDay() + 7) % 7 || 7;
    next.setUTCDate(now.getUTCDate() + daysUntilMonday);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 7);
    return next - now;
  }

  function scheduleNext() {
    const ms = msUntilNextRestart();
    const hrs = Math.round(ms / 3600000);
    console.log(`[restart] Next scheduled restart in ${hrs}h — Mon 21:00 UTC (NY 5pm Mon / London 10pm Mon / Sydney 7am Tue)`);
    setTimeout(() => {
      console.log('[restart] Executing weekly scheduled restart…');
      process.exit(0); // PM2 restarts automatically
    }, ms);
  }

  scheduleNext();
})();

// ─── LOGOUT ───────────────────────────────────────────────────────────────────
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
settingsReady = loadPortalSettings().catch(error => {
  console.error('[config] startup load failed:', error.message);
});
settingsReady.finally(() => {
  app.listen(PORT, () => console.log(`Portal running on port ${PORT}`));
});
