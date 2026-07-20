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
git clone https://github.com/blurbery/Portal-v1.git /opt/portal-v1-public
cd /opt/portal-v1-public
cp .env.example .env
# Set the database password in docker-compose.yml and configure .env.
docker compose -p portal-v1-public up -d --build
```

The public-safe container uses the distinct service name portal-v1-public, host port 3100, and explicit public-build labels. See docs/DOCKER.md for updates and troubleshooting. Never commit .env, bot tokens, provider API keys, OAuth client secrets, service-role keys, or password hashes.

## Library configuration

After the first administrator login, open Administration → Library Configuration. Configure the required BookWarehouse connection first:

- **BookWarehouse Base URL**: the BookWarehouse API URL for this installation. If the URL does not end in `/api/v1`, the Portal adds that path automatically.
- **API Key**: the installation’s BookWarehouse API key. It is stored encrypted in PostgreSQL and is never returned in normal browser configuration responses.
- **Test Connection**: checks the URL and key currently in the form without saving them.

Select **Save Library Configuration** after the connection test succeeds. Hardcover, ComicVine, and Google Books are optional search-enrichment services; they improve covers, descriptions, and request metadata but do not replace BookWarehouse. **Books Directory** is an optional local path for imported or downloaded files and is not a remote provider connection.

Library availability is controlled separately by the Feature switches and Permissions & Announcements cards. Enable the required Library, ebooks, audiobooks, or comics features and grant access to the relevant member services. A live provider test still requires a reachable BookWarehouse deployment and valid credentials; do not commit those values to Git.

## Seerr request configuration

Seerr is an optional, separately hosted request service. After the first administrator login, open Administration → Requests & metadata:

1. Set **Seerr URL** to the reachable Seerr web/API address and enter the Seerr API key. The Portal sends the key server-side as `X-Api-Key`.
2. Use **Test Seerr connection**. The test checks Seerr status and does not save changes.
3. Enable **Seerr** and **Requests navigation**, then enable the request areas required by this installation: Movies, Shows, My requests, or Issue reports.
4. Enable only the member-service access switches whose configured users should see Requests. The relevant Emby, Silo, Plex, or Jellyfin provider URL and credentials must already be configured.

The Portal links members into Seerr for catalogue search, approvals, downloads, and status tracking; it does not replace Seerr’s own media-server, downloader, or library configuration. Keep the URL, API key, and provider credentials out of source control. A successful connection test confirms reachability and authentication only; verify an actual request flow against the live Seerr installation after deployment.

## Operator isolation

Each operator must create and use their own PostgreSQL project, Discord application, provider accounts, environment variables, and encrypted settings. Invited GitHub collaborators receive the distributable source only; never share the private portal’s .env, database, bot configuration, credentials, domains, or server details.

## Included

- Admin-configured portal settings stored encrypted in PostgreSQL.
- Discord, WHMCS and Emby Connect authentication switches.
- Configurable Emby, Silo, Jellyfin and Plex provider slots.
- Announcements, role routing, member/sub-user session handling, and optional Seerr configuration.
- PostgreSQL and hosting-provider deployment instructions.

Read [docs/OPERATOR_GUIDE.md](docs/OPERATOR_GUIDE.md) for the system map, configuration order, service-linking flow, and verification checklist. The static route and runtime checklist is in [docs/INTEGRATION_AUDIT.md](docs/INTEGRATION_AUDIT.md). Also see docs/SETUP.md, docs/SECURITY.md, docs/DOCKER.md, and docs/UPDATES.md before installing.


## Public PostgreSQL installation

The supported public release is self-hosted PostgreSQL plus the Portal container. Apply portal_schema.sql, copy .env.example to .env, configure PostgreSQL, and run docker compose -p portal-v1-public up -d --build. Verify /api/health reports database: ok.

Configure General Settings, Authentication & Access, Media Servers, Permissions & Announcements, and then the separate Discord Bot card. The Bot card reuses the single shared Discord Server ID from Authentication & Access. Download one complete bot archive and run npm register after first deployment and after command/provider changes. Lifetime parents own a stream pool for linked sub-users; Plex and Jellyfin remain adapter slots until their tested bridges exist.
