/**
 * Covers the `/trusted` handler's folder-trust status branch: it reports the
 * discovered project root and whether it is trusted, before listing per-tool
 * trust.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { infoCommands } from './infoCommands';
import type { CommandContext } from '../types';

const trusted = infoCommands.find(c => c.name === 'trusted')!;

function makeContext(opts: {
  projectRoot: string | null;
  isTrusted: boolean;
  trustedTools?: string[];
}): CommandContext {
  return {
    configStore: {
      getProjectRealPath: () => opts.projectRoot,
      isProjectTrusted: () => opts.isTrusted,
    },
    permissionManager: {
      getTrustedTools: () => opts.trustedTools ?? [],
    },
  } as unknown as CommandContext;
}

describe('/trusted folder-status branch', () => {
  let logs: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logs = [];
    spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it('reports an untrusted project root and that repo config stays inert', async () => {
    await trusted.run([], makeContext({ projectRoot: '/home/me/repo', isTrusted: false }));
    const out = logs.join('\n');
    expect(out).toContain('/home/me/repo');
    expect(out).toContain('Not trusted');
    expect(out).toContain('stay inert');
  });

  it('reports a trusted project root without the inert notice', async () => {
    await trusted.run([], makeContext({ projectRoot: '/home/me/repo', isTrusted: true }));
    const out = logs.join('\n');
    expect(out).toContain('Trusted');
    expect(out).toContain('/home/me/repo');
    expect(out).not.toContain('stay inert');
  });

  it('reports when no project root was discovered', async () => {
    await trusted.run([], makeContext({ projectRoot: null, isTrusted: false }));
    expect(logs.join('\n')).toContain('No project root discovered');
  });
});
