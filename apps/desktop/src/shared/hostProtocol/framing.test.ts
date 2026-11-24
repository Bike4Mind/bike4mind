import { describe, expect, it } from 'vitest';
import { HOST_ERROR_CODES, hostNotification, hostRequest } from './envelope';
import { MAX_HOST_FRAME_LENGTH, createHostFrameDecoder, encodeHostFrame } from './framing';

const request = hostRequest(1, 'host/info');
const notification = hostNotification('host/stateChanged', { account: null });

describe('host frame codec', () => {
  it('encodes one message as one newline-terminated line', () => {
    const frame = encodeHostFrame(request);
    expect(frame.endsWith('\n')).toBe(true);
    expect(frame.slice(0, -1)).not.toContain('\n');
    expect(createHostFrameDecoder().push(frame)).toEqual([{ ok: true, message: request }]);
  });

  it('joins one frame split across three chunks', () => {
    const decoder = createHostFrameDecoder();
    const frame = encodeHostFrame(request);
    const third = Math.floor(frame.length / 3);
    expect(decoder.push(frame.slice(0, third))).toEqual([]);
    expect(decoder.push(frame.slice(third, third * 2))).toEqual([]);
    expect(decoder.push(frame.slice(third * 2))).toEqual([{ ok: true, message: request }]);
  });

  it('yields two frames from one chunk', () => {
    const frames = createHostFrameDecoder().push(encodeHostFrame(request) + encodeHostFrame(notification));
    expect(frames).toEqual([
      { ok: true, message: request },
      { ok: true, message: notification },
    ]);
  });

  it('holds a trailing partial frame until it completes', () => {
    const decoder = createHostFrameDecoder();
    const second = encodeHostFrame(notification);
    expect(decoder.push(encodeHostFrame(request) + second.slice(0, 10))).toEqual([{ ok: true, message: request }]);
    expect(decoder.push(second.slice(10))).toEqual([{ ok: true, message: notification }]);
  });

  it('ignores empty lines', () => {
    expect(createHostFrameDecoder().push(`\n\n${encodeHostFrame(request)}\n`)).toEqual([
      { ok: true, message: request },
    ]);
  });

  it('reports invalid JSON and keeps decoding the lines around it', () => {
    const frames = createHostFrameDecoder().push(
      `${encodeHostFrame(request)}{not json\n${encodeHostFrame(notification)}`
    );
    expect(frames).toHaveLength(3);
    expect(frames[0]).toEqual({ ok: true, message: request });
    expect(frames[1]).toMatchObject({ ok: false, error: { code: HOST_ERROR_CODES.parseError } });
    expect(frames[2]).toEqual({ ok: true, message: notification });
  });

  it('reports valid JSON that is not a host message as invalidRequest', () => {
    expect(createHostFrameDecoder().push('{"hello":"world"}\n')).toMatchObject([
      { ok: false, error: { code: HOST_ERROR_CODES.invalidRequest } },
    ]);
  });

  it('tolerates CRLF line endings', () => {
    const crlf = `${JSON.stringify(request)}\r\n${JSON.stringify(notification)}\r\n`;
    expect(createHostFrameDecoder().push(crlf)).toEqual([
      { ok: true, message: request },
      { ok: true, message: notification },
    ]);
  });

  it('drops an oversize line with one error and recovers on the next line', () => {
    const decoder = createHostFrameDecoder();
    const huge = 'x'.repeat(MAX_HOST_FRAME_LENGTH + 1);
    const frames = [
      ...decoder.push(huge.slice(0, MAX_HOST_FRAME_LENGTH)),
      ...decoder.push(huge.slice(MAX_HOST_FRAME_LENGTH)),
      ...decoder.push('still the same line'),
      ...decoder.push(`\n${encodeHostFrame(request)}`),
    ];
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ ok: false, error: { code: HOST_ERROR_CODES.invalidRequest } });
    expect(frames[1]).toEqual({ ok: true, message: request });
  });

  it('reports an oversize line that arrives whole, with its newline', () => {
    const frames = createHostFrameDecoder().push(
      `${'x'.repeat(MAX_HOST_FRAME_LENGTH + 1)}\n${encodeHostFrame(request)}`
    );
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ ok: false, error: { code: HOST_ERROR_CODES.invalidRequest } });
    expect(frames[1]).toEqual({ ok: true, message: request });
  });
});
