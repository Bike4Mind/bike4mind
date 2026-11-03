import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A file whose tests are all skipped never runs vitest.setup.ts's afterAll, so its temp root is swept here.
export default async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'b4m-desktop-run-'));
  process.env.TMPDIR = root;
  return () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
