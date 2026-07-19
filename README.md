# Portal Portal — GitHub Build v1

This is a separate, provider-neutral v1 build. It is not the private live portal and does not contain the owner’s credentials, API keys, Discord IDs, private domains, or personal server addresses. All installation-specific values belong in environment variables or the encrypted Supabase settings table.

## Important boundary

Do not copy private portal changes directly into this repository. Keep the portal integration contract intact: authentication, provider configuration, Supabase table names, `/api/*` routes, and the member-session shape are shared interfaces. Extend those interfaces deliberately and add a migration/documentation entry for every change.

v1 is a clean provider-neutral deployment. Do not add owner-specific sync jobs, private library backends, private Portal integrations, or installation-specific defaults to this repository.

## Quick start

1. Create a private GitHub repository and clone it locally.
2. Copy `.env.example` to `.env` and fill only the values for this installation.
3. Create the Supabase schema by following `docs/SETUP.md`.
4. Run `npm install` and `npm run check`.
5. Start with `npm start`, or use the process manager provided by your host.

Never commit `.env`, bot tokens, provider API keys, OAuth client secrets, service-role keys, or password hashes.

## Operator isolation

Each operator must create and use their own Supabase project, Discord application, provider accounts, environment variables, and encrypted settings. Invited GitHub collaborators receive the distributable source only; never share the private portal’s `.env`, database, bot configuration, credentials, domains, or server details.

## Included

- Admin-configured portal settings stored encrypted in Supabase.
- Discord, WHMCS and Emby Connect authentication switches.
- Configurable Emby, Silo, Jellyfin and Plex provider slots.
- Announcements, role routing, member/sub-user session handling, and optional Seerr configuration.
- Supabase and hosting-provider deployment instructions.

See `docs/SETUP.md`, `docs/SECURITY.md`, and `docs/UPDATES.md` before installing.
