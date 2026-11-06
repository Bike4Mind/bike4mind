import { describe, expect, it } from 'vitest';
import type { IMcpConnectionPublic } from '@bike4mind/common';
import {
  connectionChip,
  connectionsFor,
  galleryConnectionState,
  initialToolDrafts,
  isReadOnlyTool,
  needsSignIn,
  offeredToolCount,
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
    ...overrides,
  }) as IMcpConnectionPublic;

describe('isReadOnlyTool', () => {
  it('trusts only readOnlyHint without destructiveHint; a missing hint is a write', () => {
    expect(isReadOnlyTool(tool({ annotations: { readOnlyHint: true } }))).toBe(true);
    expect(isReadOnlyTool(tool({ annotations: { readOnlyHint: true, destructiveHint: true } }))).toBe(false);
    expect(isReadOnlyTool(tool({ annotations: {} }))).toBe(false);
    expect(isReadOnlyTool(tool())).toBe(false);
  });
});

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
