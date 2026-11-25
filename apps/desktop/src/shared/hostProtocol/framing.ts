import { HOST_ERROR_CODES, parseHostMessage, type HostError, type HostMessage } from './envelope';

/** In UTF-16 code units (string length): the decoder works on decoded strings, not bytes. */
export const MAX_HOST_FRAME_LENGTH = 16 * 1024 * 1024;

export type HostFrame = { ok: true; message: HostMessage } | { ok: false; error: HostError };

export function encodeHostFrame(message: HostMessage): string {
  return `${JSON.stringify(message)}\n`;
}

const oversizeFrame = (): HostFrame => ({
  ok: false,
  error: {
    code: HOST_ERROR_CODES.invalidRequest,
    message: `Frame exceeds ${MAX_HOST_FRAME_LENGTH} characters`,
  },
});

function decodeLine(line: string): HostFrame | null {
  if (line.trim() === '') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, error: { code: HOST_ERROR_CODES.parseError, message: 'Frame is not valid JSON' } };
  }
  return parseHostMessage(raw);
}

/** Splits a text stream into messages. One bad line costs only itself: decoding carries on after it. */
export function createHostFrameDecoder(): { push(chunk: string): HostFrame[] } {
  let buffer = '';
  let discarding = false;

  return {
    push(chunk) {
      const frames: HostFrame[] = [];
      let rest = chunk;
      while (rest.length > 0) {
        const newline = rest.indexOf('\n');
        if (newline === -1) {
          if (discarding) return frames;
          buffer += rest;
          if (buffer.length > MAX_HOST_FRAME_LENGTH) {
            frames.push(oversizeFrame());
            buffer = '';
            discarding = true;
          }
          return frames;
        }
        const segment = rest.slice(0, newline);
        rest = rest.slice(newline + 1);
        if (discarding) {
          discarding = false;
          continue;
        }
        const line = buffer + segment;
        buffer = '';
        if (line.length > MAX_HOST_FRAME_LENGTH) {
          frames.push(oversizeFrame());
          continue;
        }
        const frame = decodeLine(line);
        if (frame) frames.push(frame);
      }
      return frames;
    },
  };
}
