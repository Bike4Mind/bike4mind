import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

it('scrubs E2E secrets from Playwright artifacts and fails closed on unsafe output', () => {
  const suite = fileURLToPath(new URL('../../../scripts/test_scrub_e2e_token.py', import.meta.url));
  const result = spawnSync('python3', [suite], { encoding: 'utf8' });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
