import { describe, expect, it } from 'vitest';
import type { IMcpConnectionPublic, IMcpPlatformConnectionMemberView } from '@bike4mind/common';
import {
  composerConnections,
  connectionChip,
  connectionsFor,
  galleryConnectionState,
  initialToolDrafts,
  isComposerConnectionOn,
  needsSignIn,
  offeredToolCount,
  toggleComposerConnection,
  toolHintLabels,
  toolTitle,
  toReviewEntries,
  type McpConnectionTool,
} from './customMcpModel';

const tool = (overrides: Partial<McpConnectionTool> = {}): McpConnectionTool => ({
  name: 'search',
  description: 'Search',
  descriptionRawHash: 'raw',
  versionHash: 'v1',
  enabled: false,
  approval: 'default',
  state: 'pending_review',
  firstSeenAt: new Date(0),
  ...overrides,
});

const connection = (overrides: Partial<IMcpConnectionPublic> = {}): IMcpConnectionPublic =>
  ({
    id: 'c1',
    status: 'connected',
    auth: { kind: 'oauth' },
    tools: [],
    enabled: true,
    ...overrides,
  }) as IMcpConnectionPublic;

describe('tool review drafts', () => {
  it('starts a tool pending review switched off, even when its stored flag says on', () => {
    const drafts = initialToolDrafts([
      tool({ name: 'new', enabled: true, state: 'pending_review' }),
      tool({ name: 'kept', enabled: true, state: 'active', approval: 'always_allow' }),
    ]);
    expect(drafts).toEqual({
      new: { enabled: false, approval: 'default' },
      kept: { enabled: true, approval: 'always_allow' },
    });
  });

  it('marks every versioned tool reviewed with the version shown, and skips one with no version', () => {
    const tools = [tool({ name: 'a', versionHash: 'va' }), tool({ name: 'b', versionHash: undefined })];
    expect(toReviewEntries(tools, { a: { enabled: true, approval: 'always_ask' } })).toEqual([
      { name: 'a', versionHash: 'va', enabled: true, approval: 'always_ask', state: 'active' },
    ]);
  });
});

describe('connection state', () => {
  it('reads a connected server with tools awaiting review as Pending review', () => {
    expect(connectionChip(connection({ tools: [tool()] })).label).toBe('Pending review');
    expect(connectionChip(connection({ tools: [tool({ state: 'active' })] })).label).toBe('Connected');
    expect(connectionChip(connection({ status: 'blocked_by_policy' })).label).toBe('Blocked by admin');
  });

  it('counts only enabled, reviewed tools as offered', () => {
    const tools = [
      tool({ name: 'a', state: 'active', enabled: true }),
      tool({ name: 'b', state: 'active', enabled: false }),
      tool({ name: 'c', state: 'pending_review', enabled: true }),
    ];
    expect(offeredToolCount({ tools })).toBe(1);
  });

  it('asks for a browser sign-in only for a connection that does not use an API key', () => {
    expect(needsSignIn(connection({ status: 'pending_auth', auth: { kind: 'none' } }))).toBe(true);
    expect(needsSignIn(connection({ status: 'needs_reconnect' }))).toBe(true);
    expect(needsSignIn(connection({ status: 'needs_reconnect', auth: { kind: 'api_key' } }))).toBe(false);
    expect(needsSignIn(connection())).toBe(false);
  });

  it('splits connections between the custom entry and each preset', () => {
    const all = [connection({ id: 'a' }), connection({ id: 'b', presetId: 'linear' })];
    expect(connectionsFor(all, undefined).map(c => c.id)).toEqual(['a']);
    expect(connectionsFor(all, 'linear').map(c => c.id)).toEqual(['b']);
    expect(galleryConnectionState([connection({ status: 'needs_reconnect' })])).toEqual({
      connected: false,
      needsReconnect: true,
    });
  });
});

