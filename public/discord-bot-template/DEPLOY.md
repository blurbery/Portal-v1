# Discord bot Docker deployment

This folder is generated from the public Portal Discord Bot card. Use the steps in this order.

1. Extract the downloaded bundle on the bot VPS and enter the folder:
   `tar -xzf portal-discord-bot-bundle.tar.gz && cd portal-discord-bot`

2. Copy the host environment template and fill in the secret values:
   `cp env.example .env && chmod 600 .env`
   Add the Discord token, Application ID, guild ID, the intended PostgreSQL `DATABASE_URL`, and only the provider keys listed in `env.example`.

3. Keep the generated `bot-config.json` in this same folder. It contains no tokens or API keys.

4. Build and start the bot:
   `docker compose up -d --build`

5. Register the configured slash commands. This step is required:
   `docker compose run --rm portal-discord-bot node index.js register`

6. Check the bot:
   `docker compose logs --tail=100 -f portal-discord-bot`

The generated Compose file joins the existing `portal-v1-postgres_default` Docker network. Deploy the bot on the same Docker host as the public Portal when using `DATABASE_URL=...@db`. Keep the bot `.env` on the VPS only.

When Portal provider, pricing, command, account, Lifetime-parent/sub-user, or database-contract behavior changes: save the Portal Discord Bot card, download a fresh complete bundle, replace the bot folder, rebuild it, and run the registration command again. Do not manually edit generated `bot-config.json` to bypass the Portal card.

## Portal branding

Set the Portal name, logo, favicon, welcome message and public URL in Administration → General Settings before distributing the bot bundle. The login page and dashboard read the active values from `/api/branding`; the bot does not replace or duplicate this branding. After branding changes, redeploy the Portal dashboard/login files if needed and hard-refresh the browser. A bot bundle only needs rebuilding when its provider, command, account or database contract changes.

## Deploy and register

Extract the complete archive, create `.env` from `env.example`, and keep it out of Git. Run `npm install`, `npm run register`, and `npm start`. For Docker: `docker compose run --rm portal-discord-bot node index.js register`, then `docker compose up -d --build`. Re-register after command, provider, or pricing changes.
