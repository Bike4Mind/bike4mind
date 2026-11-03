import type { ChatStreamEvent, ChatUsage } from '@shared/chat';

/**
 * One step of a runner turn, as the web run view shows it. Kept to what the view renders; must
 * stay in sync with the progress shape LoopRunnerClient posts.
 */
export type LoopProgressFrame =
  | { type: 'text'; text: string }
  | { type: 'tool-start'; callId: string; name: string; input: string }
  | { type: 'tool-end'; callId: string; name: string; status: string; error?: string; preview?: string }
  | { type: 'usage'; usage: ChatUsage };

const MAX_FIELD_CHARS = 2_000;

function clip(text: string): string {
  return text.length > MAX_FIELD_CHARS ? `${text.slice(0, MAX_FIELD_CHARS)}...` : text;
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

  /** Posts whatever is waiting, after any post already in flight, so frames arrive in order. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const batch = this.frames;
    this.frames = [];
    if (batch.length > 0) this.sending = this.sending.then(() => this.send(batch)).catch(this.onError);
    return this.sending;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.frames = [];
  }
}
