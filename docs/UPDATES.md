# Safe update boundary

The portal and the Discord bot communicate through documented settings, Supabase tables, API routes, and the member-session shape. A developer or AI must not replace these interfaces casually.

Before changing code:

1. Read `README.md`, `docs/SETUP.md`, and the SQL migration files.
2. Identify the route, table, and browser consumer affected.
3. Add a backward-compatible migration when a field changes.
4. Keep secrets out of source, fixtures, screenshots, logs, and tests.
5. Run `npm run check` and manually test login, provider gating, announcements, and sub-user privacy.

Keep custom branding and installation settings in `.env` or Supabase settings. Do not hardcode them into the repository.
