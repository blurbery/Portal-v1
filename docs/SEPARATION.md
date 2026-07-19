# Public-build separation

This repository is the provider-neutral Portal-v1 build. It is separate from any private live portal.

## Built-in safety signals

- PUBLIC_BUILD_MARKER.txt identifies this checkout as portal-v1-public.
- npm start runs scripts/start-public-build.sh.
- Startup refuses to run if the marker is absent, .env is missing, PORTAL_BUILD_ID=portal-v1-public is missing, or port 3000 is selected.
- The recommended process name is portal-v1-public, so operators and AI tools can distinguish it from other portal processes.

## Separate installation procedure

Use a dedicated directory that is not shared with another portal. Create a separate .env, Supabase project, database settings, provider accounts, and process-manager entry. Never copy a private portal .env into this checkout.

Example:

```bash
git clone git@github.com:blurbery/Portal-v1.git /opt/portal-v1-public
cd /opt/portal-v1-public
cp .env.example .env
# Edit .env and keep PORTAL_BUILD_ID=portal-v1-public
npm install
npm run check
npm start
```

For PM2, use a distinct name and port:

```bash
pm2 start npm --name portal-v1-public -- start
pm2 save
```

The public build must remain independently configured and must never be deployed over another portal installation.
