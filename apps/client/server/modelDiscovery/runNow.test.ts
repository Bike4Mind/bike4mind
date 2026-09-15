/**
 * The "Run now" dispatch seam picks a driver by deployment kind, and the hosted
 * one must degrade to a clear error rather than crash when the link is missing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';

const { lambdaSend, runScheduledDiscovery, resource } = vi.hoisted(() => ({
  lambdaSend: vi.fn(async () => ({ StatusCode: 202 })),
  runScheduledDiscovery: vi.fn(async () => ({ outcome: 'ok' })),
  resource: { lambdaFunctionNames: { modelDiscovery: 'dev-model-discovery-fn' } } as {
    lambdaFunctionNames?: Record<string, string | undefined>;
  },
}));

vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: vi.fn(function () {
    return { send: lambdaSend };
  }),
  InvokeCommand: vi.fn(function (input: unknown) {
    return input;
  }),
}));
vi.mock('sst', () => ({ Resource: resource }));
vi.mock('./scheduledRun', () => ({ runScheduledDiscovery }));
// The real module pulls in the whole source registry; only the gate matters here.
vi.mock('./startupLeg', () => ({
  DISCOVERY_DRIVER_ENV: 'B4M_DISCOVERY_DRIVER',
  isDiscoveryDriver: () => process.env.B4M_DISCOVERY_DRIVER === 'true',
}));

import { dispatchDiscoveryRunNow, DiscoveryDispatchUnavailableError } from './runNow';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

describe('dispatchDiscoveryRunNow', () => {
  const selfHostFlag = process.env.B4M_SELF_HOST;
  const driverFlag = process.env.B4M_DISCOVERY_DRIVER;

  beforeEach(() => {
    vi.clearAllMocks();
    resource.lambdaFunctionNames = { modelDiscovery: 'dev-model-discovery-fn' };
    delete process.env.B4M_SELF_HOST;
    process.env.B4M_DISCOVERY_DRIVER = 'true';
  });

  afterEach(() => {
    if (selfHostFlag === undefined) delete process.env.B4M_SELF_HOST;
    else process.env.B4M_SELF_HOST = selfHostFlag;
    if (driverFlag === undefined) delete process.env.B4M_DISCOVERY_DRIVER;
    else process.env.B4M_DISCOVERY_DRIVER = driverFlag;
  });

  it('async-invokes the discovery function with a manual trigger on hosted', async () => {
    await expect(dispatchDiscoveryRunNow(logger)).resolves.toEqual({ dispatched: 'lambda' });

    expect(lambdaSend).toHaveBeenCalledTimes(1);
    const command = lambdaSend.mock.calls[0][0] as unknown as {
      FunctionName: string;
      InvocationType: string;
      Payload: Buffer;
    };
    expect(command.FunctionName).toBe('dev-model-discovery-fn');
    expect(command.InvocationType).toBe('Event');
    expect(JSON.parse(command.Payload.toString())).toEqual({ trigger: 'manual' });
    expect(runScheduledDiscovery).not.toHaveBeenCalled();
  });

  it('refuses with an unavailable error when the function is not linked', async () => {
    resource.lambdaFunctionNames = undefined;

    await expect(dispatchDiscoveryRunNow(logger)).rejects.toBeInstanceOf(DiscoveryDispatchUnavailableError);
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  it('runs in-process on self-host and does not wait for the run', async () => {
    process.env.B4M_SELF_HOST = 'true';
    let release = () => {};
    runScheduledDiscovery.mockImplementationOnce(
      () => new Promise(resolve => (release = () => resolve({ outcome: 'ok' })))
    );

    await expect(dispatchDiscoveryRunNow(logger)).resolves.toEqual({ dispatched: 'in-process' });

    expect(runScheduledDiscovery).toHaveBeenCalledWith(logger, 'selfhost', { trigger: 'manual' });
    expect(lambdaSend).not.toHaveBeenCalled();
    release();
  });

  it('refuses the in-process run when this process is not a discovery driver', async () => {
    process.env.B4M_SELF_HOST = 'true';
    delete process.env.B4M_DISCOVERY_DRIVER;

    await expect(dispatchDiscoveryRunNow(logger)).rejects.toThrow(/B4M_DISCOVERY_DRIVER=true/);
    await expect(dispatchDiscoveryRunNow(logger)).rejects.toBeInstanceOf(DiscoveryDispatchUnavailableError);
    expect(runScheduledDiscovery).not.toHaveBeenCalled();
  });

  it('does not read the driver flag on hosted, where the cron lambda is the driver', async () => {
    delete process.env.B4M_DISCOVERY_DRIVER;

    await expect(dispatchDiscoveryRunNow(logger)).resolves.toEqual({ dispatched: 'lambda' });
    expect(lambdaSend).toHaveBeenCalledTimes(1);
  });

  it('logs rather than rejects when the in-process run throws', async () => {
    process.env.B4M_SELF_HOST = 'true';
    runScheduledDiscovery.mockRejectedValueOnce(new Error('providers unreachable'));

    await expect(dispatchDiscoveryRunNow(logger)).resolves.toEqual({ dispatched: 'in-process' });

    await vi.waitFor(() =>
      expect(logger.error).toHaveBeenCalledWith('[model-discovery] manual run failed', {
        error: 'providers unreachable',
      })
    );
  });
});
