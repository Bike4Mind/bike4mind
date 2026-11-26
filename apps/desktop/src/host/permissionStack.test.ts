import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionService } from '../main/chat/permissions/PermissionService';
import type { HostAuth } from './ports';
import { createHostPermissionStack } from './permissionStack';
import { hostProtectedLocations } from './protection';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('createHostPermissionStack', () => {
  it('logs, and still returns the stack, when the rules cannot be loaded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'host-permission-stack-'));
    roots.push(root);
    vi.spyOn(PermissionService.prototype, 'start').mockRejectedValue(new Error('disk gone'));
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const environment = { dataDirectory: join(root, 'data'), homeDirectory: join(root, 'home') };

    const stack = createHostPermissionStack({
      environment,
      protection: hostProtectedLocations(environment, logger),
      auth: {} as HostAuth,
      logger,
    });
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('disk gone')));

    expect(stack.permissions).toBeInstanceOf(PermissionService);
    stack.permissions.dispose();
    stack.skills.dispose();
  });
});
