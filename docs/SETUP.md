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

## 4. Choose the deployment mode

For Docker, follow [docs/DOCKER.md](DOCKER.md) and run:

```bash
docker compose -p portal-v1-public up -d --build
docker compose -p portal-v1-public ps
curl -fsS http://127.0.0.1:3100/api/health
```

For Node.js, apply `portal_schema.sql`, run `npm install`, `npm run check`, and start with `npm start`. Keep the process behind HTTPS and configure backups for both `.env` and PostgreSQL. This public repository is not a private production deployment; do not copy a private portal directory or credentials over it.

## Updates

Pull updates into a staging directory, back up `.env` and the database, run `npm run check`, then restart the process. Do not overwrite the live/private portal from this repository without a tested migration plan.

## Required configuration

Copy `.env.example` to `.env` and set the PostgreSQL connection values before starting the server. The schema is `portal_schema.sql` and is required for a new public PostgreSQL database.

After the first admin login, configure General Settings, Authentication & Access, Media Servers, Permissions & Announcements, and then the separate Discord Bot card. The Bot card reads the shared Discord Server ID from Authentication & Access. Enter announcement channel IDs and allowed media-server role IDs explicitly.

Emby and Silo are the active provider paths. Plex and Jellyfin may be stored as provider configuration, but must not be presented as fully operational without their tested user/session bridges.


## Complete post-install checklist

### Required bootstrap values

Set these before starting Portal:

- `DATABASE_URL` (or use the Compose-generated connection)
- `SESSION_SECRET`
- `CONFIG_ENCRYPTION_KEY`
- `PORTAL_URL`
- `PORTAL_ADMIN_USERNAME`
- `PORTAL_ADMIN_PASSWORD_SALT`
- `PORTAL_ADMIN_PASSWORD_HASH`

The password hash is one-way; never put the original password in Git. Keep `.env` readable only by the service account.

### Administration order

After the first login, configure cards in this order:

1. **General Settings:** name, canonical URL, logo, and favicon.
2. **Authentication & Access:** enable login providers and configure the shared Discord guild/server ID.
3. **Media Servers:** configure only services this installation owns, then verify provider status.
4. **Permissions & Announcements:** set role/channel rules and feature visibility.
5. **Library Configuration:** BookWarehouse is the catalogue/download source; add Shelfmark, metadata keys, and Kavita only when installed.
6. **Requests & metadata:** configure Seerr and test a safe request if enabled.
7. **Kindle delivery:** configure SMTP or Resend, set the member Kindle address in the profile, approve the sender in Amazon, and send a test book.
8. **Discord Bot:** download the generated archive, create its host `.env`, run `npm install`, `npm run register`, then start the bot separately.

### Library-specific setup

BookWarehouse must be reachable from the Portal container. The Portal converts supported ebook downloads to EPUB with Calibre, opens them in the Portal reader, and can send the EPUB to Kindle. Audiobooks use the Portal’s authenticated range-enabled player and remain downloadable.

Kavita is the recommended comic backend for comic apps. In Kavita, copy the user OPDS URL from Preferences → OPDS and enter it as `KAVITA_OPDS_URL`, or configure `KAVITA_URL` and `KAVITA_API_KEY`. The authenticated Portal route `GET /api/library/kavita/opds` returns the configured URL for a signed-in member. Treat that URL as a credential. It is separate from Portal’s own `/opds/*` routes.

### Operational verification

Run these checks after installation:

```bash
docker compose -p portal-v1-public ps
curl -fsS http://127.0.0.1:3100/api/health
docker compose -p portal-v1-public logs --tail=200 portal-v1-public
```

Then verify administrator login, member login, provider linking, navigation gating, library access, requests if enabled, Kindle delivery if enabled, bot command registration, and PostgreSQL backups.

### Seerr navigation and issues

When Seerr is enabled, the member sidebar shows a **Requests** dropdown above **Library**. It links to Discover, Movies, TV Shows, My Requests, and My Issues. The homepage Search/Request buttons are intentionally not used; library searches and requests remain in their dedicated Library categories.

### Install Seerr separately

Seerr is a required companion service for the Portal request features; it is not bundled into the Portal container. Run one shared Seerr installation for the shared content pool, preferably on the same private network as the Portal, Radarr, Sonarr, and storage services. For example:

