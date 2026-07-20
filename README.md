# Portal Portal — GitHub Build v1

This is a separate, provider-neutral v1 build. It is not the private live portal and does not contain the owner’s credentials, API keys, Discord IDs, private domains, or personal server addresses. All installation-specific values belong in environment variables or the encrypted PostgreSQL settings table.

## Important boundary

Do not copy private portal changes directly into this repository. Keep the portal integration contract intact: authentication, provider configuration, PostgreSQL table names, /api/* routes, and the member-session shape are shared interfaces. Extend those interfaces deliberately and add a migration/documentation entry for every change.

v1 is a clean provider-neutral deployment. Do not add owner-specific sync jobs, private library backends, private Portal integrations, or installation-specific defaults to this repository.

## Installation at a glance

Portal has two supported deployment modes:

- **Docker Compose (recommended):** runs Portal and PostgreSQL together, applies `portal_schema.sql` on the first database-volume creation, and exposes Portal on host port `3100`.
- **Node.js plus external PostgreSQL:** use Node.js 20+, apply the schema manually, and run Portal behind your own process manager and reverse proxy.

Before starting, you need a PostgreSQL database, a long random `SESSION_SECRET`, a long random `CONFIG_ENCRYPTION_KEY`, and a bootstrap administrator username/password hash. Provider credentials are optional and should be added only after the first administrator login.

### Docker installation

```bash
git clone https://github.com/blurbery/Portal-v1.git /opt/portal-v1-public
cd /opt/portal-v1-public
cp .env.example .env
# Edit .env: PORTAL_URL, secrets, and any provider values you need.
docker compose -p portal-v1-public up -d --build
docker compose -p portal-v1-public ps
curl -fsS http://127.0.0.1:3100/api/health
```

The first Docker start creates the named PostgreSQL volume and applies `portal_schema.sql`. If the volume already exists, schema changes must be applied through the documented migration process; do not delete a production volume to retry setup.

### Node.js installation

```bash
cp .env.example .env
# Set DATABASE_URL, PORTAL_URL, SESSION_SECRET, CONFIG_ENCRYPTION_KEY,
# PORTAL_ADMIN_USERNAME, PORTAL_ADMIN_PASSWORD_HASH, and PORTAL_ADMIN_PASSWORD_SALT.
psql "$DATABASE_URL" -f portal_schema.sql
npm install
npm run check
npm start
```

Put a reverse proxy with HTTPS in front of the Node process before exposing it to the internet. See [docs/SETUP.md](docs/SETUP.md) for the complete checklist and [docs/DOCKER.md](docs/DOCKER.md) for Docker operations. Never commit `.env`, bot tokens, provider API keys, OAuth client secrets, service-role keys, password hashes, or OPDS URLs containing credentials.

## Operator isolation

Each operator must create and use their own PostgreSQL project, Discord application, provider accounts, environment variables, and encrypted settings. Invited GitHub collaborators receive the distributable source only; never share the private portal’s .env, database, bot configuration, credentials, domains, or server details.

## Included

- Admin-configured portal settings stored encrypted in PostgreSQL.
- Discord OAuth and Emby Connect authentication switches; WHMCS is currently an external SSO-bridge entry point, not a complete Portal callback integration.
- Configurable Emby, Silo, Jellyfin and Plex provider slots.
- Announcements, role routing, member/sub-user session handling, and optional Seerr configuration.
- PostgreSQL and hosting-provider deployment instructions.

Read [docs/OPERATOR_GUIDE.md](docs/OPERATOR_GUIDE.md) for the system map, configuration order, service-linking flow, and verification checklist. The static route and runtime checklist is in [docs/INTEGRATION_AUDIT.md](docs/INTEGRATION_AUDIT.md). Also see docs/SETUP.md, docs/SECURITY.md, docs/DOCKER.md, and docs/UPDATES.md before installing.


## Public PostgreSQL installation

The supported public release is self-hosted PostgreSQL plus the Portal container. Apply portal_schema.sql, copy .env.example to .env, configure PostgreSQL, and run docker compose -p portal-v1-public up -d --build. Verify /api/health reports database: ok.

Configure General Settings, Authentication & Access, Media Servers, Permissions & Announcements, and then the separate Discord Bot card. The Bot card reuses the single shared Discord Server ID from Authentication & Access. Download one complete bot archive and run npm register after first deployment and after command/provider changes. Lifetime parents own a stream pool for linked sub-users; Plex and Jellyfin remain adapter slots until their tested bridges exist.


## Library media flow

The public library actions are wired by media type: eBooks are converted to EPUB with Calibre and open in Portal's reader, audiobooks stream through Portal's mobile-friendly audio player and remain downloadable, and comics use Kavita for the rich reader/OPDS experience. Configure Kavita in the Library administration card; see [docs/OPERATOR_GUIDE.md](docs/OPERATOR_GUIDE.md) for the OPDS setup.


## First-launch checklist

1. Confirm `GET /api/health` reports the database as healthy.
2. Sign in with the bootstrap administrator account.
3. Set General Settings, especially the canonical `PORTAL_URL`.
4. Configure Authentication & Access, then Media Servers.
5. Configure Permissions & Announcements and enable only the member groups that should see each feature.
6. Configure Library, Requests & metadata, and Kindle delivery only when those services are installed.
7. Download and deploy the generated Discord bot separately; run its command registration after the first deployment and after command/provider/pricing changes.
8. Test one login, one provider link, one library search/download, one request if enabled, one Kindle send if enabled, and one announcement before inviting members.

The Portal does not install Emby, Silo, Jellyfin, Plex, BookWarehouse, Shelfmark, Kavita, Seerr, SMTP, or Discord. Those are separate services that the operator owns and configures. The Portal stores their settings and provides the integration routes.

## Admin and recovery email

The **Admin & Recovery Email** card is a provider-configurable delivery path for member account recovery, subscription-expiry reminders, and private support notifications. It is separate from the Kindle delivery card.

Configure:

1. A Resend API key with permission to send.
2. A verified sender address on a verified Resend domain.
3. A private support inbox for issue reports.

Use **Test Connection** before saving to verify the selected provider. For Resend it checks the API key and sender domain; for SMTP it verifies the connection and authentication. The test does not send an email. After saving, verify the live flow by setting a member recovery address under Account, requesting a password reset from the sign-in page, and confirming the link arrives and expires as documented. The recovery email is never shown to other members. The card does not reset the bootstrap Portal administrator password; administrators change that under Administration → Administrator Accounts.

When SMTP is selected, configure the SMTP host, port, security mode, username/password if required, sender address, and private support inbox in the Admin & Recovery Email card. Port 587 normally uses STARTTLS with SSL/TLS off; port 465 normally uses SSL/TLS with it enabled. The card’s Test Connection verifies SMTP with `transporter.verify()` and sends no message.

## Administrator account lifecycle

The first Portal login is bootstrapped from `PORTAL_ADMIN_USERNAME`, `PORTAL_ADMIN_PASSWORD_SALT`, and `PORTAL_ADMIN_PASSWORD_HASH` in the host environment. After signing in, open Administration → Administrator Accounts and save the **Primary Administrator** with the username and password you want to keep. Portal stores that credential record encrypted in PostgreSQL and then stops accepting the old environment bootstrap login. Additional administrator logins are stored in the same encrypted settings record.

Back up PostgreSQL and the host `.env` separately. The `.env` bootstrap values are needed to recover access if the settings database has not yet been initialized; once a primary administrator is saved, use the stored primary login. Changing the primary administrator does not change member or media-server accounts.

## Users card and provider support

Administration → Users is the shared management view for provider accounts stored in PostgreSQL. Emby and Silo are the supported public account-provisioning paths: accounts created from the Users card or the Discord bot are written to the same provider tables, so they appear in the same tabs and share the same parent/sub-user and expiry records. A Discord user ID is required when creating an account manually so Portal and bot identity remain linked.

Plex and Jellyfin tabs may appear when their server credentials are configured, but they are configuration/adapter slots only in this release. Their native account-creation and session bridges are not complete, and the Discord bot must not be treated as a supported Plex/Jellyfin provisioning path. Do not enable those member flows until their provider bridges are implemented and tested.


## Profile recovery email

The Profile → Recovery Email card stores a member-owned recovery address on the linked Emby or Silo account. The sign-in page's Forgot Password flow looks up that address, creates a 30-minute single-use token, and sends the reset link through the configured **Admin & Recovery Email** provider. The reset page verifies the token, asks Emby to change the password, and only then updates the Portal record and consumes the token.

Admin mail supports either Resend or SMTP. SMTP uses the Admin card's host, port, security, credentials, and sender; Kindle SMTP settings are separate. The request response intentionally does not reveal whether an address exists. Plex/Jellyfin are not included because their account bridges are not implemented.
