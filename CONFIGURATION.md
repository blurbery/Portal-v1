[CONFIGURATION.md](https://github.com/user-attachments/files/30162728/CONFIGURATION.md)
# Portal configuration

The portal keeps bootstrap credentials in the process environment and lets an administrator manage optional provider settings from **Admin → Configuration**.

This is the provider-neutral GitHub Build v1. It excludes owner-specific sync jobs, private provider backends, and installation-specific defaults.

## Bootstrap variables

These must be set before the portal starts because they are required to boot and protect the configuration store:

```dotenv
SUPABASE_URL=
SUPABASE_KEY=
SESSION_SECRET=
CONFIG_ENCRYPTION_KEY=
# Set the dedicated portal administrator during deployment.
PORTAL_ADMIN_USERNAME=admin
PORTAL_ADMIN_PASSWORD_HASH=
PORTAL_ADMIN_PASSWORD_SALT=
```

`CONFIG_ENCRYPTION_KEY` should be a long random secret. It is used to encrypt every value in `portal_settings`; losing it means the stored provider settings cannot be decrypted. Do not commit any of these values.

Administration is controlled by a dedicated portal login, not Discord, Emby or Silo usernames. Set `PORTAL_ADMIN_USERNAME`, `PORTAL_ADMIN_PASSWORD_HASH`, and `PORTAL_ADMIN_PASSWORD_SALT` on first deployment. After signing in, the Administration → Settings → Administrator accounts card can change the designated login and add additional portal-only administrator accounts. Passwords for additional accounts are hashed and encrypted in Supabase.

Run [`portal_settings.sql`](./portal_settings.sql) once in the Supabase SQL editor. The admin page then provides optional fields for Discord, Emby, Silo, Plex, Jellyfin, requests/metadata, library, email, and web push.

## Runtime behavior

- Existing environment variables remain valid, so the first rollout is backwards compatible.
- Admin-entered settings override environment values and are never returned to the browser when they are secrets.
- Blank fields do not change anything. “Clear entered values” explicitly removes the stored values.
- The portal currently has native account/session integrations for Emby and Silo. Plex and Jellyfin can be configured and shown as provider status, but their account-management adapters still need to be implemented before those services can be treated as full Emby/Silo replacements.
