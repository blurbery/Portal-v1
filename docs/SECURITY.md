# Security rules

- `.env` is deployment-only and must never enter Git.
- Use a server-side PostgreSQL key; never place a service-role key in browser code.
- Store OAuth client secrets, provider keys, SMTP keys, and bot tokens only in the host environment or encrypted portal settings.
- Use a unique `SESSION_SECRET` and `CONFIG_ENCRYPTION_KEY` per installation.
- Rotate credentials immediately if they appear in a terminal transcript, screenshot, commit, issue, or chat.
- Restrict deployment credentials to the smallest required scope.

