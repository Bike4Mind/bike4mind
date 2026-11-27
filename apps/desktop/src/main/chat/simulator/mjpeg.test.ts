import { describe, expect, it } from 'vitest';
import { MjpegParser } from './mjpeg';

const part = (body: Buffer) =>
  Buffer.concat([
    Buffer.from(`--boundary\r\nContent-Type: image/jpeg\r\nContent-Length: ${body.length}\r\n\r\n`),
    body,
    Buffer.from('\r\n'),
  ]);

const FRAME_ONE = Buffer.from([0xff, 0xd8, 1, 2, 3, 4, 5, 0xff, 0xd9]);
const FRAME_TWO = Buffer.from([0xff, 0xd8, 9, 8, 7, 0xff, 0xd9]);
const STATUS = Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=boundary\r\n\r\n');

function parse(chunks: Buffer[]): Buffer[] {
  const frames: Buffer[] = [];
  const parser = new MjpegParser(jpeg => frames.push(jpeg));
  for (const chunk of chunks) parser.push(chunk);
  return frames;
}

function splitAt(stream: Buffer, points: number[]): Buffer[] {
  const bounds = [0, ...points, stream.length];
  return bounds.slice(1).map((end, index) => stream.subarray(bounds[index], end));
}

describe('MjpegParser', () => {
  const stream = Buffer.concat([STATUS, part(FRAME_ONE), part(FRAME_TWO)]);

  it('yields both frames byte-exact from one chunk, skipping the HTTP status block', () => {
    expect(parse([stream])).toEqual([FRAME_ONE, FRAME_TWO]);
  });

  it('survives every possible single split point, inside headers and bodies', () => {
    for (let at = 1; at < stream.length; at++) {
      expect(parse(splitAt(stream, [at])), `split at ${at}`).toEqual([FRAME_ONE, FRAME_TWO]);
    }
  });

  it('survives one byte at a time', () => {
    expect(
      parse(
        splitAt(
          stream,
          Array.from({ length: stream.length - 1 }, (_, index) => index + 1)
        )
      )
    ).toEqual([FRAME_ONE, FRAME_TWO]);
  });

  it('does not emit a frame until its body is complete', () => {
    const frames: Buffer[] = [];
    const parser = new MjpegParser(jpeg => frames.push(jpeg));
    const whole = part(FRAME_ONE);
    parser.push(whole.subarray(0, whole.length - 6));
    expect(frames).toEqual([]);
    parser.push(whole.subarray(whole.length - 6));
    expect(frames).toEqual([FRAME_ONE]);
  });

  it('gives frames that do not alias the input chunk', () => {
    const chunk = part(FRAME_ONE);
    const [frame] = parse([chunk]);
    chunk.fill(0);
    expect(frame).toEqual(FRAME_ONE);
  });
});
