import { describe, it, expect } from 'vitest';
import { resolveMementoGates } from './mementoGating';

describe('resolveMementoGates (#1319)', () => {
  describe('explicit false - the per-request opt-out', () => {
    it('disables BOTH pipelines regardless of admin setting and V2 opt-in', () => {
      expect(resolveMementoGates(false, true, true)).toEqual({ v1: false, v2: false });
      expect(resolveMementoGates(false, true, false)).toEqual({ v1: false, v2: false });
      expect(resolveMementoGates(false, false, true)).toEqual({ v1: false, v2: false });
      expect(resolveMementoGates(false, false, false)).toEqual({ v1: false, v2: false });
    });
  });

  describe('undefined - no preference expressed', () => {
    it('keeps V1 off (V1 requires explicit intent)', () => {
      expect(resolveMementoGates(undefined, true, false)).toEqual({ v1: false, v2: false });
    });

    it('lets V2 ride on the account-level opt-in (current-behavior preservation)', () => {
      expect(resolveMementoGates(undefined, true, true)).toEqual({ v1: false, v2: true });
      expect(resolveMementoGates(undefined, false, true)).toEqual({ v1: false, v2: true });
    });
  });

  describe('explicit true - V1 intent', () => {
    it('enables V1 only when the admin setting allows it', () => {
      expect(resolveMementoGates(true, true, false)).toEqual({ v1: true, v2: false });
      expect(resolveMementoGates(true, false, false)).toEqual({ v1: false, v2: false });
    });

    it('keeps V2 alongside V1 for a dual-opted user (inject side picks one, writes both)', () => {
      expect(resolveMementoGates(true, true, true)).toEqual({ v1: true, v2: true });
    });
  });

  it('V2 never consults the V1 admin setting - only the opt-in and the request flag', () => {
    expect(resolveMementoGates(undefined, false, true).v2).toBe(true);
    expect(resolveMementoGates(true, false, true).v2).toBe(true);
    expect(resolveMementoGates(false, false, true).v2).toBe(false);
  });
});
