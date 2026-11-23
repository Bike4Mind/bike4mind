const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');

function main(args) {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--dry-run')) {
    console.error(
      'Live evaluation unavailable: no dedicated-provider-key aggregate hard-cap verifier or isolated credential route is implemented. Refusing all non-dry-run arguments; no credentials are read and no provider calls are made.'
    );
    return 2;
  }
  const result = spawnSync(
    'pnpm',
    ['exec', 'vitest', 'run', 'src/main/chat/ChatService.controlledCost.test.ts', '--maxWorkers=1'],
    {
      cwd: resolve(__dirname, '..'),
      stdio: 'inherit',
      env: { ...process.env, B4M_CONTROLLED_COST_DRY_RUN: '1', VITEST_MAX_WORKERS: '25%' },
    }
  );
  return result.status ?? 1;
}

module.exports = { main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
