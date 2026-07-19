# Portal operator guide

This guide explains what the public Portal build does, how its parts connect, and where an operator configures each part.

## System map

```
Browser
  -> Express server (server.js)
      -> Supabase (encrypted settings, account records, announcements)
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
| Media servers | Configure provider endpoints and link an existing service account | `.env`, Admin → Streaming Services |
| Account | View profile, recovery details, and linked media servers | Dashboard → Account |
| Announcements | Publish messages to members | Supabase settings and Admin |
| Users | Review and manage member/sub-user records | Supabase account tables and Admin |
| Discord bot | Optional slash commands and member integration | `public/discord-bot-template/` and generated bot settings |
| Libraries | Optional books, comics, audiobooks, and request integrations | `.env` and Admin → Library |
| Docker | Isolated runtime for the public build | `Dockerfile`, `docker-compose.yml` |

## How service linking works

1. An operator configures a supported provider in the installation environment.
2. The portal checks provider configuration through `GET /api/provider-status`.
3. The administrator signs in with an existing provider account.
4. The server verifies those credentials with the selected provider.
5. The link is stored encrypted in Supabase `portal_settings`.
6. Account → Linked Media Servers reads the linked records and displays only what is actually connected.

A provider must be configured before it appears in “Add a service”. The public UI does not create provider accounts or copy provider credentials into the repository.

## Configuration order

1. Create a Supabase project and run `portal_settings.sql`.
2. Copy `.env.example` to `.env`.
3. Set the local admin username, password hash, password salt, session secret, and encryption key.
4. Set the installation's `PORTAL_NAME`, `PORTAL_URL`, and `SUPABASE_URL`/server-side key.
5. Configure only the media providers this operator owns.
6. Start the server or Docker compose service.
7. Sign in as the portal admin.
8. Open Administration → Streaming Services and save provider configuration.
9. Open Account → Linked Media Servers and connect existing provider accounts.
10. Configure optional Discord, library, mail, or request integrations only when needed.

## Authentication notes

The bootstrap admin account is local to the Portal server:

- `PORTAL_ADMIN_USERNAME`
- `PORTAL_ADMIN_PASSWORD_SALT`
- `PORTAL_ADMIN_PASSWORD_HASH`

Supabase stores Portal data and encrypted installation settings; it is not required to be the login identity provider for the local bootstrap admin. Discord sign-in is optional and must be configured separately.

## Provider boundary

The public build contains provider adapters and configuration slots, but every operator supplies their own provider URL, API key, account, and permissions. Blank provider settings mean that provider is unavailable. Do not paste private production values into this repository or into screenshots, issues, or pull requests.

## Operational checks

After installation, verify:

- `docker compose -p portal-v1-public ps` shows the container as running.
- `curl http://127.0.0.1:3100` works on the server, or use an SSH tunnel.
- The admin login succeeds with the configured bootstrap credentials.
- Administration → Streaming Services reflects the values configured for this installation.
- Account → Linked Media Servers shows no rows until a service is actually linked.
- Linking a service creates a linked row and unlinking removes it.
- Optional integrations remain disabled when their environment variables are blank.

For a Docker-specific checklist, see [DOCKER.md](DOCKER.md). For security requirements, see [SECURITY.md](SECURITY.md). For schema setup, see [SETUP.md](SETUP.md).

## Public/private boundary

This repository is the distributable public build. It must remain separate from any private live portal. Never deploy its files over another installation, copy private configuration into it, or use private production credentials while testing it.
