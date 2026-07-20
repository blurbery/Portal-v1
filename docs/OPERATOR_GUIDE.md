# Portal operator guide

This guide explains what the public Portal build does, how its parts connect, and where an operator configures each part.

## System map

```
Browser
  -> Express server (server.js)
      -> PostgreSQL (encrypted settings, account records, announcements)
      -> configured media providers (Emby, Silo, Jellyfin, Plex)
      -> optional Discord OAuth and bot
      -> optional library/request providers
```

The browser talks to the server through the `/api/*` routes. Provider credentials and installation values stay on the server; they are not placed in browser code.

## Main areas

| Area | Purpose | Main configuration |
| --- | --- | --- |
| Authentication | Portal admin password, Discord sign-in, member access | `.env`, Admin → Authentication |
| Core | Portal name, URL, links, session settings | `.env`, Admin → General Settings |
| Media servers | Configure provider endpoints and link an existing service account | `.env`, Admin → Media Servers |
| Account | View profile, recovery details, and linked media servers | Dashboard → Account |
| Announcements | Publish messages to members | PostgreSQL settings and Admin |
| Users | Review and manage member/sub-user records | PostgreSQL account tables and Admin |
| Discord bot | Optional slash commands and member integration | `public/discord-bot-template/` and generated bot settings |
| Libraries | Optional books, comics, audiobooks, and request integrations | `.env` and Admin → Library |
| Docker | Isolated runtime for the public build | `Dockerfile`, `docker-compose.yml` |

## How service linking works

1. An operator configures a supported provider in the installation environment.
2. The portal checks provider configuration through `GET /api/provider-status`.
3. The administrator signs in with an existing provider account.
4. The server verifies those credentials with the selected provider.
5. The link is stored encrypted in PostgreSQL `portal_settings`.
6. Account → Linked Media Servers reads the linked records and displays only what is actually connected.

A provider must be configured before it appears in “Add a service”. The public UI does not create provider accounts or copy provider credentials into the repository.

## Configuration order

1. Create a PostgreSQL project and run `portal_schema.sql`.
2. Copy `.env.example` to `.env`.
3. Set the local admin username, password hash, password salt, session secret, and encryption key.
4. Set the installation's `PORTAL_NAME`, `PORTAL_URL`, and `DATABASE_URL`/server-side key.
5. Configure only the media providers this operator owns.
6. Start the server or Docker compose service.
7. Sign in as the portal admin.
8. Open Administration → Media Servers and save provider configuration.
9. Open Account → Linked Media Servers and connect existing provider accounts.
10. Configure optional Discord, library, mail, or request integrations only when needed.

## Authentication notes

The bootstrap admin account is local to the Portal server:

- `PORTAL_ADMIN_USERNAME`
- `PORTAL_ADMIN_PASSWORD_SALT`
- `PORTAL_ADMIN_PASSWORD_HASH`

PostgreSQL stores Portal data and encrypted installation settings; it is not required to be the login identity provider for the local bootstrap admin. Discord sign-in is optional and must be configured separately.

## First-launch admin setup

The first administrator is bootstrapped before the server starts. Generate a password hash with the repository's documented helper or a local Node command, then place these values in the installation's uncommitted `.env` file:

```dotenv
PORTAL_ADMIN_USERNAME=admin
PORTAL_ADMIN_PASSWORD_SALT=<random-salt>
PORTAL_ADMIN_PASSWORD_HASH=<scrypt-hash-for-the-password>
```

Use the username and original password at the Portal sign-in screen. The hash is one-way; do not paste the original password or hash into GitHub.

After signing in, use Administration to configure the Portal's provider settings and optional integrations. The account screen is for linking existing media-server accounts after the corresponding provider has been configured.

## What must exist before first launch

The server needs its own PostgreSQL connection before it can start reliably because PostgreSQL is the Portal's settings and account store:

- `DATABASE_URL`
- `DATABASE_URL` (server-side key, kept only in `.env`)
- `CONFIG_ENCRYPTION_KEY`
- `SESSION_SECRET`
- the schema from `portal_schema.sql`

