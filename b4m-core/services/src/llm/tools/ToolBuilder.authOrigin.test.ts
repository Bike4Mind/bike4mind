import { describe, it, expect, vi } from 'vitest';
import { ToolBuilder, type ToolBuilderConfig, type BuildToolsArgs } from './ToolBuilder';
import type { ToolDefinition, ToolContext } from './base/types';

// Stub the real tool map so only the probe below is built; generateTools stays real (see
// ToolBuilder.inlinedAttachmentIds.test.ts for why the real chain matters).
vi.mock('./index', async importOriginal => {
  const actual = await importOriginal<typeof import('./index')>();
  return { ...actual, b4mTools: {} };
});

/**
 * ToolContext.authOrigin is the positive signal a session-only tool fails closed on, so it has to
 * survive the real ToolBuilder -> buildSharedTools -> generateTools chain, and a door that pairs it
 * with the wrong key id has to fail at build time rather than reach a tool.
 */
describe('ToolBuilder threads authOrigin into ToolContext', () => {
  function build(
    auth: Partial<Pick<ToolContext, 'authOrigin' | 'apiKeyId' | 'getEntitlements'>>
  ): ToolContext | undefined {
    let seen: ToolContext | undefined;
    const probe: ToolDefinition = {
      implementation: context => {
        seen = context as ToolContext;
        return {
          toolFn: async () => '',
          toolSchema: { name: 'probe', description: 'test probe', parameters: { type: 'object', properties: {} } },
        };
      },
    };
    const builder = new ToolBuilder({
      user: { id: 'u1' },
      db: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() },
      storage: {},
      imageGenerateStorage: {},
      toolCreditsMap: new Map(),
      subagentTelemetryData: [],
      sendStatusUpdate: vi.fn(),
      ...auth,
    } as unknown as ToolBuilderConfig);
    builder.buildTools({
      enabledTools: ['probe'],
      externalTools: { probe },
      quest: {} as never,
      saveQuest: vi.fn() as never,
      llm: {} as never,
      config: {},
    } as unknown as BuildToolsArgs);
    return seen;
  }

  it('forwards the lazy entitlement resolver through the real builder chain', async () => {
    const getEntitlements = vi.fn(async () => ['plan:paid']);
    const context = build({ authOrigin: 'internal', getEntitlements });
    expect(getEntitlements).not.toHaveBeenCalled();
    expect(context?.getEntitlements).toBe(getEntitlements);
    await expect(context?.getEntitlements?.()).resolves.toEqual(['plan:paid']);
  });

  it.each(['session', 'internal'] as const)('passes a %s origin through with no key id', authOrigin => {
    const context = build({ authOrigin });
    expect(context?.authOrigin).toBe(authOrigin);
    expect(context?.apiKeyId).toBeUndefined();
  });

  it('passes a key turn through with its key id', () => {
    const context = build({ authOrigin: 'apiKey', apiKeyId: 'key1' });
    expect(context).toEqual(expect.objectContaining({ authOrigin: 'apiKey', apiKeyId: 'key1' }));
  });

  it.each([
    ['a key turn without its key id', { authOrigin: 'apiKey' as const }],
    ['a key id on a session turn', { authOrigin: 'session' as const, apiKeyId: 'key1' }],
  ])('refuses to build tools for %s', (_label, auth) => {
    expect(() => build(auth)).toThrow(/authOrigin/);
  });
});
