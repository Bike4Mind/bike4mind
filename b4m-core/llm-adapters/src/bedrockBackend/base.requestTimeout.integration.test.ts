import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

/**
 * Drives a REAL BedrockRuntimeClient, configured the way base.ts configures it, against a local
 * HTTP/2 server that accepts the request and never answers - the shape of the production hang.
 *
 * This is the drift guard for BEDROCK_REQUEST_HANDLER. base.ts declares its option names in a
 * local type (see BedrockHttp2HandlerOptions) to avoid taking a direct @smithy dependency, so
 * nothing at compile time proves those names still mean anything to the SDK. Here they have to:
 * if `requestTimeout` were renamed, ignored, or replaced by an h1-only knob, no timer would arm
 * and these tests would time out instead of passing.
 *
 * Timeouts are small so the suite stays fast; only the ratios matter. maxAttempts is 1 because
 * TimeoutError is retryable and the real client would otherwise burn 6 attempts per assertion.
 */

const TIMEOUT_MS = 300;

describe('BedrockRuntimeClient transport timeout (real client)', () => {
  let server: http2.Http2Server;
  let endpoint: string;
  let onStream: (stream: http2.ServerHttp2Stream) => void;

  beforeEach(async () => {
    server = http2.createServer();
    server.on('stream', stream => onStream(stream));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  function makeClient(requestTimeout = TIMEOUT_MS) {
    return new BedrockRuntimeClient({
      region: 'us-east-1',
      endpoint,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      maxAttempts: 1,
      // Mirrors BEDROCK_REQUEST_HANDLER in base.ts.
      requestHandler: { requestTimeout, sessionTimeout: requestTimeout + 100, disableConcurrentStreams: true },
    });
  }

  const command = () =>
    new InvokeModelCommand({
      modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({ prompt: 'hi' }),
    });

  it('uses the h2 handler, so h1 timeout knobs would be no-ops', () => {
    const client = makeClient();
    expect(client.config.requestHandler.metadata?.handlerProtocol).toMatch(/^h2/);
  });

  // The incident: request accepted, nothing ever comes back. Must reject, not hang.
  it('rejects a stalled request instead of hanging forever', async () => {
    onStream = () => {
      /* accept and never respond */
    };

    const started = Date.now();
    await expect(makeClient().send(command())).rejects.toMatchObject({ name: 'TimeoutError' });

    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(5_000);
  });

  // Proves requestTimeout is an INACTIVITY timer, not a total-duration cap: a response that
  // takes far longer than the timeout while still making progress must survive. This is what
  // makes the 120s production value safe for long streaming completions.
  it('does not kill a slow-but-active response whose total time exceeds the timeout', async () => {
    const CHUNKS = 10;
    const GAP_MS = 100; // total ~1s, well past TIMEOUT_MS

    onStream = stream => {
      stream.respond({ ':status': 200, 'content-type': 'application/json' });
      let sent = 0;
      const tick = setInterval(() => {
        if (sent++ >= CHUNKS) {
          clearInterval(tick);
          stream.end('"}');
          return;
        }
        stream.write(sent === 1 ? '{"completion":"x' : 'x');
      }, GAP_MS);
    };

    const started = Date.now();
    const response = await makeClient().send(command());
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThan(TIMEOUT_MS);
    expect(new TextDecoder().decode(response.body)).toContain('completion');
  });

  /**
   * Worth knowing before relying on this fix to surface errors: once response headers have
   * arrived the send() promise has already resolved, and the stream timer fires
   * Http2Stream.close(), a graceful NGHTTP2_NO_ERROR close. So a stall PART-WAY THROUGH a
   * response is bounded but does NOT reject - the caller gets a truncated body and no error.
   *
   * That is still a large improvement over the unbounded hang, but it means a mid-response
   * Bedrock stall degrades silently rather than loudly. Detecting that needs a guard above the
   * transport; base.ts only fails loud on a response that produced nothing at all.
   */
  it('bounds a stall after headers, but truncates silently rather than erroring', async () => {
    onStream = stream => {
      stream.respond({ ':status': 200, 'content-type': 'application/json' });
      stream.write('{"completion":"partial');
      // then go silent, holding the stream open
    };

    const started = Date.now();
    const response = await makeClient().send(command());
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(5_000); // bounded, not hung
    const body = new TextDecoder().decode(response.body);
    expect(body).toBe('{"completion":"partial'); // truncated, and no error was raised
  });
});
