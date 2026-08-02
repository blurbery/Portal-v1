import 'dotenv/config';
import { createApp } from './app';
import { loadEnv } from './config/env';

async function main(): Promise<void> {
  const env = loadEnv();
  const { app } = await createApp({ env });
  app.listen(env.PORT, () => {
    console.log(`Portal running on port ${env.PORT}`);
  });
}

main().catch((error) => {
  console.error('[fatal]', error);
  process.exit(1);
});
