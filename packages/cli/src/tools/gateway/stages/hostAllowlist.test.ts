import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isHostAllowlisted, __resetHostAllowlistCacheForTests } from './hostAllowlist.js';

function allow(patterns: string[] | undefined): void {
  if (patterns === undefined) delete process.env.B4M_ALLOWED_TOOLS;
  else process.env.B4M_ALLOWED_TOOLS = JSON.stringify(patterns);
  __resetHostAllowlistCacheForTests();
}

describe('isHostAllowlisted', () => {
  const original = process.env.B4M_ALLOWED_TOOLS;

  beforeEach(() => allow(undefined));
  afterEach(() => {
    if (original === undefined) delete process.env.B4M_ALLOWED_TOOLS;
    else process.env.B4M_ALLOWED_TOOLS = original;
    __resetHostAllowlistCacheForTests();
  });

  it('approves nothing when no allowlist is set', () => {
    expect(isHostAllowlisted('host__read_self', { isMcpTool: true })).toBe(false);
    expect(isHostAllowlisted('file_read')).toBe(false);
  });

  it('approves an MCP tool through the claude-form pattern mcp__<server>__*', () => {
    allow(['mcp__host__*']);
    expect(isHostAllowlisted('host__read_self', { isMcpTool: true })).toBe(true);
  });

  it('approves an MCP tool through an exact claude-form name', () => {
    allow(['mcp__host__read_self']);
    expect(isHostAllowlisted('host__read_self', { isMcpTool: true })).toBe(true);
    expect(isHostAllowlisted('host__write_artifact', { isMcpTool: true })).toBe(false);
  });

  it('still approves through the unprefixed <server>__* form', () => {
    allow(['host__*']);
    expect(isHostAllowlisted('host__read_self', { isMcpTool: true })).toBe(true);
    expect(isHostAllowlisted('host__read_self')).toBe(true);
  });

  it('does not approve another server or a built-in through mcp__host__*', () => {
    allow(['mcp__host__*']);
    expect(isHostAllowlisted('github__create_issue', { isMcpTool: true })).toBe(false);
    expect(isHostAllowlisted('file_read')).toBe(false);
    expect(isHostAllowlisted('bash_execute')).toBe(false);
  });

  it('approves a tool from a server that is itself named mcp', () => {
    allow(['mcp__mcp__*']);
    expect(isHostAllowlisted('mcp__search', { isMcpTool: true })).toBe(true);
  });

  it('does not let a mcp__ pattern reach a non-MCP tool whose name looks namespaced', () => {
    allow(['mcp__host__*', 'mcp__*']);
    expect(isHostAllowlisted('host__read_self')).toBe(false);
    expect(isHostAllowlisted('host__read_self', { isMcpTool: false })).toBe(false);
    expect(isHostAllowlisted('file_read')).toBe(false);
  });

  it('still matches built-ins by their own name', () => {
    allow(['file_read']);
    expect(isHostAllowlisted('file_read')).toBe(true);
    expect(isHostAllowlisted('file_read', { isMcpTool: false })).toBe(true);
  });
});
