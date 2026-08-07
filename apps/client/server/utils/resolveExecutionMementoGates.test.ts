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

const makeLogger = () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), log: vi.fn(), debug: vi.fn() }) as never;

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
    const gates = await resolveExecutionMementoGates(
      makeExecution({ enableMementos: false }),
      makeAdapters(),
      makeLogger()
    );
    expect(gates).toEqual({ v1: false, v2: false, v2OptInLookupFailed: false });
  });

  it('undefined lets V2 ride the account opt-in (V1 stays off)', async () => {
    isMementosV2EnabledMock.mockResolvedValue(true);
    const gates = await resolveExecutionMementoGates(
      makeExecution({ enableMementos: undefined }),
      makeAdapters(),
      makeLogger()
    );
    expect(gates).toEqual({ v1: false, v2: true, v2OptInLookupFailed: false });
  });

  it('undefined with no V2 opt-in yields no memory', async () => {
    const gates = await resolveExecutionMementoGates(
      makeExecution({ enableMementos: undefined }),
      makeAdapters(),
      makeLogger()
    );
    expect(gates).toEqual({ v1: false, v2: false, v2OptInLookupFailed: false });
  });

  it('true enables V1 only when the admin setting also allows it', async () => {
    getSettingsValueMock.mockResolvedValue(true);
    expect(
      await resolveExecutionMementoGates(makeExecution({ enableMementos: true }), makeAdapters(), makeLogger())
    ).toEqual({
      v1: true,
      v2: false,
      v2OptInLookupFailed: false,
    });

    getSettingsValueMock.mockResolvedValue(false);
    expect(
      await resolveExecutionMementoGates(makeExecution({ enableMementos: true }), makeAdapters(), makeLogger())
    ).toEqual({
      v1: false,
      v2: false,
      v2OptInLookupFailed: false,
    });
  });

  it('reads the EnableMementos admin setting and defaults it to false when unset', async () => {
    getSettingsValueMock.mockResolvedValue(undefined);
    const gates = await resolveExecutionMementoGates(
      makeExecution({ enableMementos: true }),
      makeAdapters(),
      makeLogger()
    );

    expect(getSettingsValueMock).toHaveBeenCalledWith('EnableMementos');
    expect(gates.v1).toBe(false); // undefined admin -> V1 stays off
  });

  it('V2 never consults the admin setting - only the opt-in and the request flag', async () => {
    getSettingsValueMock.mockResolvedValue(false); // admin V1 off
    isMementosV2EnabledMock.mockResolvedValue(true);
    const gates = await resolveExecutionMementoGates(
      makeExecution({ enableMementos: undefined }),
      makeAdapters(),
      makeLogger()
    );
    expect(gates).toEqual({ v1: false, v2: true, v2OptInLookupFailed: false });
  });

  it('fails closed to no-V2 when the opt-in lookup rejects, and FLAGS it as a failure not an opt-out', async () => {
    // The gate value alone is ambiguous: `v2: false` here means "we could not tell", not "opted out".
    // The write side needs that distinction to avoid asserting a permanent opt-out to the subscriber.
    isMementosV2EnabledMock.mockRejectedValue(new Error('mongo down'));
    const logger = makeLogger();
    const gates = await resolveExecutionMementoGates(
      makeExecution({ enableMementos: undefined }),
      makeAdapters(),
      logger
    );
    expect(gates).toEqual({ v1: false, v2: false, v2OptInLookupFailed: true });
    expect((logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledWith(
      '[Mementos] V2 opt-in lookup failed; failing closed to V2 off for this turn',
      expect.objectContaining({ userId: 'user-1', error: 'mongo down' })
    );
  });

  it('fails closed to no-V1 when the admin-setting lookup rejects (never fails the turn)', async () => {
    // getSettingsValue is an uncached findOne and can reject; a rejection here must degrade to no
    // memory, not escape and fail an agent run that has otherwise completed.
    getSettingsValueMock.mockRejectedValue(new Error('mongo down'));
    const logger = makeLogger();
    const gates = await resolveExecutionMementoGates(makeExecution({ enableMementos: true }), makeAdapters(), logger);
    expect(gates).toEqual({ v1: false, v2: false, v2OptInLookupFailed: false });
    expect((logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledWith(
      '[Mementos] EnableMementos admin-setting lookup failed; failing closed to V1 off',
      expect.objectContaining({ userId: 'user-1', error: 'mongo down' })
    );
  });

  it('short-circuits both lookups on an explicit opt-out', async () => {
    const gates = await resolveExecutionMementoGates(
      makeExecution({ enableMementos: false }),
      makeAdapters(),
      makeLogger()
    );
    expect(gates).toEqual({ v1: false, v2: false, v2OptInLookupFailed: false });
    expect(getSettingsValueMock).not.toHaveBeenCalled();
    expect(isMementosV2EnabledMock).not.toHaveBeenCalled();
  });
});
