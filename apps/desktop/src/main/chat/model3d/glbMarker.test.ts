import { describe, expect, it } from 'vitest';
import { isModelPaneGlb, stampModelPaneGlb } from './glbMarker';

/** A GLB with a JSON chunk and a 4-byte BIN chunk, laid out as the spec requires. */
function glbWithBin(asset: Record<string, unknown>): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify({ asset, buffers: [{ byteLength: 4 }] }).padEnd(80));
  const bin = new Uint8Array([9, 8, 7, 6]);
  const out = new Uint8Array(12 + 8 + json.byteLength + 8 + bin.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.byteLength, true);
  view.setUint32(12, json.byteLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(json, 20);
  view.setUint32(20 + json.byteLength, bin.byteLength, true);
  view.setUint32(24 + json.byteLength, 0x004e4942, true);
  out.set(bin, 28 + json.byteLength);
  return out;
}

describe('glbMarker', () => {
  it('stamps the marker and keeps the rest of the asset and the BIN chunk intact', () => {
    const stamped = stampModelPaneGlb(
      glbWithBin({ version: '2.0', generator: 'THREE.GLTFExporter', extras: { a: 1 } })
    );
    expect(isModelPaneGlb(stamped)).toBe(true);
    const view = new DataView(stamped.buffer);
    expect(view.getUint32(8, true)).toBe(stamped.byteLength);
    const jsonLength = view.getUint32(12, true);
    expect(jsonLength % 4).toBe(0);
    const json = JSON.parse(new TextDecoder().decode(stamped.subarray(20, 20 + jsonLength)));
    expect(json.asset).toEqual({
      version: '2.0',
      generator: 'THREE.GLTFExporter',
      extras: { a: 1, bike4mindModel: true },
    });
    expect(json.buffers).toEqual([{ byteLength: 4 }]);
    expect([...stamped.subarray(stamped.byteLength - 4)]).toEqual([9, 8, 7, 6]);
    expect(view.getUint32(20 + jsonLength + 4, true)).toBe(0x004e4942);
  });

  it('does not see the marker on a GLB made elsewhere, or on bytes that are not a GLB', () => {
    expect(isModelPaneGlb(glbWithBin({ version: '2.0', generator: 'Blender' }))).toBe(false);
    expect(isModelPaneGlb(glbWithBin({ version: '2.0', extras: { bike4mindModel: 'yes' } }))).toBe(false);
    expect(isModelPaneGlb(new TextEncoder().encode('glTF but not really a binary container'))).toBe(false);
  });

  it('refuses to stamp bytes that are not a GLB', () => {
    expect(() => stampModelPaneGlb(new Uint8Array([1, 2, 3]))).toThrow(/not a GLB/);
  });
});