```bash
mkdir -p /opt/seerr/config
docker run -d --name seerr --init \
  -e LOG_LEVEL=info \
  -e TZ=Australia/Sydney \
  -e PORT=5055 \
  -p 5055:5055 \
  -v /opt/seerr/config:/app/config \
  --restart unless-stopped \
  ghcr.io/seerr-team/seerr:latest
```

After Seerr starts, open its setup page and configure the media-server integration and user defaults. Under **Settings → Users**, set Default Permissions to include normal requests, and enable new provider sign-in or import the users from the configured media server. Portal users sign in to Portal; they do not need Seerr passwords.

Under **Seerr → Settings → Services**, add every Radarr and Sonarr instance that Seerr can use. Generate each service API key in that service’s own security settings, then enter its URL, API key, quality profile, root folder, and 4K setting in Seerr. Do not put Radarr/Sonarr keys in the Portal `.env` unless you are using the legacy fallback. Portal’s Administration → Seerr card reads the configured services from Seerr and can submit new service connections to Seerr.

In Portal, open **Administration → Seerr**, enter the Seerr URL reachable from the Portal container and the Seerr API key from Seerr’s general settings, then test and save. For multiple trusted portals sharing one content pool, point every Portal at this same Seerr URL. This gives them one request history and prevents duplicate requests. The Seerr API key grants administrative access, so share it only with Portal installations you control and never expose it to members.

Seerr's **My Issues** area is for media/request issues handled by Seerr. **Portal Issues** is for Portal itself, account access, playback, or general service-support problems. The Portal page calls Seerr through the server-side API proxy; members do not leave Portal or receive the Seerr API key.

Portal issue reports, BookWarehouse library requests, Seerr request records, and Seerr issue records are stored or mirrored in the Portal PostgreSQL database. Portal links each member to Seerr through the linked media-provider identity and can provision a server-only Seerr user when necessary. Seerr remains the media backend, while Portal is the member-facing interface.

The Portal-native Seerr flow is server-hosted. In Administration → Seerr, use the three tabs:

- **Seerr:** set the Seerr URL and API key, then test the connection.
- **Radarr & Sonarr:** Portal reads the configured Radarr/Sonarr instances from Seerr. Use **Add instance** to submit a service URL and its service API key to Seerr; Portal never displays the key back to members. Seerr remains the owner of the server, 4K flag, quality profile, root folder, and download orchestration. Add each Radarr/Sonarr instance to Seerr once, including separate 4K, anime, international, or sports services where applicable.
- **Portal Permissions:** enable requests, movie/TV requests, personal history, media issues, and the linked provider memberships that may use Seerr.

The equivalent environment values are `SEERR_URL`, `SEERR_API_KEY`, the legacy `RADARR_URL`/`RADARR_API_KEY` and `SONARR_URL`/`SONARR_API_KEY` fallback, `SEERR_ENABLED=true`, `REQUESTS_ENABLED=true`, and the relevant request switches. Portal stores only encrypted permissions and routing metadata in PostgreSQL; Seerr stores the connected service credentials. Enable 4K and 4K DV permissions only for the memberships or Discord roles that should request them, and mark the matching Seerr server as 4K with the correct quality profile and root folder. The Seerr, Radarr, Sonarr, and Sportarr API keys stay server-side and are never sent to members. Portal identity is based on the linked media-provider type and user ID, with the provider username as a fallback; Portal does not require a recovery email for requests.

The Portal page uses Seerr's server API for Discover, search, movie/TV details, requests, and media issues. **My Requests** and **My Issues** are filtered to the linked Seerr user. Before creating a request, Portal checks Seerr's live request list and refuses a duplicate when the title is already requested or available. If the linked media-provider user has not yet been imported into Seerr, Portal creates a server-only Seerr local user with a generated password and the Seerr default member permissions; that password is never shown or copied from Portal. Portal mirrors returned activity in `seerr_history`, but Seerr remains authoritative for live request and issue workflow state.

### Media-provider identity linking

Portal does not use recovery email as the request identity. A member is linked to Seerr using the stable Emby, Jellyfin, or Plex user ID stored in the Portal session, then the provider username as a fallback. Configure Seerr with the same media server and set its default member permissions to include normal requests before enabling automatic provisioning. For Jellyfin and Plex, importing users into Seerr is also supported; Emby users can be provisioned as Portal-managed local Seerr users while Portal remains the only member-facing login.

