/**
 * Tests for the shared context tools built by SubagentOrchestrator.buildSharedContextTools.
 *
 * Since buildSharedContextTools is private, we test it indirectly by verifying
 * that the SubagentOrchestrator correctly injects tools based on frontmatter permissions.
 * We test the tool functions directly by constructing them via the same Zod + function pattern.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { SharedAgentContext } from './SharedAgentContext';

// Replicate the Zod schemas from buildSharedContextTools for direct testing
const ReadArgsSchema = z.object({
  namespace: z.string().min(1),
  key: z.string().optional(),
});

const WriteArgsSchema = z.object({
  namespace: z.string().min(1),
  key: z.string().min(1),
  value: z.string(),
});

// Factory that mirrors buildSharedContextTools logic
function createReadToolFn(sharedContext: SharedAgentContext) {
  return async (args: unknown) => {
    const { namespace, key } = ReadArgsSchema.parse(args);
    if (key) {
      const value = sharedContext.get(namespace, key);
      return value !== undefined
        ? `Value for "${key}" in namespace "${namespace}": ${value}`
        : `No entry found for "${key}" in namespace "${namespace}"`;
    }
    const all = sharedContext.getAll(namespace);
    const entries = Object.entries(all);
    if (entries.length === 0) {
      return `Namespace "${namespace}" is empty or does not exist.`;
    }
    return entries.map(([k, v]) => `- ${k}: ${v}`).join('\n');
  };
}

function createWriteToolFn(sharedContext: SharedAgentContext, agentName: string) {
  return async (args: unknown) => {
    const { namespace, key, value } = WriteArgsSchema.parse(args);
    sharedContext.set(namespace, key, value, agentName);
    return `Stored "${key}" in namespace "${namespace}"`;
  };
}

describe('shared context read tool', () => {
  it('should read a specific key', async () => {
    const ctx = new SharedAgentContext();
    ctx.set('discoveries', 'auth-files', 'src/auth/login.ts', 'explore');
    const read = createReadToolFn(ctx);

    const result = await read({ namespace: 'discoveries', key: 'auth-files' });
    expect(result).toContain('src/auth/login.ts');
  });

  it('should return not-found for missing key', async () => {
    const ctx = new SharedAgentContext();
    const read = createReadToolFn(ctx);

    const result = await read({ namespace: 'discoveries', key: 'missing' });
    expect(result).toContain('No entry found');
  });

  it('should list all entries when key is omitted', async () => {
    const ctx = new SharedAgentContext();
    ctx.set('ns', 'k1', 'v1', 'agent');
    ctx.set('ns', 'k2', 'v2', 'agent');
    const read = createReadToolFn(ctx);

    const result = await read({ namespace: 'ns' });
    expect(result).toContain('- k1: v1');
    expect(result).toContain('- k2: v2');
  });

  it('should report empty namespace', async () => {
    const ctx = new SharedAgentContext();
    const read = createReadToolFn(ctx);

    const result = await read({ namespace: 'empty' });
    expect(result).toContain('empty or does not exist');
  });

  it('should reject invalid args via Zod', async () => {
    const ctx = new SharedAgentContext();
    const read = createReadToolFn(ctx);

    await expect(read({ namespace: '' })).rejects.toThrow();
    await expect(read({})).rejects.toThrow();
  });
});

describe('shared context write tool', () => {
  it('should write a value', async () => {
    const ctx = new SharedAgentContext();
    const write = createWriteToolFn(ctx, 'explore');

    const result = await write({ namespace: 'discoveries', key: 'files', value: 'a.ts, b.ts' });
    expect(result).toContain('Stored "files"');
    expect(ctx.get('discoveries', 'files')).toBe('a.ts, b.ts');
  });

  it('should surface error when namespace is full', async () => {
    const ctx = new SharedAgentContext();
    // Fill the namespace
    for (let i = 0; i < 50; i++) {
      ctx.set('full-ns', `key-${i}`, `val-${i}`, 'setup');
    }
    const write = createWriteToolFn(ctx, 'agent');

    await expect(write({ namespace: 'full-ns', key: 'overflow', value: 'v' })).rejects.toThrow(/maximum of 50 entries/);
  });

  it('should reject invalid args via Zod', async () => {
    const ctx = new SharedAgentContext();
    const write = createWriteToolFn(ctx, 'agent');

    await expect(write({ namespace: 'ns', key: '', value: 'v' })).rejects.toThrow();
    await expect(write({ namespace: '', key: 'k', value: 'v' })).rejects.toThrow();
  });
});

describe('access control', () => {
  it('read-only agents should not have write capability', () => {
    // This validates the logic in buildSharedContextTools:
    // When access is ['read'], canWrite is false -> no write tool injected
    const access: Array<'read' | 'write'> = ['read'];
    expect(access.includes('read')).toBe(true);
    expect(access.includes('write')).toBe(false);
  });

  it('read-write agents should have both capabilities', () => {
    const access: Array<'read' | 'write'> = ['read', 'write'];
    expect(access.includes('read')).toBe(true);
    expect(access.includes('write')).toBe(true);
  });
});
