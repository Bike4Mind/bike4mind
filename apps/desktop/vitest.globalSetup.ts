import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RUN_ROOT_ENV,
  RUN_ROOT_PREFIX,
  redirectTmpdir,
  removeDeadRunRoots,
  removeRoot,
  startRootHeartbeat,
} from './vitest.tempRoot';

// A file whose tests are all skipped never runs vitest.setup.ts's afterAll, so its temp root is swept here.
export default async function setup() {
  await removeDeadRunRoots(tmpdir());
  const root = await mkdtemp(join(tmpdir(), `${RUN_ROOT_PREFIX}${process.pid}-`));
  redirectTmpdir(root);
  process.env[RUN_ROOT_ENV] = root;
  const stopHeartbeat = startRootHeartbeat(root);
  return () => {
    stopHeartbeat();
    return removeRoot(root);
  };
}
