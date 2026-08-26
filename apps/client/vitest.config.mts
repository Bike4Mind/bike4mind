import { defineConfig } from 'vitest/config';
import { sharedTest } from '../../vitest.shared';
import path from 'path';
// @vitejs/plugin-react v6 requires Vite 8 (it imports the `vite/internal`
// subpath). Vite is otherwise only a transitive peer of vitest. Declaring
// `vite` as an explicit devDependency here is the lever that satisfies
// plugin-react 6's strict `^8` peer — pnpm then unifies vite to 8 workspace-wide
// for every vitest package (safe: vitest 4 accepts vite ^6 || ^7 || ^8). This
// vite devDep and the plugin-react v6 bump are coupled — keep both or revert both.
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

const INTEGRATION_LANE = process.env.CLIENT_TEST_LANE === 'integration';

// This package is the Next Pages-API backend and the SPA in one workspace, so its test files
// split cleanly by directory: everything under these trees is a route/queue/cron handler or the
// server library they call, Node by construction and never touching a DOM. They are ~570 of the
// package's ~1040 test files, and a package-wide `environment: 'jsdom'` built a DOM for every one
// of them: in the CI shard that made environment construction (931s summed across workers) cost
// more than executing the tests (425s), which is what pushed the job into its own timeout with
// every test passing (#2015).
//
// The few files under these trees that DO need a DOM opt back in per file with a
// `// @vitest-environment jsdom` docblock - the same escape hatch ~40 files here already use in
// the opposite direction, which is why this is a default change rather than a new convention.
const NODE_TEST_ROOTS = ['server', 'pages'];

// A copy of vitest's own default `include`, needed because the node project's globs are
// directory-prefixed and so cannot be left implicit. Deliberately used for the NODE side only:
// the jsdom project leaves `include` unset in the unit lane so vitest's real default applies
// there. If this copy ever falls behind vitest's default, the consequence is that a file runs
// under jsdom instead of node - slower, still correct - rather than matching no project at all.
// A test file silently not running is the one failure mode here that nothing would report.
const VITEST_DEFAULT_INCLUDE = ['**/*.{test,spec}.?(c|m)[jt]s?(x)'];

// Two lanes over one config, selected by CLIENT_TEST_LANE (set only by the `test:integration`
// script). The ~20 `*.e2e.test.ts` files each boot a real mongod, and running them inline pushed
// this shard's job past its CI budget even though the suite itself passed - so they get their own
// matrix shard. One config rather than two so the aliases, setup file and environment split cannot
// drift between the lanes.
// NOTE: `test:e2e` in package.json is Playwright, NOT these files. The Playwright directory is
// the bare 'e2e' exclusion below.
// `undefined` in the unit lane means "whatever vitest includes by default" - see above.
const LANE_INCLUDE = INTEGRATION_LANE ? ['**/*.e2e.test.ts'] : undefined;

// The node project claims exactly these; the jsdom project excludes exactly these. Deriving both
// sides from this one list is what makes the split disjoint AND jointly complete: a file these
// globs miss falls THROUGH to jsdom rather than out of the run, which a `server/**` blanket
// exclusion on the jsdom side would not have guaranteed.
const NODE_PROJECT_INCLUDE = NODE_TEST_ROOTS.flatMap(root =>
  (LANE_INCLUDE ?? VITEST_DEFAULT_INCLUDE).map(glob => `${root}/${glob}`)
);

const LANE_EXCLUDE = [
  '**/node_modules/**',
  'e2e',
  '.next/**',
  '.open-next/**',
  ...(INTEGRATION_LANE ? [] : ['**/*.e2e.test.ts']),
];

// Test options both projects share. Spread rather than relied on as inherited: a project config
// does not pick up the root `test` block, and letting each project carry its own copy of
// `setupFiles`/timeouts is exactly the drift this single config exists to prevent.
const projectTest = {
  ...sharedTest,
  globals: true,
  setupFiles: [path.resolve(__dirname, 'vitest.setup.ts')],
  // Raise the 15s shared floor to 30s. Load-bearing for the integration lane, which holds ~20
  // real-Mongo suites (createMongoServer/createMongoReplSet): their first write per worker pays an
  // unavoidable, legitimate cold-start: Mongoose builds every model's indexes on connect (needed
  // for correctness - the rate-limit suite depends on one, so autoIndex CANNOT be disabled) plus
  // first-collection creation. Measured at 16-22s under that lane's file parallelism, so 15s (a
  // unit-test budget) fails 4-ish suites at random - the exact flake. This is not a hang mask: it
  // is the right budget for integration tests. Attempts to shrink the cold-start instead were
  // dead ends - autoIndex:false breaks index-dependent suites, and a single shared mongod
  // serializes every worker's index builds and made it markedly worse.
  testTimeout: 30000,
};

// Vite-level options both projects share. A factory, not a constant: each project gets its own
// Vite server, and plugin instances are stateful and must not be shared across them.
const projectVite = () => ({
  plugins: [react(), tsconfigPaths()],
  resolve: {
    alias: {
      '@server': path.resolve(__dirname, 'server'),
      '@client': path.resolve(__dirname, '.'),
      '@pages': path.resolve(__dirname, 'pages'),
      '@public': path.resolve(__dirname, 'public'),
      '@/': `${path.resolve(__dirname, '.')}/`,
      crypto: 'node:crypto',
    },
  },
  define: {
    global: 'globalThis',
    'process.env': {},
  },
  optimizeDeps: {
    include: ['uuid'],
  },
});

export default defineConfig({
  test: {
    // Both projects and this root spread the same `sharedTest`, so they resolve to an IDENTICAL
    // worker budget - which is load-bearing twice over. Two projects resolving to DIFFERENT
    // counts under the same `sequence.groupOrder` is a hard vitest error; identical ones share a
    // single group, so their files interleave over ONE pool. That means the environment split
    // below costs no file parallelism, and VITEST_MAX_WORKERS still caps the whole run rather
    // than being handed out once per project.
    ...sharedTest,
    projects: [
      {
        ...projectVite(),
        test: {
          ...projectTest,
          name: 'node',
          environment: 'node',
          include: NODE_PROJECT_INCLUDE,
          exclude: LANE_EXCLUDE,
        },
      },
      {
        ...projectVite(),
        test: {
          ...projectTest,
          name: 'jsdom',
          environment: 'jsdom',
          // Left unset in the unit lane on purpose: vitest's own default include applies, so this
          // project is the catch-all and no test file can match zero projects.
          ...(LANE_INCLUDE ? { include: LANE_INCLUDE } : {}),
          // Excludes exactly what the node project includes - same list, not a restatement of it.
          exclude: [...LANE_EXCLUDE, ...NODE_PROJECT_INCLUDE],
        },
      },
    ],
  },
});
