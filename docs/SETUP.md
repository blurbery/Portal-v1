# v1 setup

## 1. PostgreSQL

Create a new PostgreSQL project. In SQL Editor, run `portal_settings.sql`. Keep the database service key server-side only. The browser must never receive it.

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

