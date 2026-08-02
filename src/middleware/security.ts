import type { Request, Response, NextFunction, RequestHandler } from 'express';
import Tokens from 'csrf';
import rateLimit from 'express-rate-limit';

const tokens = new Tokens();

declare module 'express-session' {
  interface SessionData {
    user?: Record<string, unknown>;
    csrfSecret?: string;
  }
}

function ensureCsrfSecret(req: Request): string {
  if (!req.session.csrfSecret) {
    req.session.csrfSecret = tokens.secretSync();
  }
  return req.session.csrfSecret;
}

export function issueCsrfToken(req: Request): string {
  return tokens.create(ensureCsrfSecret(req));
}

export const csrfTokenHandler: RequestHandler = (req, res) => {
  res.json({ csrfToken: issueCsrfToken(req) });
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Paths that must remain usable before a browser has fetched a CSRF token. */
const CSRF_EXEMPT_PREFIXES = [
  '/auth/login',
  '/auth/emby-connect/login',
  '/api/forgot-password',
  '/api/reset-password/submit',
];

function isCsrfExempt(req: Request): boolean {
  const path = req.path || req.originalUrl || '';
  return CSRF_EXEMPT_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}?`));
}

export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    // Ensure a secret exists so GETs can mint tokens for subsequent mutations.
    if (req.session) ensureCsrfSecret(req);
    next();
    return;
  }
  if (isCsrfExempt(req)) {
    next();
    return;
  }

  const secret = req.session?.csrfSecret;
  const headerToken = String(req.get('x-csrf-token') || req.get('csrf-token') || '').trim();
  const bodyToken = String((req.body && (req.body._csrf || req.body.csrfToken)) || '').trim();
  const token = headerToken || bodyToken;

  if (!secret || !token || !tokens.verify(secret, token)) {
    res.status(403).json({ error: 'Invalid or missing CSRF token' });
    return;
  }
  next();
}

export function createAuthRateLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.AUTH_RATE_LIMIT_MAX || 30),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts. Try again later.' },
  });
}
