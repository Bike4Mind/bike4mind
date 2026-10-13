// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('@server/middlewares/featureFlag', () => ({ isFeatureEnabled: vi.fn() }));

import { isFeatureEnabled } from '@server/middlewares/featureFlag';
import { ForbiddenError } from '@server/utils/errors';
import { assertMcpServerEnabled } from './mcpServerFlag';

describe('assertMcpServerEnabled', () => {
  it('passes when the MCP admin flag is on', async () => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(true);
    await expect(assertMcpServerEnabled()).resolves.toBeUndefined();
    expect(isFeatureEnabled).toHaveBeenCalledWith('EnableMCPServer');
  });

  it('throws a ForbiddenError when the flag is off', async () => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);
    await expect(assertMcpServerEnabled()).rejects.toBeInstanceOf(ForbiddenError);
  });
});
