# Discord bot Docker deployment

1. Extract the downloaded bundle on the bot VPS and enter the folder:
   `tar -xzf portal-discord-bot-bundle.tar.gz && cd portal-discord-bot`

2. Copy the host environment template and fill in the secret values:
   `cp env.example .env && chmod 600 .env`

3. Keep the generated `bot-config.json` in this same folder. It contains no tokens or API keys.

4. Start the bot with Docker Compose:
   `docker compose up -d --build`

5. Register the configured slash commands:
   `docker compose run --rm portal-discord-bot node index.js register`

6. Check the bot:
   `docker compose logs --tail=100 -f portal-discord-bot`

Keep the bot .env on the VPS only. The Portal and bot may share PostgreSQL only when the bot DATABASE_URL is intentionally configured for that database.
