# Docker installation

This is the provider-neutral Portal-v1 public-safe build. Docker gives each operator a separate application container, but it does not provide the Supabase project or provider credentials. Every operator must supply their own values.

## Requirements

- Docker Engine with Compose v2
- A separate Supabase project
- Installation-specific provider and Discord application values
- GitHub access to this repository

## Install

Clone this repository into a dedicated directory that is not shared with another portal:

```bash
git clone git@github.com:blurbery/Portal-v1.git /opt/portal-v1-public
cd /opt/portal-v1-public
cp .env.example .env
```

Edit .env with values for this installation only. Never copy a private portal .env into this directory. Run portal_settings.sql in the installation's Supabase project, then build and start:

```bash
docker compose -p portal-v1-public up -d --build
```

The container is named portal-v1-public, exposes host port 3100, and is labelled as the public-safe Portal build. Check it with:

```bash
docker compose -p portal-v1-public ps
docker compose -p portal-v1-public logs -f portal-v1-public
```

Open the installation at http://HOST:3100 or place a separately configured reverse proxy in front of port 3100.

## Updates

Review the change first, then update and rebuild:

```bash
git pull --ff-only
docker compose -p portal-v1-public up -d --build
```

The container has no private portal data or credentials embedded in the image. Keep .env outside Git and back up the installation's own database according to its operator policy.

## Safety boundary

Do not reuse another portal's directory, .env, Supabase project, provider accounts, process name, or host port. Do not deploy this compose project over a different portal installation.
