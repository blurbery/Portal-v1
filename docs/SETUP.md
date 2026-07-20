# v1 setup

## 1. PostgreSQL

Install PostgreSQL for this Portal instance. From the repository root, run `psql "$DATABASE_URL" -f portal_schema.sql` (or apply `portal_schema.sql` with your PostgreSQL administrator). Keep the database password and other secrets server-side only; the browser must never receive them.

## 2. Environment

On the host, copy `.env.example` to `.env` and set `DATABASE_URL`, `DATABASE_URL`, `SESSION_SECRET`, `CONFIG_ENCRYPTION_KEY`, `PORTAL_URL`, and the portal administrator values. Add provider credentials only after the corresponding provider is configured.

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

## Updates

Pull updates into a staging directory, back up `.env` and the database, run `npm run check`, then restart the process. Do not overwrite the live/private portal from this repository without a tested migration plan.

## Required configuration

Copy `.env.example` to `.env` and set the PostgreSQL connection values before starting the server. The schema is `portal_schema.sql`; `portal_settings.sql` is not required for the public PostgreSQL build.

After the first admin login, configure General Settings, Authentication & Access, Media Servers, Permissions & Announcements, and then the separate Discord Bot card. The Bot card reads the shared Discord Server ID from Authentication & Access. Enter announcement channel IDs and allowed media-server role IDs explicitly.

Emby and Silo are the active provider paths. Plex and Jellyfin may be stored as provider configuration, but must not be presented as fully operational without their tested user/session bridges.
