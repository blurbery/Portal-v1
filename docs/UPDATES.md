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


## Library reader and Kavita OPDS

The public build keeps Portal as the authenticated control plane and uses the appropriate backend for each media type:

- BookWarehouse eBooks are normalized to EPUB with Calibre and open in Portal's EPUB reader.
- BookWarehouse audiobooks open in Portal's range-enabled audio player; the same endpoint supports seeking on desktop and mobile.
- Kavita is the comic backend. Configure `KAVITA_URL` and `KAVITA_API_KEY`, or paste the complete user OPDS URL in `KAVITA_OPDS_URL`. Kavita's OPDS/OPDS-PS feed is intended for comic apps such as Panels, Chunky, and compatible readers.
- The authenticated route `GET /api/library/kavita/opds` returns the configured OPDS URL for the signed-in member. Do not publish that URL in logs or screenshots because it contains the OPDS credential.
- Portal's custom BookWarehouse comic feed remains available for installations that do not use Kavita; it is not a substitute for Kavita's richer OPDS/OPDS-PS experience.

The old external-library popup links were removed from the public flow. Ebook, audiobook, and comic actions now stay inside Portal or use the configured Kavita OPDS path.
