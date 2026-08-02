# Portal v2.0.0

## Highlights

- Full TypeScript migration with `tsc` build (`src/` → `dist/`).
- Express app restructured into `src/routes/`, `src/services/`, `src/middleware/`, `src/db/`, and `src/config/`.
- Security hardening: Helmet (CSP / frame controls), auth rate limiting, secure session cookies + `trust proxy`, CSRF on mutating routes, configurable DB TLS verification, removal of the hard-coded OPDS HMAC fallback.
- Auth/authorization Vitest suite covering anonymous / admin access, CSRF rejection, and rate limits.
- Package rename to `portal-v1` and cleanup of unused root HTML / duplicate docs.

## Breaking changes

1. **Build step required.** Run `npm run build` (or `npm start`, which builds first) before launching. Entry point is `dist/index.js`.
2. **Source layout.** Application code lives under `src/`. Root `server.js` / `db.js` are compatibility shims only.
3. **Session cookies.** In production, cookies are `secure: true`, `httpOnly: true`, `sameSite: 'lax'`. Local HTTP needs `COOKIE_SECURE=false` or `NODE_ENV=development`.
4. **CSRF.** Browsers must call `GET /api/csrf-token` and send `X-CSRF-Token` (or `_csrf` / `csrfToken` body field) on POST/PUT/DELETE. Login and password-reset entry points remain exempt.
5. **`SESSION_SECRET` is mandatory.** Startup fails if unset or too weak. OPDS cover signing no longer falls back to `'opds-cover-secret'`.
6. **DB TLS.** `DATABASE_SSL=true` now verifies certificates by default (`DATABASE_SSL_REJECT_UNAUTHORIZED=true`). Set that flag to `false` only when you must use a private CA / local SSL without verification.

## Security fixes

| Area | Change |
|------|--------|
| CSRF | Token middleware on state-changing routes including `/api/admin/*` |
| Cookies | `secure` / `sameSite=lax` / `httpOnly`; `app.set('trust proxy', 1)` |
| Rate limit | `express-rate-limit` on `/auth/login`, Emby Connect login, forgot-password |
| Helmet | CSP + `X-Frame-Options` (via Helmet defaults / frameAncestors) |
| DB TLS | Configurable `rejectUnauthorized` (default verify) |
| HMAC | Removed `'opds-cover-secret'` fallback |

Preserved: server-derived `is_admin`, parameterized SQL via the query builder, `timingSafeEqual` password compares.

## Migration guide

1. Copy `.env.example` → `.env` and set `SESSION_SECRET`, `CONFIG_ENCRYPTION_KEY`, database URL, and scrypt admin hash/salt (see `AGENTS.md`).
2. Apply `portal_schema.sql` (+ `migrations/` if upgrading an older volume).
3. `npm install && npm run build && npm start` (or rebuild the Docker image — the Dockerfile now compiles TypeScript).
4. Update any reverse-proxy / process-manager command that pointed at `server.js` to `node dist/index.js` (shim still works after build).
5. Front-end / clients: send CSRF tokens on mutating API calls. PWA `sw.js` and OPDS paths are unchanged.
6. If sessions break behind TLS termination, confirm `TRUST_PROXY=1` and that the proxy sets `X-Forwarded-Proto`.

## Build note

`tsconfig` uses `module` / `moduleResolution`: `Node16` so `npm run build` and Docker image builds succeed on TypeScript 5.9+.

## Internal / cleanup

- Deleted unused root copies of `dashboard.html`, `seerr.html`, `emby-connect-login.html` (served only from `public/`).
- Removed stale root `env.example` (Discord bot template retains `public/discord-bot-template/env.example`).
- Root `SETUP.md` / `OPERATOR_GUIDE.md` / `UPDATES.md` now point at `docs/`.
- Added `AGENTS.md` with local run / verify steps.
- `package.json` name corrected from `portal-portal-v1` → `portal-v1`.