### Multiple portals sharing one content pool

For two trusted Portal installations that use the same Radarr/Sonarr services and storage, configure both portals with the same `SEERR_URL` and Seerr API key. They will share Seerr's request database: a request submitted in Portal A is visible in Portal B and cannot be submitted again. Both portals should use the same Seerr server IDs and 4K configuration. The API key grants administrative Seerr access, so only share it between installations you control. Separate Seerr installations do not share request history and can create duplicates even when their Radarr/Sonarr services point at the same files.

For an existing PostgreSQL volume, apply the additive migration once from the repository root after backing up the database:

```bash
docker compose -p portal-v1-public exec -T db psql -U portal -d portal < migrations/002-seerr-portal-flow.sql
```

New installations receive the two tables from `portal_schema.sql`. Do not delete or recreate the PostgreSQL volume during this migration.

## Admin and recovery email

The **Admin & Recovery Email** card is separate from **SMTP Configuration**, which is used for Kindle delivery. The Admin card supports Resend or another SMTP provider for Portal-generated mail.

Configure it after the first administrator login:

1. Open Administration → Admin & Recovery Email.
2. Enter an Admin Resend API key.
3. Enter a sender address on a verified Resend domain.
4. Enter the private support inbox that should receive issue reports.
5. Select **Test Connection**. This checks Resend authentication and the sender domain but intentionally sends no message.
6. Save the card.

Member recovery is configured by each member under Account → Recovery Email. The sign-in page’s password-reset flow matches that address, creates a single-use token that expires after 30 minutes, and sends the link using the Admin sender. Subscription-expiry reminders use the same sender and the member’s recovery address. Issue reports are sent to the private support inbox, with the member recovery address used as reply-to when available.

Test the live flow after deployment with a non-production member account: save a recovery address, request a reset, use the emailed link once, confirm it cannot be reused, and confirm an expired link is rejected. The Admin card does not reset the bootstrap Portal administrator password; use Administration → Administrator Accounts for that password.

If the installation still has legacy RESEND_API_KEY and RESEND_FROM_EMAIL settings, use **Use Current Resend Setup** once from the Admin & Recovery Email card, then save the new separated settings. Never commit the key, sender credentials, recovery addresses, or support inbox to Git.

### Choosing Resend or SMTP

For Resend, enter the API key and a sender on a verified domain. For SMTP, select **Other SMTP** and enter the host, port, security mode, username, password or app password, sender, and support inbox. Use port 587 with SSL/TLS off for STARTTLS, or port 465 with SSL/TLS enabled. **Test Connection** verifies the selected provider and intentionally sends no email. After saving, test an actual recovery message with a non-production member account.

## Administrator account lifecycle

Before the first launch, set the bootstrap values in the host `.env`: `PORTAL_ADMIN_USERNAME`, `PORTAL_ADMIN_PASSWORD_SALT`, and `PORTAL_ADMIN_PASSWORD_HASH`. These values provide the initial portal-only administrator login while PostgreSQL has no saved primary administrator.

After the first login:

1. Open Administration → Administrator Accounts.
2. Under **Primary Administrator**, enter the permanent portal administrator username and password.
3. Select **Save Primary Admin**.
4. Sign out and sign back in with the saved credentials.
5. Confirm the old bootstrap credentials no longer authenticate.
6. Add additional administrators only when needed; they receive separate portal-only logins.

The saved primary and additional administrator records are encrypted in PostgreSQL under `portal_settings`. The primary administrator cannot be removed from the card. Do not delete the database row or rotate `CONFIG_ENCRYPTION_KEY` without a migration/backup plan. Changing Portal administrators does not change member accounts, provider accounts, Discord users, or media-server passwords.

If the database has not been initialized, the `.env` bootstrap login remains the recovery path. Once a saved primary record exists, the old bootstrap login is intentionally disabled.

## Authentication provider status

### Discord

Discord is a complete OAuth path in the public build. Set `AUTH_DISCORD_ENABLED=true`, the Discord client ID/secret, and the exact callback `https://YOUR_PORTAL_HOST/auth/callback`. Set the guild and allowed role IDs only when access should be restricted by Discord membership roles.

