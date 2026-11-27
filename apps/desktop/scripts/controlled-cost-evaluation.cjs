const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');

function main(args, spawn = spawnSync) {
  const live = args[0] === '--live' && args[1] === '--accept-paid-requests';
  const extra = args.slice(2);
  if (
    live &&
    extra.every(arg => arg === '--final' || arg.startsWith('--config=') || arg.startsWith('--recover-run=')) &&
    new Set(extra.map(arg => arg.split('=')[0])).size === extra.length
  ) {
    const result = spawn(
      'pnpm',
      [
        'exec',
        'electron',
        '.',
        '--controlled-cost-evaluation-live',
        ...extra.map(arg =>
          arg === '--final'
            ? '--controlled-cost-evaluation-final'
            : arg.startsWith('--recover-run=')
              ? `--controlled-cost-evaluation-recover-run=${arg.slice('--recover-run='.length)}`
              : `--controlled-cost-evaluation-config=${resolve(arg.slice('--config='.length))}`
        ),
      ],
      { cwd: resolve(__dirname, '..'), stdio: 'inherit', env: process.env }
    );
    return result.status ?? 1;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--dry-run')) {
    console.error(
      'Usage: --dry-run OR --live --accept-paid-requests [--config=path] [--final] [--recover-run=UUID]. Live requires separate server administrator authorization.'
    );
    return 2;
  }
  const result = spawn(
    'pnpm',
    ['exec', 'vitest', 'run', 'src/main/chat/ChatService.usage.test.ts', '-t', 'controlledCost', '--maxWorkers=1'],
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
