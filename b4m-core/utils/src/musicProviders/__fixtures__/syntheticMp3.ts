// Test-only MP3 builder: silent MPEG-1 Layer III frames, so no binary audio is committed.
const MPEG1_LAYER3_NO_CRC = 0xfb;
const BITRATE_INDEX: Record<number, number> = { 128: 9, 192: 11 };
const SAMPLES_PER_FRAME = 1152;
const SAMPLE_RATE = 44100;

type Options = { frames: number; bitrateKbps?: 128 | 192; id3Bytes?: number; xingFrames?: number };

const frameBytes = (bitrateKbps: number): number => Math.floor((144 * bitrateKbps * 1000) / SAMPLE_RATE);

const frame = (bitrateKbps: number): Buffer => {
  const bytes = Buffer.alloc(frameBytes(bitrateKbps));
  bytes[0] = 0xff;
  bytes[1] = MPEG1_LAYER3_NO_CRC;
  bytes[2] = BITRATE_INDEX[bitrateKbps] << 4; // 44.1 kHz, no padding
  bytes[3] = 0x00; // stereo
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

export const syntheticMp3 = ({ frames, bitrateKbps = 128, id3Bytes, xingFrames }: Options): Buffer => {
  const body = Array.from({ length: frames }, () => frame(bitrateKbps));
  if (xingFrames !== undefined) {
    // MPEG-1 stereo: 32 bytes of side info after the 4-byte header.
    body[0].write('Xing', 36, 'latin1');
    body[0].writeUInt32BE(0x1, 40);
    body[0].writeUInt32BE(xingFrames, 44);
  }
  return Buffer.concat([...(id3Bytes !== undefined ? [id3v2(id3Bytes)] : []), ...body]);
};

/** Seconds a CBR stream of `frames` frames plays, as the duration reader estimates it. */
export const syntheticMp3Seconds = (frames: number, bitrateKbps: 128 | 192 = 128): number =>
  (frames * frameBytes(bitrateKbps) * 8) / (bitrateKbps * 1000);

export const SYNTHETIC_FRAME_SECONDS = SAMPLES_PER_FRAME / SAMPLE_RATE;
