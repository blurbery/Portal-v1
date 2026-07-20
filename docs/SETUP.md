# v1 setup

## 1. PostgreSQL

Install PostgreSQL for this Portal instance. From the repository root, run `psql "$DATABASE_URL" -f portal_schema.sql` (or apply `portal_schema.sql` with your PostgreSQL administrator). Keep the database password and other secrets server-side only; the browser must never receive them.

## 2. Environment

On the host, copy `.env.example` to `.env` and set `DATABASE_URL`, `SESSION_SECRET`, `CONFIG_ENCRYPTION_KEY`, `PORTAL_URL`, and the portal administrator values. Add provider credentials only after the corresponding provider is configured.

For Discord portal sign-in, set the callback URL in the Discord Developer Portal to:

`https://YOUR_PORTAL_HOST/auth/discord/callback`

The Discord bot token is not required for portal sign-in. Keep bot runtime variables in the separate bot project’s host environment.

## 3. Local verification

```bash
npm install
npm run check
npm start
```

Open `http://localhost:3000` and complete the administrator setup.

## 4. Private GitHub workflow

```bash
git init
git add .
git status
git commit -m "Initial Portal v1 build"
git branch -M main
git remote add origin git@github.com:YOUR_ACCOUNT/YOUR_PRIVATE_REPO.git
git push -u origin main
```

Create the repository as private before pushing. Review `git diff --cached` and run a secret scanner before every push.

## Library configuration

After the first administrator login, open Administration → Library Configuration and configure the installation’s library providers:

1. Enter the BookWarehouse Base URL. The Portal normalizes a URL that omits the trailing `/api/v1` path.
2. Enter the BookWarehouse API key and use **Test Connection**. The test uses the values currently in the form and does not save them.
3. Select **Save Library Configuration**. Provider values are written to encrypted PostgreSQL settings and are loaded into the server runtime after saving.
4. Add optional Hardcover, ComicVine, or Google Books keys only if those services are available. They enrich search and request metadata; BookWarehouse remains the catalogue source.
5. Set **Books Directory** only when this installation uses a local folder for imported or downloaded files.
6. In Feature switches, enable Library plus the required ebooks, audiobooks, or comics features. In Permissions & Announcements, enable access for the relevant Emby, Silo, Plex, or Jellyfin member groups.

A successful configuration-card test confirms that the Portal can reach BookWarehouse with the supplied key. It does not validate every catalogue, cover, download, or external enrichment operation, which should be checked against the operator’s live provider after deployment. Keep all provider URLs and keys out of `.env.example`, source control, screenshots, and support logs.

## Seerr request configuration

Seerr is optional and must be installed and configured separately. After the Portal administrator login:

1. Open Administration → Requests & metadata.
2. Enter the reachable Seerr URL and Seerr API key, then select **Test Seerr connection**. The test checks Seerr status with the key currently in the form and does not save values.
3. Select **Save Seerr settings**, enable **Seerr**, and enable **Requests navigation**.
4. Enable the request areas needed by the installation: Movies, Shows, My requests, or Issue reports.
5. Enable member access only for services whose provider URL and credentials are already configured: Emby, Silo, Plex, or Jellyfin.

The Portal uses Seerr for request search, approvals, downloads, and status tracking. Seerr’s own media-server integrations, download clients, libraries, and user permissions remain configured in Seerr. The Portal card does not provision those services. A successful status test is not a complete request-flow test; submit a safe test request after deployment and confirm the resulting status link.

Keep `SEERR_URL`, `SEERR_API_KEY`, and provider credentials in encrypted PostgreSQL settings or the uncommitted host environment. Never add them to `.env.example`, source control, screenshots, or logs.

## Updates

Pull updates into a staging directory, back up `.env` and the database, run `npm run check`, then restart the process. Do not overwrite the live/private portal from this repository without a tested migration plan.

## Required configuration

Copy `.env.example` to `.env` and set the PostgreSQL connection values before starting the server. The schema is `portal_schema.sql`. Docker Compose applies it automatically when the PostgreSQL volume is created; for a non-Docker install, apply it with `psql` before starting the Portal.

After the first admin login, configure General Settings, Authentication & Access, Media Servers, Permissions & Announcements, and then the separate Discord Bot card. The Bot card reads the shared Discord Server ID from Authentication & Access. Enter announcement channel IDs and allowed media-server role IDs explicitly.

Emby and Silo are the active provider paths. Plex and Jellyfin may be stored as provider configuration, but must not be presented as fully operational without their tested user/session bridges.
