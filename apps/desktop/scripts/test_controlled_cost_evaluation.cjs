const assert = require('node:assert/strict');
const { test } = require('node:test');
const { main } = require('./controlled-cost-evaluation.cjs');

test('refuses live mode without explicit spending opt-in and refuses local budget proofs', () => {
  for (const args of [['--live'], ['--verified-budget=150'], ['--dry-run', '--live'], ['--help']]) {
    assert.equal(main(args), 2);
  }
});

test('dispatches live only with paid opt-in and forwards the optional config', () => {
  let call;
  const result = main(['--live', '--accept-paid-requests', '--config=fixture.json'], (...args) => {
    call = args;
    return { status: 0 };
  });
  assert.equal(result, 0);
  assert.equal(call[0], 'pnpm');
  assert.ok(call[1].includes('--controlled-cost-evaluation-live'));
  assert.ok(call[1].some(value => value.startsWith('--controlled-cost-evaluation-config=')));
});

test('forwards final phase only after paid opt-in and preserves explicit recovery identity', () => {
  let forwarded;
  assert.equal(main(['--live', '--accept-paid-requests', '--final', '--recover-run=known'], (_command, args) => {
    forwarded = args;
    return { status: 0 };
  }), 0);
  assert.ok(forwarded.includes('--controlled-cost-evaluation-final'));
  assert.ok(forwarded.includes('--controlled-cost-evaluation-recover-run=known'));
  assert.equal(main(['--final']), 2);
});
