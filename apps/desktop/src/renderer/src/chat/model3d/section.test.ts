import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  clampOffset,
  DEFAULT_SECTION,
  flipped,
  keptBy,
  sectionPlane,
  sectionPosition,
  setClipPlane,
  withAxis,
  withOffset,
} from './section';

// World-space bounds: the model's z is world y and its y is world -z (modelFrame.ts).
const box = new THREE.Box3(new THREE.Vector3(-10, 0, 100), new THREE.Vector3(30, 20, 110));

describe('sectionPosition', () => {
  it('places the cut its share of the way across the chosen model axis', () => {
    expect(sectionPosition({ axis: 'x', offset: 0.25, flipped: false }, box)).toBe(0);
    expect(sectionPosition({ axis: 'y', offset: 1, flipped: false }, box)).toBe(-100);
    expect(sectionPosition({ axis: 'z', offset: 0, flipped: true }, box)).toBe(0);
  });
});

describe('sectionPlane', () => {
  it('keeps the low side of the axis unless flipped', () => {
    const plane = sectionPlane({ axis: 'x', offset: 0.5, flipped: false }, box);
    expect(keptBy(plane, new THREE.Vector3(0, 10, 105))).toBe(true);
    expect(keptBy(plane, new THREE.Vector3(20, 10, 105))).toBe(false);
    const other = sectionPlane({ axis: 'x', offset: 0.5, flipped: true }, box);
    expect(keptBy(other, new THREE.Vector3(0, 10, 105))).toBe(false);
    expect(keptBy(other, new THREE.Vector3(20, 10, 105))).toBe(true);
  });

  it("cuts the model's z (up) across the world y", () => {
    const plane = sectionPlane({ axis: 'z', offset: 0.3, flipped: false }, box);
    expect(plane.normal.y).toBe(-1);
    expect(Math.abs(plane.normal.x) + Math.abs(plane.normal.z)).toBe(0);
    expect(plane.distanceToPoint(new THREE.Vector3(5, 6, 103))).toBeCloseTo(0);
    expect(keptBy(plane, new THREE.Vector3(5, 2, 103))).toBe(true);
  });

  it("cuts the model's y across the world z, keeping its low side", () => {
    const plane = sectionPlane({ axis: 'y', offset: 0.5, flipped: false }, box);
    expect(plane.distanceToPoint(new THREE.Vector3(0, 10, 105))).toBeCloseTo(0);
    expect(keptBy(plane, new THREE.Vector3(0, 10, 108))).toBe(true);
    expect(keptBy(plane, new THREE.Vector3(0, 10, 102))).toBe(false);
  });

  it('writes into a given plane', () => {
    const target = new THREE.Plane();
    expect(sectionPlane(DEFAULT_SECTION, box, target)).toBe(target);
  });
});

describe('section state', () => {
  it('clamps the offset and falls back to the middle', () => {
    expect(clampOffset(-1)).toBe(0);
    expect(clampOffset(2)).toBe(1);
    expect(clampOffset(Number.NaN)).toBe(0.5);
    expect(withOffset(DEFAULT_SECTION, 1.5).offset).toBe(1);
  });

  it('changes axis and flips without touching the rest', () => {
    const state = { axis: 'x' as const, offset: 0.2, flipped: false };
    expect(withAxis(state, 'y')).toEqual({ axis: 'y', offset: 0.2, flipped: false });
    expect(flipped(state)).toEqual({ axis: 'x', offset: 0.2, flipped: true });
    expect(flipped(flipped(state))).toEqual(state);
  });

  it('keeps everything when there is no plane', () => {
    expect(keptBy(null, new THREE.Vector3(1e6, 0, 0))).toBe(true);
  });
});

describe('setClipPlane', () => {
  it('adds and removes its plane beside a build-in plane', () => {
    const material = new THREE.MeshStandardMaterial();
    const build = new THREE.Plane();
    const cut = new THREE.Plane();
    setClipPlane(material, build, true);
    setClipPlane(material, cut, true);
    setClipPlane(material, cut, true);
    expect(material.clippingPlanes).toEqual([build, cut]);
    expect(material.clipShadows).toBe(true);
    setClipPlane(material, build, false);
    expect(material.clippingPlanes).toEqual([cut]);
    setClipPlane(material, cut, false);
    expect(material.clippingPlanes).toBeNull();
  });
});
