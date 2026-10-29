import { describe, expect, it } from 'vitest';
import type { HubTier } from '../schemas/modelHub';
import { machine } from './__fixtures__/hubManifest';
import { curatedTier, hardwareClass } from './tiers';

const PICKS: HubTier['picks'] = [{ slot: 'best', entry: 'an-entry', build: 'a-build' }];
const tier = (memoryKind: HubTier['memoryKind'], minGiB: number, picks: HubTier['picks'] = PICKS): HubTier => ({
  memoryKind,
  minGiB,
  picks,
});
const TIERS = [tier('discrete', 0), tier('discrete', 8), tier('discrete', 16), tier('unified', 16), tier('cpu', 0)];
const GIB = 1024 ** 3;

describe('curatedTier', () => {
  it.each([
    ['a 16 GB card that reports 15.9 GiB', machine('discrete', 64, 15.9), 'discrete', 16],
    ['a 12 GB card', machine('discrete', 32, 12), 'discrete', 8],
    ['a 4 GB card', machine('discrete', 16, 4), 'discrete', 0],
    ['a 32 GB Mac', machine('unified', 32), 'unified', 16],
    ['a CPU-only box', machine('cpu', 62), 'cpu', 0],
    ['a discrete box whose GPU memory is unknown', machine('discrete', 62), 'cpu', 0],
    ['two 8 GB cards, by their summed memory', { ...machine('discrete', 64, 15.9), gpuCount: 2 }, 'discrete', 16],
  ])('picks the largest tier %s reaches', (_label, hw, kind, minGiB) => {
    expect(curatedTier(TIERS, hw)).toMatchObject({ memoryKind: kind, minGiB });
  });

  it('returns null when the list has no tier for the class or the memory', () => {
    expect(curatedTier([tier('unified', 32)], machine('unified', 16))).toBeNull();
    expect(curatedTier([], machine('cpu', 64))).toBeNull();
  });

  it('skips a tier with no picks so a smaller tier that has them wins', () => {
    const tiers = [tier('discrete', 8), tier('discrete', 16, [])];
    expect(curatedTier(tiers, machine('discrete', 64, 24))).toMatchObject({ minGiB: 8 });
    expect(curatedTier([tier('cpu', 0, [])], machine('cpu', 64))).toBeNull();
  });

  it('classes a machine by its GPU memory on a discrete GPU and its total memory otherwise', () => {
    expect(hardwareClass(machine('discrete', 64, 24))).toEqual({ memoryKind: 'discrete', memoryBytes: 24 * GIB });
    expect(hardwareClass(machine('unified', 64))).toEqual({ memoryKind: 'unified', memoryBytes: 64 * GIB });
  });
});