This is the installation bootstrap connection, not a personal production connection. It cannot be entered through the Portal after login because the server needs a data store in order to serve the login and administration pages.

VPS/hosting details are deployment concerns, not Portal provider settings. The public build does not need SSH, VPS credentials, or a remote-server integration. Configure the host and Docker outside the Portal, then configure Portal services from Administration after the admin login.

## Provider boundary

The public build contains provider adapters and configuration slots, but every operator supplies their own provider URL, API key, account, and permissions. Blank provider settings mean that provider is unavailable. Do not paste private production values into this repository or into screenshots, issues, or pull requests.

## Operational checks

After installation, verify:

- `docker compose -p portal-v1-public ps` shows the container as running.
- `curl http://127.0.0.1:3100` works on the server, or use an SSH tunnel.
- The admin login succeeds with the configured bootstrap credentials.
- Administration → Media Servers reflects the values configured for this installation.
- Account → Linked Media Servers shows no rows until a service is actually linked.
- Linking a service creates a linked row and unlinking removes it.
- Optional integrations remain disabled when their environment variables are blank.

For a Docker-specific checklist, see [DOCKER.md](DOCKER.md). For security requirements, see [SECURITY.md](SECURITY.md). For schema setup, see [SETUP.md](SETUP.md).

## Public/private boundary

This repository is the distributable public build. It must remain separate from any private live portal. Never deploy its files over another installation, copy private configuration into it, or use private production credentials while testing it.

## Discord and bot wiring

Enter the Discord Server/Guild ID once under Administration → Authentication & Access. The Discord Bot card displays that value as linked/read-only and uses it for generated configuration, invite links, and registration. It does not discover announcement channels or roles.

Under Permissions & Announcements, configure each announcement channel and its allowed media-server role IDs. Role targeting is exact: a member with a different provider role does not receive an announcement targeted at another role. The bot and Portal must use the same guild, channel, and role rules.

Save the Bot card only after configuring providers, prices, stream tiers, roles, and announcement settings. Download the complete `.tar.gz` folder, create its host `.env`, deploy it separately, and run `npm run register` (or `docker compose run --rm portal-discord-bot node index.js register`) after first deployment and after command/provider changes.

## Lifetime parent/sub-user model

A Lifetime parent has no expiry and owns a fixed stream pool. A linked sub-user belongs to that same membership record, consumes part of the pool, and cannot exceed available capacity. Adding, reclaiming, or deleting a sub-user updates the parent pool; a sub-user must never become an unrelated standalone parent.

Emby and Silo are active public integration paths. Plex and Jellyfin are adapter/configuration slots until their user APIs and account/session bridges are implemented and tested.


## Library and comic-app wiring

Configure the Library card only with services owned by this installation. For ebooks, Portal downloads from BookWarehouse and uses the container's Calibre `ebook-convert` binary to produce a consistent EPUB before opening the Portal reader or sending to Kindle. Audiobooks use Portal's authenticated range-enabled player and download path.

For comics, Kavita is the recommended backend for the in-app comic library and external reader apps. In Kavita, create/copy the user's OPDS URL from Preferences → OPDS. Either paste that complete URL into the Portal Library card as `KAVITA_OPDS_URL`, or configure `KAVITA_URL` plus `KAVITA_API_KEY` and let Portal construct `/api/opds/<key>`. The signed-in member can retrieve the URL from `GET /api/library/kavita/opds`; never place it in public documentation or commit it to Git.

After configuration, verify an ebook opens at `/reader`, an audiobook opens at `/audio-reader`, and the returned Kavita OPDS URL works in the target comic app. A Kavita OPDS URL is separate from Portal's own `/opds/*` feed.


## Admin and recovery email flow

Admin email is a server-side Resend or SMTP integration. The Admin & Recovery Email card stores the selected provider, provider credentials, sender, and private support inbox in encrypted PostgreSQL settings. Its connection test verifies the selected provider without sending.

