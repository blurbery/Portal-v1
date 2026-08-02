import crypto from 'crypto';

export type PortalEnv = {
  NODE_ENV: string;
  PORT: number;
  PORTAL_NAME: string;
  PORTAL_URL: string;
  PORTAL_ADMIN_EMAIL: string;
  DATABASE_URL: string;
  DATABASE_SSL: boolean;
  DATABASE_SSL_REJECT_UNAUTHORIZED: boolean;
  DATABASE_POOL_MAX: number;
  SESSION_SECRET: string;
  CONFIG_ENCRYPTION_KEY: string;
  PORTAL_ADMIN_USERNAME: string;
  PORTAL_ADMIN_PASSWORD_HASH: string;
  PORTAL_ADMIN_PASSWORD_SALT: string;
  COOKIE_SECURE: boolean;
  TRUST_PROXY: number;
};

function required(name: string): string {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new Error(`${name} is required. Set it in the environment or .env before starting Portal.`);
  }
  return value;
}

function bool(name: string, fallback = false): boolean {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return !['false', '0', 'off', 'disabled', 'no'].includes(raw);
}

function int(name: string, fallback: number): number {
  const raw = String(process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Parse and validate bootstrap environment variables.
 * SESSION_SECRET must be set — there is no hard-coded HMAC fallback.
 */
export function loadEnv(options: { requireDatabase?: boolean } = {}): PortalEnv {
  const NODE_ENV = String(process.env.NODE_ENV || 'development').trim() || 'development';
  const SESSION_SECRET = required('SESSION_SECRET');
  if (SESSION_SECRET === 'opds-cover-secret' || SESSION_SECRET.length < 16) {
    throw new Error('SESSION_SECRET must be a strong unique secret (at least 16 characters).');
  }

  const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
  if (options.requireDatabase !== false && !DATABASE_URL) {
    throw new Error('DATABASE_URL is required. Configure PostgreSQL before starting Portal.');
  }

  const cookieSecureEnv = String(process.env.COOKIE_SECURE || '').trim().toLowerCase();
  const COOKIE_SECURE = cookieSecureEnv
    ? !['false', '0', 'off', 'no'].includes(cookieSecureEnv)
    : NODE_ENV === 'production';

  return {
    NODE_ENV,
    PORT: int('PORT', 3000),
    PORTAL_NAME: String(process.env.PORTAL_NAME || 'Portal').trim() || 'Portal',
    PORTAL_URL: String(process.env.PORTAL_URL || '').trim(),
    PORTAL_ADMIN_EMAIL: String(process.env.PORTAL_ADMIN_EMAIL || 'admin@example.invalid').trim(),
    DATABASE_URL,
    DATABASE_SSL: bool('DATABASE_SSL', false),
    DATABASE_SSL_REJECT_UNAUTHORIZED: bool('DATABASE_SSL_REJECT_UNAUTHORIZED', true),
    DATABASE_POOL_MAX: int('DATABASE_POOL_MAX', 10),
    SESSION_SECRET,
    CONFIG_ENCRYPTION_KEY: required('CONFIG_ENCRYPTION_KEY'),
    PORTAL_ADMIN_USERNAME: String(process.env.PORTAL_ADMIN_USERNAME || 'admin').trim() || 'admin',
    PORTAL_ADMIN_PASSWORD_HASH: String(process.env.PORTAL_ADMIN_PASSWORD_HASH || '').trim(),
    PORTAL_ADMIN_PASSWORD_SALT: String(process.env.PORTAL_ADMIN_PASSWORD_SALT || '').trim(),
    COOKIE_SECURE,
    TRUST_PROXY: int('TRUST_PROXY', 1),
  };
}

export function configEncryptionKeyBytes(raw = process.env.CONFIG_ENCRYPTION_KEY || ''): Buffer {
  if (!raw) throw new Error('CONFIG_ENCRYPTION_KEY is not configured');
  return crypto.createHash('sha256').update(raw).digest();
}

export function featureEnabled(key: string, defaultValue = true): boolean {
  const raw = String(process.env[key] ?? '').trim().toLowerCase();
  return raw ? !['false', '0', 'off', 'disabled'].includes(raw) : defaultValue;
}
