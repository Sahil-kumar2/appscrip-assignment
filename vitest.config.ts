import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 20000,
    projects: [
      {
        test: {
          name: 'backend',
          include: [
            'tests/**/*.test.ts',
            'packages/**/__tests__/**/*.test.ts',
            'apps/api/**/__tests__/**/*.test.ts',
            'apps/worker/**/__tests__/**/*.test.ts',
            'apps/simulator/**/__tests__/**/*.test.ts',
            'apps/notification-sink/**/__tests__/**/*.test.ts',
          ],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'web',
          include: ['apps/web/**/__tests__/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['./apps/web/src/test/setup.ts'],
        },
      },
    ],
  },
});
