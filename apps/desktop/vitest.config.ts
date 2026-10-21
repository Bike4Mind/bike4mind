import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { sharedTest } from '../../vitest.shared';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@bike4mind/cli/skills': resolve(__dirname, '../../packages/cli/src/skills/index.ts'),
    },
  },
  test: {
    ...sharedTest,
    environment: 'node',
    setupFiles: [resolve(__dirname, 'vitest.setup.ts')],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
