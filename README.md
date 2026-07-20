# Portal Discord Bot Template

This is a separate, provider-neutral template. It does not modify or include the existing private Portal bot, private APIs, personal IDs, payment code, or live credentials.

## What is included

- Ticket panel, ticket creation, and ticket close flow.
- The ticket panel uses a category dropdown; configured media servers become ticket categories, and every ticket gets a Close Ticket button.
- `/pricing` using the portal-generated `PRICING_JSON` value.
- Provider-gated command registration:
  - Emby: `/embtrial`, `/embadd`, `/embdelete`, `/embrenew`, `/emblookup`, `/embaddsub`, `/embpoollookup`, `/embupgrade`, `/embreclaim`, `/embaddstream`, `/embdeletesub`
  - Silo: `/silotrial`, `/siloadd`, `/silodelete`, `/silorenew`, `/silolookup`, `/siloaddsub`, `/silopoollookup`, `/siloupgrade`, `/siloreclaim`, `/siloaddstream`, `/silodeletesub`
  - Jellyfin: `/jellytrial`, `/jellyadd`, `/jellydelete`, `/jellyrenew`, `/jellylookup`, `/jellyaddsub`, `/jellypoollookup`, `/jellyupgrade`, `/jellyreclaim`, `/jellyaddstream`, `/jellydeletesub`
  - Plex: `/plextrial`, `/plexadd`, `/plexdelete`, `/plexrenew`, `/plexlookup`, `/plexaddsub`, `/plexpoollookup`, `/plexupgrade`, `/plexreclaim`, `/plexaddstream`, `/plexdeletesub`
- Portal-linked persistence through the existing `emby_accounts` and `silo_accounts` tables, plus the bot membership audit table. Every created account stores the Discord ID; Lifetime sub-users retain their provider parent ID.
- Sub-users intentionally inherit the parent’s Discord ownership ID and do not receive a separate Discord login. The parent can share the generated media-server credentials with family or friends; sub-users remain isolated by their provider `parent_*` relationship.
- Credentials embeds are posted in the command channel and sent to the linked Discord member by DM. The portal address comes from `PORTAL_URL`, which must match the portal's General Settings → Base URL (Portal URL).
- Five-day, two-stream trial defaults.

Commands and ticket categories are only registered when the provider is enabled in the portal pricing JSON and both its URL and API key are present. Emby, Jellyfin-compatible account creation, and Silo account creation are wired to environment-only provider adapters. Plex account creation is intentionally not guessed because Plex uses an invite/claim flow rather than a portable local-user API; its commands remain visible only after a Plex adapter is supplied.

## Setup

1. Create a Discord application and bot in the Developer Portal.
2. Copy the Application ID into `CLIENT_ID` and reset the bot token into `DISCORD_TOKEN`.
3. Under OAuth2 URL Generator, select `bot` and `applications.commands`.
4. Grant View Channels, Send Messages, Embed Links, Attach Files, Read Message History, Manage Messages, Manage Channels, and Manage Roles.
5. Under Bot → Privileged Gateway Intents, enable Server Members Intent and Message Content Intent.
6. Download the portal-generated `bot-config.json` after saving the Discord Bot card and copy it into this project root. It controls selected providers, commands, ticket categories and pricing.
7. Add only the services configured in the portal and their host environment variables. Copy the exact portal Base URL into `PORTAL_URL`.
8. Run `npm install`, then `npm run register` and `npm start`.

## Register commands from a terminal

Node.js 22 or newer is required. Homebrew is optional.

macOS with Homebrew:

```bash
brew install node@22
```

macOS/Linux with nvm:

```bash
nvm install 22
nvm use 22
```

Windows PowerShell: install Node.js 22 from nodejs.org, open a new PowerShell window, then run:

```powershell
cd C:\path\to\your\private-bot-repository
copy env.example .env
notepad .env
npm install
node --env-file=.env index.js register
node --env-file=.env index.js
```

macOS/Linux terminal:

```bash
cd /path/to/your/private-bot-repository
cp env.example .env
chmod 600 .env
nano .env
npm install
node --env-file=.env index.js register
node --env-file=.env index.js
```

The `.env` file must contain the real values locally or in the host environment, but must never be committed. Keep it beside the bot on the VPS with permissions `600`.

For the public PostgreSQL build, run the bot beside the portal with PM2 or Docker Compose. Keep the PostgreSQL connection and all provider credentials in the VPS environment only. Verify the portal health endpoint and bot logs after deployment.

Never commit `.env`, bot tokens, service-role keys, provider API keys, private IDs, or private adapter code.

## Generated archive workflow

The Portal Discord Bot card generates one complete `.tar.gz` folder containing the bot source, package manifest, Docker files, PostgreSQL adapter/schema, `env.example`, `bot-config.json`, and deployment documentation. Configure providers, pricing, roles, and announcements in Portal before downloading it.

The shared Discord Server/Guild ID is read from Portal Authentication & Access. Channel IDs and allowed role IDs are entered separately under Permissions & Announcements. Create `.env` on the bot host only. Run `npm run register` after the first deployment and after command, provider, or pricing changes; starting the bot alone does not publish changed slash commands.


## Provider/account support boundary

The public bot shares the Portal PostgreSQL account contract for **Emby** and **Silo**. Its create/trial/renew/delete and Lifetime-parent/sub-user commands write the same provider tables the Portal Users card reads. Use the same `DATABASE_URL`, provider credentials, and Discord user IDs across both processes.

Plex and Jellyfin are not supported account-provisioning targets in this release. Do not select or deploy their generated commands as operational; their current adapter/API contract is incomplete.
