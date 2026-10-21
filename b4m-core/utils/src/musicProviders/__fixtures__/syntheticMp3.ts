// Test-only MP3 builder: silent Layer III frames, so no binary audio is committed.
const LAYER3_NO_CRC = { mpeg1: 0xfb, mpeg2: 0xf3 } as const;
// Index into the Layer III bitrate table of each version.
const BITRATE_INDEX = { mpeg1: { 128: 9, 192: 11 }, mpeg2: { 128: 12, 64: 8 } } as const;
const SAMPLE_RATE = { mpeg1: 44100, mpeg2: 22050 } as const;
const SAMPLES_PER_FRAME = { mpeg1: 1152, mpeg2: 576 } as const;
const MONO = 0b11 << 6;

type Version = 'mpeg1' | 'mpeg2';
type Options = {
  frames: number;
  version?: Version;
  bitrateKbps?: 64 | 128 | 192;
  mono?: boolean;
  id3Bytes?: number;
  xingFrames?: number;
};

const frameBytes = (version: Version, bitrateKbps: number): number =>
  Math.floor(((SAMPLES_PER_FRAME[version] / 8) * bitrateKbps * 1000) / SAMPLE_RATE[version]);

const frame = (version: Version, bitrateKbps: number, mono: boolean): Buffer => {
  const bytes = Buffer.alloc(frameBytes(version, bitrateKbps));
  const indexes: Record<number, number> = BITRATE_INDEX[version];
  bytes[0] = 0xff;
  bytes[1] = LAYER3_NO_CRC[version];
  bytes[2] = indexes[bitrateKbps] << 4; // sample-rate index 0, no padding
  bytes[3] = mono ? MONO : 0x00;
  return bytes;
};

const id3v2 = (payloadBytes: number): Buffer => {
  const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]);
  header[6] = (payloadBytes >> 21) & 0x7f;
  header[7] = (payloadBytes >> 14) & 0x7f;
  header[8] = (payloadBytes >> 7) & 0x7f;
  header[9] = payloadBytes & 0x7f;
  return Buffer.concat([header, Buffer.alloc(payloadBytes)]);
};

// Bytes of side information between the 4-byte header and a Xing tag (ISO 11172-3 / 13818-3).
const sideInfoBytes = (version: Version, mono: boolean): number =>
  version === 'mpeg1' ? (mono ? 17 : 32) : mono ? 9 : 17;

export const syntheticMp3 = ({
  frames,
  version = 'mpeg1',
  bitrateKbps = 128,
  mono = false,
  id3Bytes,
  xingFrames,
}: Options): Buffer => {
  const body = Array.from({ length: frames }, () => frame(version, bitrateKbps, mono));
  if (xingFrames !== undefined) {
    const at = 4 + sideInfoBytes(version, mono);
    body[0].write('Xing', at, 'latin1');
    body[0].writeUInt32BE(0x1, at + 4);
    body[0].writeUInt32BE(xingFrames, at + 8);
  }
  return Buffer.concat([...(id3Bytes !== undefined ? [id3v2(id3Bytes)] : []), ...body]);
};

/** Seconds a CBR stream of `frames` frames plays, as the duration reader estimates it. */
export const syntheticMp3Seconds = (frames: number, bitrateKbps: 64 | 128 | 192 = 128, version: Version = 'mpeg1') =>
  (frames * frameBytes(version, bitrateKbps) * 8) / (bitrateKbps * 1000);

/** Exact seconds of `frames` frames, as a Xing header reports them. */
export const xingSeconds = (frames: number, version: Version = 'mpeg1'): number =>
  (frames * SAMPLES_PER_FRAME[version]) / SAMPLE_RATE[version];
