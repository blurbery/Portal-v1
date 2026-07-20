# Integration audit

This audit covers the public GitHub build. It does not connect to an operator's PostgreSQL project, media servers, Discord application, or hosting provider, so external authentication and provider responses must still be tested by each operator.

## Static checks performed

- Extracted frontend `fetch('/api/...')` calls from `public/dashboard.html`.
- Extracted Express `app.get/post/put/patch/delete('/api/...')` routes from `server.js`.
- Compared normalized frontend paths with backend routes.
- Confirmed no active frontend calls remain for IPTV or VPS endpoints.
- Confirmed `server.js` contains no IPTV or VPS integration terms.
- Confirmed the Docker files use the public build marker and the isolated `portal-v1-public` service/container name.
- Confirmed installation secrets remain environment/PostgreSQL settings inputs rather than committed values.

The route comparison found one dynamic reader-progress path that requires runtime URL encoding; it corresponds to the backend route `/api/reader/progress/:book_title` and is expected.

## Runtime checks for an operator

Run these after setting up the operator's own values:

1. Load the sign-in page and sign in with the bootstrap admin account.
2. Open Administration and save Core settings.
3. Open Streaming Services and verify that blank providers do not appear as linkable services.
4. Configure one owned media provider and verify it appears in Add a service.
5. Link an existing provider account and verify Account → Linked Media Servers shows it.
6. Unlink it and verify the row disappears.
7. Test announcements, account loading, sign-out, and a page refresh.
8. If enabled, test Discord OAuth callback, bot commands, library searches, requests, email, and push notifications individually.
9. Run `docker compose -p portal-v1-public ps` and inspect `docker compose -p portal-v1-public logs --tail=100 portal-v1-public`.

## Important limits

A static route audit cannot prove that an API key has the required provider permissions, that a PostgreSQL schema is installed, that OAuth redirect URLs are correct, or that a third-party service is reachable from the operator's host. Those checks require the operator's own installation values and must never use private production credentials.


## Admin and recovery email verification

- Confirm Administration → Admin & Recovery Email shows **Configured** only when the API key and sender are present.
- Use **Test Connection** and confirm it reports Resend/domain verification without sending an email.
- Save a member recovery address under Account.
- Request a reset from the sign-in page and confirm the 30-minute link works once and cannot be reused.
- Confirm an expired token is rejected.
- Confirm expiry reminders use the configured sender and member recovery address.
- Submit an issue report and confirm it reaches the private support inbox.
- Confirm the bootstrap administrator password is managed separately under Administrator Accounts.

- Repeat the connection test with the selected provider: Resend domain/API validation or SMTP connection/authentication verification.
- If SMTP is selected, verify that port/security settings match the provider (587/STARTTLS or 465/SSL).
