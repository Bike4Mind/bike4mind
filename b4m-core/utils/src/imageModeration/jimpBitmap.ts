/** A Jimp image over raw RGBA pixels. */
export async function jimpFromRgba(data: Uint8Array | Uint8ClampedArray, width: number, height: number) {
  // Dynamic import mirrors ensureImageWithinDimensionLimit in llm/utils.ts: a static jimp
  // import makes bundlers (CLI's tsdown) treat it as external even where it's never called.
  const { Jimp } = await import('jimp');
  // Unpooled copy: jimp's fromBitmap re-reads a Buffer's whole backing ArrayBuffer from offset 0,
  // so a pooled Buffer.from() slice (or a view into a larger buffer) would encode the wrong bytes.
  const pixels = Buffer.alloc(data.length);
  pixels.set(data);
  return Jimp.fromBitmap({ data: pixels, width, height });
}
