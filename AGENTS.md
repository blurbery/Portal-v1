# Portal-v1 agent guide

## Stack

- Node.js 20+ (CI/dev image may be newer; `engines.node` requires `>=20`)
- TypeScript (`src/` → `dist/` via `tsc`)
- PostgreSQL 16
- Express session auth, CSRF tokens, Helmet, auth rate limiting

## First-time setup

```bash
cp .env.example .env
# Required: DATABASE_URL, SESSION_SECRET, CONFIG_ENCRYPTION_KEY,
# PORTAL_ADMIN_USERNAME, PORTAL_ADMIN_PASSWORD_HASH, PORTAL_ADMIN_PASSWORD_SALT
# Admin password hashes are scrypt (see hashPortalAdminPassword in src/portal/register.ts).

# Apply schema
psql "$DATABASE_URL" -f portal_schema.sql
psql "$DATABASE_URL" -f migrations/002-seerr-portal-flow.sql

npm install
npm run build
npm start
```

Health check: `GET /api/health` → `{ ok: true, database: "ok" }`.

### Generate a bootstrap admin hash

```bash
node -e "const c=require('crypto');const s=c.randomBytes(16).toString('hex');const h=c.scryptSync('your-password',s,64).toString('hex');console.log({salt:s,hash:h})"
```

Put `salt` in `PORTAL_ADMIN_PASSWORD_SALT` and `hash` in `PORTAL_ADMIN_PASSWORD_HASH`.

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run build` | `tsc` compile to `dist/` |
| `npm start` | run `node dist/index.js` |
| `npm run dev` | `tsx src/index.ts` |
| `npm test` | Vitest auth/CSRF/rate-limit suite |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check` | typecheck + tests |

## Layout

```
src/
  index.ts            entrypoint
  app.ts              Express app factory (helmet, session, CSRF, rate limit)
  config/             env validation + admin config field catalogue
  db/                 typed JSONB query-builder over pg
  middleware/         requireAuth, requireAdmin, requireLibraryAccess, CSRF, rate limit
  routes/             auth, dashboard, seerr, libraries, admin, readers, push
  services/           emby, jellyfin, plex, silo, seerr, arr, kavita, email, discord
  portal/register.ts  migrated portal helpers + route registrar implementations
public/               static UI (PWA sw.js, readers, dashboard)
```

`/api/*` contracts, OPDS feeds, and `public/sw.js` are preserved.

## Security notes

- `SESSION_SECRET` is required (no HMAC fallback).
- Session cookies: `httpOnly`, `sameSite=lax`, `secure` when `NODE_ENV=production` (override with `COOKIE_SECURE`).
- `trust proxy` defaults to `1`.
- CSRF: clients must send `X-CSRF-Token` from `GET /api/csrf-token` on POST/PUT/DELETE (login/forgot-password exempt).
- DB TLS: set `DATABASE_SSL=true`; verification via `DATABASE_SSL_REJECT_UNAUTHORIZED` (default `true`).

## Manual verification checklist

1. `npm run typecheck` and `npm test` pass.
2. `npm run build && npm start` — `/api/health` ok.
3. Sign in with bootstrap admin → `/dashboard`.
4. Open Administration → config loads (`GET /api/admin/config`).
5. If Seerr is configured, open Requests and complete one search/request flow.
