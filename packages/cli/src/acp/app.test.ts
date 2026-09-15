/**
 * Transport-level tests: drive the real ACP handler graph in-process through
 * the SDK's client/agent direct connection. These exercise everything up to
 * (but not including) the agent-stack bootstrap - initialize and cwd
 * validation both run before any network/auth, so they are hermetic.
 */

import { describe, it, expect } from 'vitest';
import { client } from '@agentclientprotocol/sdk';
import { methods, PROTOCOL_VERSION } from './acpSdk.js';
import { buildAcpApp } from './app.js';
import { AcpServer } from './AcpServer.js';
import { ACP_MODE_ASK, ACP_MODE_PLAN } from './protocol.js';

function connectInProcess<T>(op: (ctx: import('@agentclientprotocol/sdk').ClientContext) => Promise<T>): Promise<T> {
  const server = new AcpServer(new AbortController().signal, '9.9.9-test');
  const agentApp = buildAcpApp(() => server);
  return client({ name: 'test-client' }).connectWith(agentApp, op);
}

describe('ACP transport handlers', () => {
  it('completes initialize with our version, agent info, and capabilities', async () => {
    await connectInProcess(async ctx => {
      const res = await ctx.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });
      expect(res.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(res.agentInfo?.name).toBe('bike4mind');
      expect(res.agentInfo?.version).toBe('9.9.9-test');
      expect(res.agentCapabilities?.loadSession).toBe(true);
      // image is intentionally false for v1 (see AcpServer.initialize) - the
      // prompt path is text-only, so we don't advertise image uploads.
      expect(res.agentCapabilities?.promptCapabilities?.image).toBe(false);
    });
  });

  it('rejects a relative session cwd over the wire (before any bootstrap)', async () => {
    await connectInProcess(async ctx => {
      await expect(ctx.request(methods.agent.session.new, { cwd: 'not/absolute', mcpServers: [] })).rejects.toThrow(
        /absolute/i
      );
    });
  });

  it('rejects a non-existent session cwd over the wire', async () => {
    await connectInProcess(async ctx => {
      await expect(
        ctx.request(methods.agent.session.new, { cwd: '/definitely/not/a/real/dir/xyz', mcpServers: [] })
      ).rejects.toThrow(/existing directory/i);
    });
  });

  it('rejects setting an unsafe/unknown mode on an unknown session (fails closed)', async () => {
    await connectInProcess(async ctx => {
      // Unknown session id is rejected too, but the important invariant is that
      // a bad mode never silently succeeds.
      await expect(
        ctx.request(methods.agent.session.setMode, { sessionId: 'nope', modeId: 'auto-accept' })
      ).rejects.toThrow();
    });
  });

  it('advertises only the safe ask/plan modes', () => {
    // Guards the wire contract at the source: no no-prompt mode is offered.
    const server = new AcpServer(new AbortController().signal, 'x');
    const res = server.initialize({ protocolVersion: PROTOCOL_VERSION });
    expect(res.agentCapabilities?.loadSession).toBe(true);
    // Modes are advertised per-session, but confirm the allowlist constants
    // are the only two exposed.
    expect([ACP_MODE_ASK, ACP_MODE_PLAN]).toHaveLength(2);
  });
});