describe('composerConnections', () => {
  it('keeps only connected, switched-on connectors with a reviewed tool on', () => {
    const on = tool({ state: 'active', enabled: true });
    const all = [
      connection({ id: 'ok', tools: [on] }),
      connection({ id: 'off', enabled: false, tools: [on] }),
      connection({ id: 'signin', status: 'pending_auth', tools: [on] }),
      connection({ id: 'unreviewed', tools: [tool({ enabled: true })] }),
      connection({ id: 'none-on', tools: [tool({ state: 'active', enabled: false })] }),
    ];
    expect(composerConnections(all).map(c => c.id)).toEqual(['ok']);
  });

  it('offers a platform connector to the composer, which no drawer manages', () => {
    const shared: IMcpPlatformConnectionMemberView = {
      id: 'shared',
      ownerType: 'platform',
      slug: 'docs',
      displayName: 'Docs',
      urlHost: 'mcp.example.com',
      status: 'connected',
      tools: [tool({ state: 'active', enabled: true })],
      enabled: true,
    };
    const all = [
      connection({ id: 'mine' }),
      shared,
      { ...shared, id: 'blocked', status: 'blocked_by_policy' as const },
    ];

    expect(composerConnections(all).map(c => c.id)).toEqual(['shared']);
    expect(connectionsFor(all, undefined).map(c => c.id)).toEqual(['mine']);
  });
});

describe('connector tool list', () => {
  it('labels a contradictory read-only claim as a write, the way the review does', () => {
    expect(toolHintLabels(tool({ annotations: { readOnlyHint: true, destructiveHint: true } }))).toEqual([
      { label: 'Write', color: 'warning' },
      { label: 'May delete or overwrite', color: 'neutral' },
    ]);
    expect(toolHintLabels(tool({ annotations: { readOnlyHint: true, idempotentHint: true } }))).toEqual([
      { label: 'Read', color: 'neutral' },
    ]);
    expect(toolHintLabels(tool())).toEqual([{ label: 'Write', color: 'warning' }]);
  });

  it("prefers the tool's own title, then the annotation title", () => {
    expect(toolTitle(tool({ title: 'Own', annotations: { title: 'Hint' } }))).toBe('Own');
    expect(toolTitle(tool({ annotations: { title: 'Hint' } }))).toBe('Hint');
    expect(toolTitle(tool({ title: '' }))).toBeUndefined();
  });
});

describe('composer connection switches', () => {
  const none = { disabledMcpConnections: [], enabledPlatformMcpConnections: [] };
  const shared = { id: 'p1', slug: 'docs', ownerType: 'platform' as const };
  const mine = { id: 'u1', slug: 'mine', ownerType: 'user' as const };

  it("starts a platform connector off and the user's own connector on", () => {
    expect(isComposerConnectionOn(shared, none)).toBe(false);
    expect(isComposerConnectionOn(mine, none)).toBe(true);
  });

  it('switches a platform connector on and off by id, leaving the slug list alone', () => {
    const on = toggleComposerConnection(shared, none);
    expect(on).toEqual({ enabledPlatformMcpConnections: ['p1'] });
    const afterOn = { ...none, ...on };
    expect(isComposerConnectionOn(shared, afterOn)).toBe(true);

    expect(toggleComposerConnection(shared, afterOn)).toEqual({ enabledPlatformMcpConnections: [] });
    // A recreated connector has a new id, so the old switch does not carry over.
    expect(isComposerConnectionOn({ ...shared, id: 'p2' }, afterOn)).toBe(false);
  });

  it("switches the user's own connector off and on by slug, as before", () => {
    const off = toggleComposerConnection(mine, none);
    expect(off).toEqual({ disabledMcpConnections: ['mine'] });
    expect(isComposerConnectionOn(mine, { ...none, ...off })).toBe(false);
    expect(toggleComposerConnection(mine, { ...none, ...off })).toEqual({ disabledMcpConnections: [] });
    expect(isComposerConnectionOn(mine, { ...none, enabledPlatformMcpConnections: ['u1'] })).toBe(true);
  });
});
