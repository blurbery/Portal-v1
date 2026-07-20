# Safe update boundary

The portal and the Discord bot communicate through documented settings, PostgreSQL tables, API routes, and the member-session shape. A developer or AI must not replace these interfaces casually.

Before changing code:

1. Read `README.md`, `docs/SETUP.md`, and the SQL migration files.
2. Identify the route, table, and browser consumer affected.
3. Add a backward-compatible migration when a field changes.
4. Keep secrets out of source, fixtures, screenshots, logs, and tests.
5. Run `npm run check` and manually test login, provider gating, announcements, and sub-user privacy.

Keep custom branding and installation settings in `.env` or encrypted PostgreSQL settings. Do not hardcode them into the repository.


## PostgreSQL/Docker public build

The public branch uses self-hosted PostgreSQL and Docker Compose. Apply portal_schema.sql, keep secrets on the host, and use a named database volume. The Discord Bot card generates one complete provider-neutral archive; re-register after commands, providers, or pricing change.


## Library configuration contract

The public dashboard’s Library Configuration card is the supported operator path for BookWarehouse and optional metadata-provider settings. BookWarehouse URL and API key are required for the catalogue-backed library features; Hardcover, ComicVine, and Google Books are optional enrichment providers. The card’s connection test does not save values, while Save Library Configuration writes encrypted PostgreSQL settings and refreshes the server runtime.

Feature switches and Permissions & Announcements remain separate controls: enabling a provider connection does not automatically expose Library to members. When changing library settings or routes, preserve the `/api/library/*` proxy boundary so provider keys remain server-side, and validate the live provider after deployment.
