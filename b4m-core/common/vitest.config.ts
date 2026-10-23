import { defineConfig } from 'vitest/config';
import { sharedTest } from '../../vitest.shared';

export default defineConfig({
  test: {
    ...sharedTest,
    globals: true,
    environment: 'node',
    // No `typecheck` here: the type-level tests (`*.test-d.ts`) fall inside the package tsconfig's
    // `include` (its excludes match `*.test.ts`, not `*.test-d.ts`), so the CI Type Check job's
    // `typecheck:fast` already compiles them and a broken `expectTypeOf` fails there. Running tsc
    // again inside the test leg only added its startup to the data shard.
  },
});
