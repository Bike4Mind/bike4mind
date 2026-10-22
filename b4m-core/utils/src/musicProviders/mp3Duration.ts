// MPEG audio Layer III only: every music provider we use returns MP3. Index 0 ("free") and 15 (bad) are unusable.
const BITRATES_KBPS = {
  mpeg1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  mpeg2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
} as const;
const MPEG1_SAMPLE_RATES = [44100, 48000, 32000] as const;
const ID3V2_HEADER_BYTES = 10;
const ID3V1_TAG_BYTES = 128;

type FrameHeader = {
  version: 1 | 2 | 2.5;
  bitrateKbps: number;
  sampleRate: number;
  mono: boolean;
  frameBytes: number;
  samplesPerFrame: number;
};

const parseFrameHeader = (bytes: Buffer, offset: number): FrameHeader | undefined => {
  if (offset + 4 > bytes.length) return undefined;
  const [b0, b1, b2, b3] = [bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]];
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return undefined;
  const versionBits = (b1 >> 3) & 0b11;
  const layerBits = (b1 >> 1) & 0b11;
  if (versionBits === 0b01 || layerBits !== 0b01) return undefined;
  const version = versionBits === 0b11 ? 1 : versionBits === 0b10 ? 2 : 2.5;
  const bitrateIndex = b2 >> 4;
  const sampleRateIndex = (b2 >> 2) & 0b11;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return undefined;
  const bitrateKbps = (version === 1 ? BITRATES_KBPS.mpeg1 : BITRATES_KBPS.mpeg2)[bitrateIndex];
  const sampleRate = MPEG1_SAMPLE_RATES[sampleRateIndex] / (version === 1 ? 1 : version === 2 ? 2 : 4);
  const samplesPerFrame = version === 1 ? 1152 : 576;
  const padding = (b2 >> 1) & 1;
  const frameBytes = Math.floor((samplesPerFrame / 8) * ((bitrateKbps * 1000) / sampleRate)) + padding;
  return { version, bitrateKbps, sampleRate, mono: b3 >> 6 === 0b11, frameBytes, samplesPerFrame };
};

// A lone 0xFFE could be inside the tag or a stray byte; a real frame is followed by another frame (or the end).
const isFrameAt = (bytes: Buffer, offset: number): FrameHeader | undefined => {
  const header = parseFrameHeader(bytes, offset);
  if (!header) return undefined;
  const next = offset + header.frameBytes;
  return next >= bytes.length - 4 || parseFrameHeader(bytes, next) ? header : undefined;
};

const id3v2Bytes = (bytes: Buffer): number => {
  if (bytes.length < ID3V2_HEADER_BYTES || bytes.toString('latin1', 0, 3) !== 'ID3') return 0;
  // Syncsafe: 7 bits per byte.
  const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
  const hasFooter = (bytes[5] & 0x10) !== 0;
  return ID3V2_HEADER_BYTES + size + (hasFooter ? ID3V2_HEADER_BYTES : 0);
};

// A Xing/Info frame (written by most VBR encoders) carries the exact frame count.
const xingFrameCount = (bytes: Buffer, frameStart: number, header: FrameHeader): number | undefined => {
  const sideInfoBytes = header.version === 1 ? (header.mono ? 17 : 32) : header.mono ? 9 : 17;
  const tagAt = frameStart + 4 + sideInfoBytes;
  if (tagAt + 12 > bytes.length) return undefined;
  const tag = bytes.toString('latin1', tagAt, tagAt + 4);
  if (tag !== 'Xing' && tag !== 'Info') return undefined;
  const hasFrameCount = (bytes.readUInt32BE(tagAt + 4) & 0x1) !== 0;
  return hasFrameCount ? bytes.readUInt32BE(tagAt + 8) : undefined;
};

/**
 * Playing time of an MP3 in seconds, read from the bytes rather than trusted from the request (a prompt-steered
 * model may run long or short). Exact with a Xing/Info header, else estimated from the first frame's bitrate,
 * which is exact for constant-bitrate output. Undefined when no MPEG Layer III frame is found.
 */
export const mp3DurationSeconds = (bytes: Buffer): number | undefined => {
  let offset = id3v2Bytes(bytes);
  let header: FrameHeader | undefined;
  for (; offset < bytes.length - 4; offset++) {
    header = isFrameAt(bytes, offset);
    if (header) break;
  }
  if (!header) return undefined;
  const frames = xingFrameCount(bytes, offset, header);
  if (frames !== undefined) return (frames * header.samplesPerFrame) / header.sampleRate;
  const hasId3v1 =
    bytes.length >= ID3V1_TAG_BYTES &&
    bytes.toString('latin1', bytes.length - ID3V1_TAG_BYTES, bytes.length - 125) === 'TAG';
  const audioBytes = bytes.length - offset - (hasId3v1 ? ID3V1_TAG_BYTES : 0);
  return (audioBytes * 8) / (header.bitrateKbps * 1000);
};
