# Portal Portal — GitHub Build v1

This is a separate, provider-neutral v1 build. It is not the private live portal and does not contain the owner’s credentials, API keys, Discord IDs, private domains, or personal server addresses. All installation-specific values belong in environment variables or the encrypted PostgreSQL settings table.

## Important boundary

Do not copy private portal changes directly into this repository. Keep the portal integration contract intact: authentication, provider configuration, PostgreSQL table names, /api/* routes, and the member-session shape are shared interfaces. Extend those interfaces deliberately and add a migration/documentation entry for every change.

v1 is a clean provider-neutral deployment. Do not add owner-specific sync jobs, private library backends, private Portal integrations, or installation-specific defaults to this repository.

## Quick start

1. Clone the repository locally or download the public-safe release.
2. Copy .env.example to .env and fill only the values for this installation.
3. Create the PostgreSQL schema by following docs/SETUP.md.
4. Run npm install and npm run check.
5. Start with npm start, or use the process manager provided by your host.

## Docker quick start

Docker is the recommended distribution path for independent operators:

```bash
git clone git@github.com:blurbery/Portal-v1.git /opt/portal-v1-public
cd /opt/portal-v1-public
cp .env.example .env
# Set the database password in docker-compose.yml and configure .env.
docker compose -p portal-v1-public up -d --build
```

The public-safe container uses the distinct service name portal-v1-public, host port 3100, and explicit public-build labels. See docs/DOCKER.md for updates and troubleshooting. Never commit .env, bot tokens, provider API keys, OAuth client secrets, service-role keys, or password hashes.

## Operator isolation

Each operator must create and use their own PostgreSQL project, Discord application, provider accounts, environment variables, and encrypted settings. Invited GitHub collaborators receive the distributable source only; never share the private portal’s .env, database, bot configuration, credentials, domains, or server details.

## Included

- Admin-configured portal settings stored encrypted in PostgreSQL.
- Discord, WHMCS and Emby Connect authentication switches.
- Configurable Emby, Silo, Jellyfin and Plex provider slots.
- Announcements, role routing, member/sub-user session handling, and optional Seerr configuration.
- PostgreSQL and hosting-provider deployment instructions.

Read [docs/OPERATOR_GUIDE.md](docs/OPERATOR_GUIDE.md) for the system map, configuration order, service-linking flow, and verification checklist. The static route and runtime checklist is in [docs/INTEGRATION_AUDIT.md](docs/INTEGRATION_AUDIT.md). Also see docs/SETUP.md, docs/SECURITY.md, docs/DOCKER.md, and docs/UPDATES.md before installing.
