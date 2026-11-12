import { describe, expect, it } from 'vitest';
import {
  admit,
  hardFloorBreached,
  laneCapFor,
  nextIdleDelay,
  parseMeminfo,
  parseSwapUsage,
  parseVmStat,
  type MachineSample,
} from './budget';

const GB = 1024 ** 3;
const idle: MachineSample = {
  cores: 16,
  freeBytes: 16 * GB,
  swapUsedBytes: 0,
  loadRatio: 0.2,
  diskFreeBytes: 200 * GB,
  onBattery: false,
  idleSeconds: 600,
};
const settings = { runOnBattery: false };

describe('admit', () => {
  it('admits an idle machine', () => {
    expect(admit(idle, undefined, 0, settings)).toEqual({ ok: true });
  });

  it.each([
    ['all lanes are busy', { cores: 4 }, 1],
    ['low memory', { freeBytes: 1.5 * GB }, 0],
    ['the machine is busy', { loadRatio: 0.8 }, 0],
    ['low disk', { diskFreeBytes: 19 * GB }, 0],
    ['on battery', { onBattery: true }, 0],
    ['you are active', { idleSeconds: 10 }, 1],
  ] as const)('holds a claim: %s', (reason, overrides, busy) => {
    expect(admit({ ...idle, ...overrides }, undefined, busy, settings)).toEqual({
      ok: false,
      reason: expect.stringContaining(reason),
    });
  });

  it('holds while swap is rising, even under the cap', () => {
    const before = { ...idle, swapUsedBytes: 0.5 * GB };
    expect(admit({ ...idle, swapUsedBytes: 1 * GB }, before, 0, settings)).toEqual({
      ok: false,
      reason: 'swap is rising',
    });
  });

  it('lets the first lane run while the user is active, and battery when allowed', () => {
    expect(admit({ ...idle, idleSeconds: 10 }, undefined, 0, settings)).toEqual({ ok: true });
    expect(admit({ ...idle, onBattery: true }, undefined, 0, { runOnBattery: true })).toEqual({ ok: true });
  });

  it('admits an 18 GB Mac in normal use: 3 GB free, 4.3 GB of swap that is not rising', () => {
    const mac = { ...idle, cores: 12, freeBytes: 3 * GB, swapUsedBytes: 4.3 * GB };
    expect(admit(mac, { ...mac, swapUsedBytes: 4.25 * GB }, 0, settings)).toEqual({ ok: true });
    expect(admit({ ...mac, swapUsedBytes: 4.5 * GB }, mac, 0, settings)).toEqual({
      ok: false,
      reason: 'swap is rising',
    });
  });

  it('runWhenBusy skips the memory, swap, load and activity holds only', () => {
    const busyOn = { runOnBattery: false, runWhenBusy: true };
    const strained = { ...idle, freeBytes: 0.5 * GB, swapUsedBytes: 9 * GB, loadRatio: 2, idleSeconds: 0 };
    expect(admit(strained, { ...idle, swapUsedBytes: 1 * GB }, 1, busyOn)).toEqual({ ok: true });
    expect(admit({ ...idle, freeBytes: 0.5 * GB }, undefined, 0, settings)).toMatchObject({ ok: false });
    expect(admit({ ...strained, cores: 4 }, undefined, 1, busyOn)).toEqual({ ok: false, reason: 'all lanes are busy' });
    expect(admit({ ...strained, onBattery: true }, undefined, 0, busyOn)).toEqual({ ok: false, reason: 'on battery' });
    expect(admit({ ...strained, diskFreeBytes: 5 * GB }, undefined, 0, busyOn)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('low disk'),
    });
  });
});

describe('nextIdleDelay', () => {
  it('doubles up to 10 s and stays there', () => {
    expect(nextIdleDelay(2_000)).toBe(4_000);
    expect(nextIdleDelay(10_000)).toBe(10_000);
    expect(nextIdleDelay(nextIdleDelay(10_000))).toBe(10_000);
  });
});

describe('laneCapFor', () => {
  it('is a quarter of the cores, 1 to 4, and only lowered by the setting', () => {
    expect(laneCapFor(2)).toBe(1);
    expect(laneCapFor(12)).toBe(3);
    expect(laneCapFor(64)).toBe(4);
    expect(laneCapFor(64, 2)).toBe(2);
    expect(laneCapFor(8, 9)).toBe(2);
  });
});

describe('hardFloorBreached', () => {
  it('trips below 10 GB free only', () => {
    expect(hardFloorBreached({ ...idle, diskFreeBytes: 9 * GB })).toMatch(/disk nearly full/);
    expect(hardFloorBreached({ ...idle, diskFreeBytes: 15 * GB })).toBeNull();
  });
});

describe('platform parsers', () => {
  it('reads vm_stat, swapusage and meminfo', () => {
    const vm =
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10.\nPages inactive: 20.\nPages purgeable: 2.\n';
    expect(parseVmStat(vm)).toBe(32 * 16384);
    expect(parseSwapUsage('vm.swapusage: total = 2048.00M  used = 1024.50M  free = 1023.50M')).toBe(1024.5 * 1024 ** 2);
    expect(parseMeminfo('MemAvailable: 100 kB\nSwapTotal: 50 kB\nSwapFree: 20 kB\n')).toEqual({
      free: 102400,
      swapUsed: 30720,
    });
  });
});