The flow is:

```text
Member saves recovery email
  -> /api/set-recovery-email
Sign-in reset request
  -> /api/forgot-password
  -> 30-minute single-use token
  -> Resend message from Admin sender
Expiry reminder
  -> member recovery email
Issue report
  -> private support inbox
```

The recovery address belongs to the member account and is not used for the bootstrap Portal administrator login. Change the bootstrap administrator password under Administration → Administrator Accounts. Kindle mail is configured and tested independently in the SMTP Configuration card.

For release verification, test connection, recovery-link delivery, token expiry/reuse rejection, expiry reminders, and support-report delivery with a test member account.

The Admin & Recovery Email provider can be switched independently from Kindle delivery. Resend uses the API key and verified sender fields. SMTP uses the host, port, SSL/TLS toggle, credentials, sender, and support inbox. The selected provider is used by password resets, expiry reminders, and support notifications.

## Administrator account lifecycle

Portal has a two-stage administrator setup:

1. **Bootstrap:** before PostgreSQL contains a saved primary record, the portal-only login comes from the host `.env` bootstrap values.
2. **Persistent:** when the first administrator saves **Primary Administrator** in Administration → Administrator Accounts, the credentials are hashed and encrypted into PostgreSQL. The saved primary record becomes the source of truth and the original bootstrap login is disabled.

Additional administrators are also hashed and stored in encrypted PostgreSQL settings. They are independent of member and provider identities. Verify the new primary login after saving and keep a protected backup of both PostgreSQL and the host `.env`.

## Authentication provider boundaries

Discord is the implemented OAuth provider. Its callback is `/auth/callback`, and the server validates the Discord identity and optional guild-role access before creating a member session.

Emby Connect is implemented against Emby's Connect authentication service. The member first links their Emby Connect email from the Emby profile card; the server links that address to the member's Emby account through the Emby API. On login, Portal verifies the email/password with Emby Connect, finds the matching stored `connect_email`, and creates the Portal session. The Connect password is not stored. This requires a reachable Emby server, an Emby API key, and a member account with the email link saved.

WHMCS is currently only an external redirect entry point. The public build does not yet provide the callback, token exchange, user mapping, or session creation needed for native WHMCS login. Treat the WHMCS card as disabled unless an external bridge supplies that missing integration and has been tested end to end.


## Users card and bot synchronization

The Users card is a PostgreSQL-backed view of provider account tables:

| Provider | Users-card provisioning | Discord-bot provisioning | Shared Portal records |
| --- | --- | --- | --- |
| Emby | Supported | Supported | `emby_accounts` |
| Silo | Supported | Supported | `silo_accounts` |
| Plex | Pending adapter | Not supported | No native public account flow |
| Jellyfin | Pending adapter | Not supported | No native public account flow |

For Emby and Silo, the Users card creates or edits the provider account and its matching PostgreSQL record. The Discord bot creates the provider account and writes the same provider record plus its Discord membership record. Both paths therefore feed the same account list, expiry/lifetime fields, stream limits, and parent/sub-user relationships.

The bot is a separate process. It must use the same PostgreSQL database, the same Discord guild, and the provider credentials for the installation. After changing providers, pricing, command definitions, or the database contract, save the Bot card, download a fresh bundle, rebuild it, and run command registration again.

Plex and Jellyfin can be configured for future adapters, but their Users tabs and generated bot selections do not make account creation or member sessions operational. Keep those providers disabled for member-facing and bot provisioning flows until their bridges are implemented and tested.


## Profile recovery and password reset

The Profile → Recovery Email card writes `recovery_email` to the linked `emby_accounts` record. Forgot Password matches only that field, stores a 30-minute token, and sends through the selected Admin Resend or Admin SMTP configuration. The reset handler verifies the token, changes the password on Emby, then synchronizes the Portal password record and clears the token. A failed Emby password update does not consume the token or report success.

This is an Emby-backed flow. The recovery card is not a Silo password-reset bridge. Admin mail and Kindle mail are separate provider configurations.
