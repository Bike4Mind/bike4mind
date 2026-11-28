import { describe, expect, it } from 'vitest';
import {
  HOST_ERROR_CODES,
  HOST_PROTOCOL_VERSION,
  HostConnectError,
  HostRequestError,
  type HostTransport,
} from '@shared/hostProtocol';
import { hostInfo } from './__fixtures__/fakeHost';
import { HostNeedsUserError, initializeHost, outcomeForError } from './handshake';

const CLIENT = { clientId: 'c', clientName: 'Desktop', clientVersion: '1.0.0' };

function answering(result: unknown): HostTransport {
  return {
    request: async () => result,
    onNotification: () => () => undefined,
    onClose: () => () => undefined,
    close: () => undefined,
  };
}

describe('initializeHost', () => {
  it('accepts a host of the same major', async () => {
    await expect(initializeHost(answering(hostInfo()), CLIENT, 1_000)).resolves.toMatchObject({ ok: true });
  });

  it('refuses a host that answers with a newer major instead of refusing itself', async () => {
    const newer = hostInfo({ protocol: { major: HOST_PROTOCOL_VERSION.major + 1, minor: 0 } });
    await expect(initializeHost(answering(newer), CLIENT, 1_000)).resolves.toMatchObject({
      ok: false,
      outcome: { retry: false, state: { status: 'failed', failure: { kind: 'protocolMismatch' } } },
    });
  });

  it('asks for an update of a host that answers with an older major', async () => {
    const older = hostInfo({ protocol: { major: HOST_PROTOCOL_VERSION.major - 1, minor: 9 } });
    await expect(initializeHost(answering(older), CLIENT, 1_000)).resolves.toEqual({
      ok: false,
      outcome: { retry: false, state: { status: 'needsUpdate', required: true } },
    });
  });

  it('refuses an answer in an unknown shape', async () => {
    await expect(initializeHost(answering({ hostId: 1 }), CLIENT, 1_000)).resolves.toMatchObject({
      ok: false,
      outcome: { retry: false, state: { status: 'failed' } },
    });
  });
});

describe('outcomeForError', () => {
  it('retries a lost link and anything unexpected', () => {
    expect(outcomeForError(new HostConnectError({ kind: 'lost', detail: 'gone', stderrTail: '' }))).toMatchObject({
      retry: true,
    });
    expect(outcomeForError(new Error('pipe'))).toEqual({
      retry: true,
      failure: { kind: 'lost', detail: 'pipe', stderrTail: '' },
    });
  });

  it('waits for the user on a HostNeedsUserError', () => {
    expect(outcomeForError(new HostNeedsUserError({ status: 'needsUpdate', required: false }))).toEqual({
      retry: false,
      state: { status: 'needsUpdate', required: false },
    });
    expect(outcomeForError(new HostNeedsUserError({ status: 'needsInstall' }))).toEqual({
      retry: false,
      state: { status: 'needsInstall' },
    });
  });

  it('reads which side must update from a protocolMismatch error', () => {
    const mismatch = (reason: string) =>
      new HostRequestError({ code: HOST_ERROR_CODES.protocolMismatch, message: 'mismatch', data: { reason } });
    expect(outcomeForError(mismatch('host-too-old'))).toEqual({
      retry: false,
      state: { status: 'needsUpdate', required: true },
    });
    expect(outcomeForError(mismatch('client-too-old'))).toMatchObject({
      retry: false,
      state: { status: 'failed', failure: { kind: 'protocolMismatch' } },
    });
  });
});