### Emby Connect

Emby Connect is a complete public login path when Emby is configured. Set `EMBY_URL` or `EMBY_DIRECT_URL` and `EMBY_API_KEY`, enable `AUTH_EMBY_CONNECT_ENABLED`, and use the callback generated from the Emby server URL. Each member must first save the same Emby Connect email in their Portal profile. Portal sends the entered password to Emby Connect for verification, matches the verified email to the member's stored Emby `connect_email`, and creates the Portal session; it does not store the Connect password. Test both the profile-link action and a fresh sign-in.

### WHMCS

WHMCS is not a complete native Portal authentication provider in this public release. The card only exposes an external entry URL through `/auth/whmcs`; the public server does not implement a WHMCS callback, OAuth token exchange, WHMCS user lookup, or Portal session creation. Leave it disabled unless you have an installation-specific WHMCS SSO bridge that handles those steps and returns users through a separately implemented Portal-compatible session flow. The WHMCS client ID/secret fields are reserved and are not consumed by the public runtime.


## Users card and Discord account flow

Open Administration → Users after configuring the provider under Media Servers. The public account-management flow is:

1. Configure Emby or Silo URL/API credentials.
2. Open the matching Users tab; the tab is enabled when the provider is configured or has saved accounts.
3. Create a parent account with a Discord user ID, username, password, stream limit, and expiry/lifetime choice.
4. Confirm the account appears in the provider table and can be edited or deleted from both the provider and PostgreSQL.
5. For a Lifetime parent, create linked sub-users only within the displayed pool and five-sub-user limit.
6. For Discord provisioning, save the Discord Bot card, download a fresh bundle, provide the same provider credentials and PostgreSQL URL on the bot host, register commands, and test a trial/paid account. Bot-created Emby/Silo records appear in the same Users tabs.

Plex and Jellyfin tabs are intentionally marked as pending. They expose configuration visibility only; native account provisioning, session linking, and supported Discord-bot account creation are not complete in this public release. Do not use those tabs as proof that the provider is operational.


## Profile recovery and Forgot Password

The member flow is linked end to end for Emby- and Silo-backed accounts:

1. The member opens Dashboard → Account → Recovery Email and saves an address.
2. At the sign-in page, the member selects **Forgot Password** and submits that same address.
3. Portal creates a token valid for 30 minutes and sends it through the configured Admin & Recovery Email provider.
4. The member opens the reset link, chooses a password of at least six characters, and submits it.
5. Portal changes the password on the selected media server first; only after that provider accepts it does Portal update PostgreSQL and clear the token.
6. The token is single-use and cannot be reused after a successful reset.

The Admin mail provider may be Resend or SMTP. For SMTP, configure the Admin & Recovery Email card—not the separate Kindle SMTP card—and use port 587 with STARTTLS or port 465 with SSL/TLS as appropriate. Test the actual recovery flow with a non-production Emby account after saving the provider settings. Plex/Jellyfin are not included because their account bridges are not implemented.


## Linked Media Servers

The Add-service list is populated from the providers configured in Administration → Media Servers. A provider is considered available only when its required URL and server credential/API key are saved. If none are configured, the modal shows a provider-neutral warning.

The portal administrator can link or unlink the administrator's service credentials. Ordinary members can sign in only through configured/available provider paths and cannot link arbitrary service credentials or unlink the administrator's connection. Configure and test the provider before inviting members.

## Media server health configuration

After saving a provider under **Administration → Media Servers**, open **Administration → Media Server Health** and enter that provider's health endpoint. Configure only endpoints that the Portal host can reach; health requests use the provider credential already saved for that server. A server without both provider configuration and a health endpoint is not monitored.

The monitor runs every 30 seconds. It requires three consecutive failed checks before showing a server as offline and two consecutive successful checks before resolving the incident. The homepage notification bell shows the provider name, offline start time, and elapsed duration. Members receive only the downtime for providers attached to their Portal account; the portal administrator sees all configured monitored providers. Clear the provider configuration or its health endpoint to stop monitoring it.

The current public implementation keeps health events in process memory, so restart the Portal after a deployment and use external monitoring if you need durable incident history.
