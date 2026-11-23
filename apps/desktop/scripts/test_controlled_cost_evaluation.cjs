const assert = require('node:assert/strict');
const { test } = require('node:test');
const { main } = require('./controlled-cost-evaluation.cjs');

test('refuses live mode, purported budget proofs and unknown arguments before spawning', () => {
  for (const args of [['--live'], ['--verified-budget=150'], ['--dry-run', '--live'], ['--help']]) {
    assert.equal(main(args), 2);
  }
});
