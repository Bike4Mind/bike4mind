import { describe, it, expect, vi } from 'vitest';
import { AcpServer } from './AcpServer.js';
import { PERMISSION_OPTION_ALLOW_ALWAYS, PERMISSION_OPTION_ALLOW_ONCE, PERMISSION_OPTION_REJECT } from './protocol.js';
import type { PermissionPromptKind } from '../tools/gateway/gatewayTypes.js';

type PromptFn = (
  toolName: string,
  args: unknown,
  preview?: string,
  kind?: PermissionPromptKind
) => Promise<{ action: string }>;

function serverWithClient(outcome: unknown) {
  const request = vi.fn(async () => ({ outcome }));
  const server = new AcpServer(new AbortController().signal, 'test');
  // Private state: a live turn is what the permission bridge needs to reach the client.
  const internals = server as unknown as { activeTurn: unknown; promptFn: PromptFn };
  internals.activeTurn = { client: { request }, sessionId: 's1', signal: new AbortController().signal };
  return { promptFn: internals.promptFn, request };
}

type RequestedPermission = {
  toolCall: { title: string };
  options: Array<{ optionId: string }>;
};

function requestedPermission(request: ReturnType<typeof vi.fn>): RequestedPermission {
  return request.mock.calls[0][1] as RequestedPermission;
}

describe('AcpServer permission bridge', () => {
  it('offers once, always and reject for a normal tool prompt', async () => {
    const { promptFn, request } = serverWithClient({ outcome: 'selected', optionId: PERMISSION_OPTION_ALLOW_ONCE });

    await promptFn('bash_execute', { command: 'ls' }, undefined, 'tool');

    const { toolCall, options } = requestedPermission(request);
    expect(toolCall.title).not.toContain('Run outside sandbox');
    expect(options.map(option => option.optionId)).toEqual([
      PERMISSION_OPTION_ALLOW_ONCE,
      PERMISSION_OPTION_ALLOW_ALWAYS,
      PERMISSION_OPTION_REJECT,
    ]);
  });

  it('prefixes the title and omits allow-always for a sandbox escalation', async () => {
    const { promptFn, request } = serverWithClient({ outcome: 'selected', optionId: PERMISSION_OPTION_ALLOW_ONCE });

    const response = await promptFn('bash_execute', { command: 'ls' }, 'preview', 'sandbox-escalation');

    const { toolCall, options } = requestedPermission(request);
    expect(toolCall.title.startsWith('Run outside sandbox: bash_execute')).toBe(true);
    expect(options.map(option => option.optionId)).toEqual([PERMISSION_OPTION_ALLOW_ONCE, PERMISSION_OPTION_REJECT]);
    expect(response.action).toBe('allow-once');
  });

  it('denies when the client request fails', async () => {
    const server = new AcpServer(new AbortController().signal, 'test');
    const request = vi.fn(async () => {
      throw new Error('connection closed');
    });
    const internals = server as unknown as { activeTurn: unknown; promptFn: PromptFn };
    internals.activeTurn = { client: { request }, sessionId: 's1', signal: new AbortController().signal };

    await expect(internals.promptFn('bash_execute', {}, undefined, 'sandbox-escalation')).resolves.toEqual({
      action: 'deny',
    });
  });
});
