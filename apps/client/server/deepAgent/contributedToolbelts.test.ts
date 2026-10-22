import { describe, it, expect, vi } from 'vitest';
import { resolveToolbeltProfile, DEFAULT_TOOLBELT_ROLE, type ToolbeltProfile } from '@bike4mind/agents';

const fixture = vi.hoisted(() => (role: string): ToolbeltProfile => ({
  role,
  description: 'fixture',
  enabledToolNames: ['web_search'],
  maxIterations: 3,
  maxTotalTokens: 1_000,
  temperature: 0,
  codeExecute: false,
}));

vi.mock('@server/premium-generated/premiumAgentExtensions.generated', () => ({
  premiumAgentExtensions: [{ toolbelts: [fixture('fixture-role')] }],
}));

import { registerContributedToolbelts } from './contributedToolbelts';

describe('contributed toolbelts', () => {
  it('registers the generated contributions on load', () => {
    expect(resolveToolbeltProfile('fixture-role').role).toBe('fixture-role');
  });

  it('warns about a contribution that reuses a taken role and keeps the original', () => {
    const logger = { warn: vi.fn() };
    registerContributedToolbelts([{ toolbelts: [{ ...fixture(DEFAULT_TOOLBELT_ROLE), maxIterations: 99 }] }], logger);

    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { roles: [DEFAULT_TOOLBELT_ROLE] });
    expect(resolveToolbeltProfile(DEFAULT_TOOLBELT_ROLE).maxIterations).not.toBe(99);
  });

  it('warns about malformed contributions separately from a taken role, without throwing', () => {
    const logger = { warn: vi.fn() };
    registerContributedToolbelts(
      [
        null as never,
        { toolbelts: [fixture(''), { ...fixture('no-tools'), enabledToolNames: undefined as never }] },
        { toolbelts: 'not-a-list' as never },
      ],
      logger
    );

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('Dropped malformed contributed toolbelts', { count: 3 });
    expect(resolveToolbeltProfile('no-tools').role).toBe(DEFAULT_TOOLBELT_ROLE);
  });
});
