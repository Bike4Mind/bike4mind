import type { LoopProgressFrame } from '@bike4mind/common';
import type { ChatStreamEvent } from '@shared/chat';

/**
 * The progress route's limits (pages/api/loops/runner/runs/[runId]/[action].ts): 4000 chars per
 * text field, 200 frames per post, a 256kb body. Batches are cut well inside them.
 */
export const PROGRESS_LIMITS = { fieldChars: 4_000, frames: 200, bodyBytes: 200_000 } as const;

const CLIP_CHARS = 2_000;

function clip(text: string): string {
  return text.length > CLIP_CHARS ? `${text.slice(0, CLIP_CHARS)}...` : text;
}

/** Cut a batch into posts the route accepts: long text split, frames and bytes capped per post. */
export function toPosts(frames: readonly LoopProgressFrame[]): LoopProgressFrame[][] {
  const split = frames.flatMap(frame => {
    if (frame.type !== 'text' || frame.text.length <= PROGRESS_LIMITS.fieldChars) return [frame];
    const parts: LoopProgressFrame[] = [];
    for (let at = 0; at < frame.text.length; at += PROGRESS_LIMITS.fieldChars) {
      parts.push({ type: 'text', text: frame.text.slice(at, at + PROGRESS_LIMITS.fieldChars) });
    }
    return parts;
  });
  const posts: LoopProgressFrame[][] = [];
  let post: LoopProgressFrame[] = [];
  let bytes = 0;
  for (const frame of split) {
    const size = Buffer.byteLength(JSON.stringify(frame));
    if (post.length > 0 && (post.length >= PROGRESS_LIMITS.frames || bytes + size > PROGRESS_LIMITS.bodyBytes)) {
      posts.push(post);
      post = [];
      bytes = 0;
    }
    post.push(frame);
    bytes += size;
  }
  if (post.length > 0) posts.push(post);
  return posts;
}

/** The frame for one stream event, or null for the ones the run view has no use for. */
export function toFrame(event: ChatStreamEvent): LoopProgressFrame | null {
  switch (event.type) {
    case 'delta':
      return { type: 'text', text: event.text };
    case 'tool-start':
      return {
        type: 'tool-start',
        callId: event.call.id,
        name: event.call.name,
        input: clip(JSON.stringify(event.call.input)),
      };
    case 'tool-end':
      return {
        type: 'tool-end',
        callId: event.call.id,
        name: event.call.name,
        status: event.call.status,
        ...(event.call.error ? { error: clip(event.call.error) } : {}),
        ...(event.call.preview ? { preview: clip(event.call.preview) } : {}),
      };
    case 'usage':
      return { type: 'usage', usage: event.usage };
    default:
      return null;
  }
}

export const PROGRESS_FLUSH_MS = 1_500;

/**
 * Collects a turn's frames and posts them in batches, so a streaming reply costs one request per
 * ~1.5s rather than one per token. Adjacent text is joined and only the latest usage is kept.
 */
export class ProgressBatcher {
  private frames: LoopProgressFrame[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sending: Promise<void> = Promise.resolve();

  constructor(
    private readonly send: (frames: LoopProgressFrame[]) => Promise<void>,
    private readonly onError: (error: unknown) => void,
    private readonly flushMs = PROGRESS_FLUSH_MS
  ) {}

  push(event: ChatStreamEvent): void {
    const frame = toFrame(event);
    if (!frame) return;
    const last = this.frames[this.frames.length - 1];
    if (frame.type === 'text' && last?.type === 'text') last.text += frame.text;
    else if (frame.type === 'usage') {
      this.frames = this.frames.filter(existing => existing.type !== 'usage');
      this.frames.push(frame);
    } else this.frames.push(frame);
    this.timer ??= setTimeout(() => void this.flush(), this.flushMs);
  }

  /**
   * Posts whatever is waiting, after any post already in flight, so frames arrive in order. A
   * failed post is not retried: the server has no batch id, so a retry would duplicate steps.
   */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const posts = toPosts(this.frames);
    this.frames = [];
    for (const post of posts) this.sending = this.sending.then(() => this.send(post)).catch(this.onError);
    return this.sending;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.frames = [];
  }
}
