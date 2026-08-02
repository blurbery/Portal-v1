import { defineConfig } from 'vitest/config';
import dotenv from 'dotenv';
dotenv.config();

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
