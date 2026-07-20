# Security rules

- `.env` is deployment-only and must never enter Git.
- Use a server-side PostgreSQL key; never place a service-role key in browser code.
- Store OAuth client secrets, provider keys, SMTP keys, and bot tokens only in the host environment or encrypted portal settings.
- Use a unique `SESSION_SECRET` and `CONFIG_ENCRYPTION_KEY` per installation.
- Rotate credentials immediately if they appear in a terminal transcript, screenshot, commit, issue, or chat.
- Restrict deployment credentials to the smallest required scope.

## Public-build rules

Keep installation secrets in the host `.env` or encrypted PostgreSQL settings only. Never commit Discord tokens, OAuth client secrets, provider API keys, database passwords, private SSH keys, password hashes, private domains, or server addresses. Generated bot archives contain code and safe examples only; create the bot `.env` on its destination host.
