import type * as THREE from 'three';
import { partTreeError, type ModelBuildOutcome, type ModelSummary } from '@shared/model3d';
import { exportGlb, renderThumbnail } from './modelScene';

/** Must match MODEL_ENGINE_URL / MODEL_ENGINE_ORIGIN in main/chat/model3d/engineProtocol.ts. */
const ENGINE_URL = 'b4m-model://engine/';
const ENGINE_ORIGIN = 'b4m-model://engine';

/**
 * The sandboxed b4m-model: engine iframe that runs `.model.js` builds. It runs one build at a time:
 * starting another supersedes the one in flight, whose caller gets null. Mounted on first use, or
 * ahead of it by warm(), which also boots the frame's first worker so that build skips the cold start.
 */
export class ModelEngineFrame {
  private mounted: { frame: HTMLIFrameElement; ready: Promise<void> } | null = null;
  private requestId = 0;
  private pending: ((outcome: ModelBuildOutcome | null) => void) | null = null;

  warm(): this {
    this.mounted ??= mount();
    return this;
  }

  async build(source: string, params: Record<string, number>, print: boolean): Promise<ModelBuildOutcome | null> {
    const { frame, ready } = (this.mounted ??= mount());
    await ready;
    this.requestId += 1;
    const id = this.requestId;
    this.pending?.(null);
    return new Promise<ModelBuildOutcome | null>(resolve => {
      const finish = (outcome: ModelBuildOutcome | null) => {
        window.removeEventListener('message', onMessage);
        if (this.pending === finish) this.pending = null;
        resolve(outcome);
      };
      const onMessage = (event: MessageEvent) => {
        if (event.source !== frame.contentWindow || event.data?.type !== 'built' || event.data.id !== id) return;
        finish(event.data.outcome as ModelBuildOutcome);
      };
      this.pending = finish;
      window.addEventListener('message', onMessage);
      frame.contentWindow?.postMessage({ type: 'build', id, source, params, print }, ENGINE_ORIGIN);
    });
  }

  dispose(): void {
    this.pending?.(null);
    this.mounted?.frame.remove();
    this.mounted = null;
  }
}

function mount(): { frame: HTMLIFrameElement; ready: Promise<void> } {
  const frame = document.createElement('iframe');
  frame.src = ENGINE_URL;
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  frame.setAttribute('aria-hidden', 'true');
  frame.dataset.testid = 'model-engine-frame';
  frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
  const ready = new Promise<void>(resolve => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.data?.type !== 'engine-ready') return;
      window.removeEventListener('message', onMessage);
      resolve();
    };
    window.addEventListener('message', onMessage);
  });
  document.body.appendChild(frame);
  return { frame, ready };
}

/** A build whose part tree is malformed is a failed build, with the reason the pane shows. */
export function checkedOutcome(built: ModelBuildOutcome): ModelBuildOutcome {
  const treeError = built.ok ? partTreeError(built.parts) : null;
  return treeError ? { ok: false, error: treeError } : built;
}

/** How the window that built it wants a version's thumbnail and pose kept. */
export type VersionLook = { dark: boolean; jointAngles: Record<string, number> };

/**
 * Writes the sibling GLB of a good file build, then reports the build to main, which the model
 * tools wait on. The GLB goes first so a tool woken by the report can name a file already on disk.
 * Last it asks main to keep the build as a version, after the report so no tool waits on the
 * thumbnail; main takes the path and source from its own state and keeps each generation once.
 */
export async function reportGoodFileBuild(
  sessionId: string,
  generation: number,
  object: THREE.Group,
  summary: ModelSummary,
  look: VersionLook
): Promise<void> {
  const glbError = await exportGlb(object)
    .then(bytes => window.b4m.model.writeGlb(sessionId, { generation, bytes }))
    .then(
      written => (written ? undefined : 'the model changed before it was saved'),
      (caught: unknown) => (caught instanceof Error ? caught.message : String(caught))
    );
  await window.b4m.model.reportBuild(sessionId, { generation, ok: true, summary, glbError });
  await recordVersion(sessionId, generation, object, look);
}

async function recordVersion(
  sessionId: string,
  generation: number,
  object: THREE.Group,
  { dark, jointAngles }: VersionLook
): Promise<void> {
  // Every window builds each generation; only one needs to pay for a thumbnail's GL context.
  try {
    if (!(await window.b4m.model.wantsVersion(sessionId, generation))) return;
  } catch (caught) {
    console.warn(`Model version check failed: ${errorMessage(caught)}`);
  }
  // A version without a picture is still worth keeping, so a failed render only loses the thumbnail.
  let thumbnail: Uint8Array | null = null;
  try {
    thumbnail = await renderThumbnail(object, dark, jointAngles);
  } catch (caught) {
    console.warn(`Model version thumbnail failed: ${errorMessage(caught)}`);
  }
  // The build itself succeeded and was reported; failing to keep it must not turn it into an error.
  try {
    await window.b4m.model.recordVersion(sessionId, { generation, jointAngles, thumbnail });
  } catch (caught) {
    console.warn(`Model version was not kept: ${errorMessage(caught)}`);
  }
}

export function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}
