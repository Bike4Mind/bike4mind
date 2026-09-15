// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { MCP_SERVER_ENV_KEYS } from '@bike4mind/mcp';
import { mcpSettings } from './mcpSettings';

/**
 * This table drives the Settings form; `b4m-core/mcp/src/settings.ts` is a separate copy that
 * does not. The two have drifted before - github offered GITHUB_PERSONAL_ACCESS_TOKEN here while
 * the server reads GITHUB_ACCESS_TOKEN - and only this side is what a user actually types into.
 */
describe('mcpSettings', () => {
  it.each(Object.entries(mcpSettings))('%s only offers keys the child env delivers', (name, settings) => {
    const declared = (MCP_SERVER_ENV_KEYS as Record<string, readonly string[] | undefined>)[name];
    expect(declared, `${name} has no declared env keys at all`).toBeDefined();

    const undeliverable = settings.envVariables.filter(key => !declared?.includes(key));
    expect(undeliverable, `${name} form offers keys buildMcpChildEnv would withhold`).toEqual([]);
  });
});
