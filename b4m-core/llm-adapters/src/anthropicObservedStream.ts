import type { Anthropic } from '@anthropic-ai/sdk';
import type { MessageCreateParamsStreaming, RawMessageStreamEvent } from '@anthropic-ai/sdk/resources/messages';
// Mirrors the SDK's internal stream construction; re-verify on SDK upgrades.
import { Stream } from '@anthropic-ai/sdk/core/streaming';

export type ObservedMessageStream = AsyncIterable<RawMessageStreamEvent> & { controller?: AbortController };

type StreamRequestOptions = { signal?: AbortSignal; headers?: Record<string, string> };

/**
 * Opens a streaming Messages call and calls `onBytes` for every body chunk that arrives,
 * including the SSE `ping` keepalives the SDK's iterator drops before yielding. The idle
 * timer needs those: a model thinking silently still sends pings, and without them a live
 * connection looks identical to a dead one.
 *
 * Aborting the returned stream's `controller` cancels the underlying fetch, the same as
 * aborting a stream the SDK built itself.
 */
export async function openObservedMessageStream(
  api: Pick<Anthropic, 'messages'>,
  params: MessageCreateParamsStreaming,
  requestOptions: StreamRequestOptions,
  onBytes: () => void
): Promise<ObservedMessageStream> {
  const controller = new AbortController();
  const signal = requestOptions.signal
    ? AbortSignal.any([requestOptions.signal, controller.signal])
    : controller.signal;
  const pending = api.messages.create(params, { ...requestOptions, signal });

  // Test doubles return a plain async iterable rather than the SDK's APIPromise; there are no
  // raw bytes to observe, so hand back what they yield.
  if (typeof (pending as { asResponse?: unknown }).asResponse !== 'function') {
    return (await pending) as ObservedMessageStream;
  }

  const response = await pending.asResponse();
  if (!response.body) {
    return Stream.fromSSEResponse<RawMessageStreamEvent>(response, controller);
  }
  const observedBody = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, output) {
        onBytes();
        output.enqueue(chunk);
      },
    })
  );
  const observedResponse = new Response(observedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  return Stream.fromSSEResponse<RawMessageStreamEvent>(observedResponse, controller);
}
