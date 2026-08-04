import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveExecutionMementoGates,
  type MementoGateAdapters,
  type MementoGateExecution,
} from './resolveExecutionMementoGates';

const isMementosV2EnabledMock = vi.fn<(userId: string) => Promise<boolean>>();

vi.mock('@server/memory/mementoLedgerMirror', () => ({
  isMementosV2Enabled: (userId: string) => isMementosV2EnabledMock(userId),
}));

const getSettingsValueMock = vi.fn();

const makeExecution = (overrides: Partial<MementoGateExecution> = {}): MementoGateExecution => ({
  userId: 'user-1',
  enableMementos: true,
  ...overrides,
});

const makeAdapters = (): MementoGateAdapters => ({
  db: { adminSettings: { getSettingsValue: getSettingsValueMock } as MementoGateAdapters['db']['adminSettings'] },
});

describe('resolveExecutionMementoGates (agent-surface authority, #1337)', () => {
  beforeEach(() => {
    isMementosV2EnabledMock.mockReset();
    isMementosV2EnabledMock.mockResolvedValue(false);
    getSettingsValueMock.mockReset();
    getSettingsValueMock.mockResolvedValue(true); // admin EnableMementos on unless a test says otherwise
  });

  it('an explicit false opts out of BOTH pipelines even for an admin-on, V2-opted user', async () => {
    // The bug this closes: `enableMementos: false` from a V2 user still distilled beliefs on the agent
    // path. It must now resolve to no memory at all - the same meaning the flag has on chat.
    isMementosV2EnabledMock.mockResolvedValue(true);
    const gates = await resolveExecutionMementoGates(makeExecution({ enableMementos: false }), makeAdapters());
    expect(gates).toEqual({ v1: false, v2: false });
  });

  it('undefined lets V2 ride the account opt-in (V1 stays off)', async () => {
    isMementosV2EnabledMock.mockResolvedValue(true);
    const gates = await resolveExecutionMementoGates(makeExecution({ enableMementos: undefined }), makeAdapters());
    expect(gates).toEqual({ v1: false, v2: true });
  });

  it('undefined with no V2 opt-in yields no memory', async () => {
    const gates = await resolveExecutionMementoGates(makeExecution({ enableMementos: undefined }), makeAdapters());
    expect(gates).toEqual({ v1: false, v2: false });
  });

  it('true enables V1 only when the admin setting also allows it', async () => {
    getSettingsValueMock.mockResolvedValue(true);
    expect(await resolveExecutionMementoGates(makeExecution({ enableMementos: true }), makeAdapters())).toEqual({
      v1: true,
      v2: false,
    });

    getSettingsValueMock.mockResolvedValue(false);
    expect(await resolveExecutionMementoGates(makeExecution({ enableMementos: true }), makeAdapters())).toEqual({
      v1: false,
      v2: false,
    });
  });

  it('reads the EnableMementos admin setting and defaults it to false when unset', async () => {
    getSettingsValueMock.mockResolvedValue(undefined);
    const gates = await resolveExecutionMementoGates(makeExecution({ enableMementos: true }), makeAdapters());

    expect(getSettingsValueMock).toHaveBeenCalledWith('EnableMementos');
    expect(gates.v1).toBe(false); // undefined admin -> V1 stays off
  });

  it('V2 never consults the admin setting - only the opt-in and the request flag', async () => {
    getSettingsValueMock.mockResolvedValue(false); // admin V1 off
    isMementosV2EnabledMock.mockResolvedValue(true);
    const gates = await resolveExecutionMementoGates(makeExecution({ enableMementos: undefined }), makeAdapters());
    expect(gates).toEqual({ v1: false, v2: true });
  });

  it('fails closed to no-V2 when the opt-in lookup rejects', async () => {
    isMementosV2EnabledMock.mockRejectedValue(new Error('mongo down'));
    const gates = await resolveExecutionMementoGates(makeExecution({ enableMementos: undefined }), makeAdapters());
    expect(gates).toEqual({ v1: false, v2: false });
  });

  it('fails closed to no-V1 when the admin-setting lookup rejects (never fails the turn)', async () => {
    // getSettingsValue is an uncached findOne and can reject; a rejection here must degrade to no
    // memory, not escape and fail an agent run that has otherwise completed.
    getSettingsValueMock.mockRejectedValue(new Error('mongo down'));
    const gates = await resolveExecutionMementoGates(makeExecution({ enableMementos: true }), makeAdapters());
    expect(gates).toEqual({ v1: false, v2: false });
  });

  it('short-circuits both lookups on an explicit opt-out', async () => {
    const gates = await resolveExecutionMementoGates(makeExecution({ enableMementos: false }), makeAdapters());
    expect(gates).toEqual({ v1: false, v2: false });
    expect(getSettingsValueMock).not.toHaveBeenCalled();
    expect(isMementosV2EnabledMock).not.toHaveBeenCalled();
  });
});
