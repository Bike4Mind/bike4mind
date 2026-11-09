import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_MODEL_STATE, type ModelViewState } from '@shared/model3d';
import type { ModelCaptureRequest } from './ModelLiveView';
import { ModelLiveViews } from './ModelLiveViews';

const SOURCE = 'export default function model({ m }) { return m.Manifold.cube([1, 1, 1]); }\n';
const WINDOW = 7;

describe('ModelLiveViews', () => {
  let dir: string;
  let file: string;
  let states: { sessionId: string; state: ModelViewState }[];
  let captures: ({ sessionId: string } & ModelCaptureRequest)[];
  let views: ModelLiveViews;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'model-views-'));
    file = join(dir, 'chest.model.js');
    writeFileSync(file, SOURCE);
    states = [];
    captures = [];
    views = new ModelLiveViews(
      {
        state: (sessionId, state) => states.push({ sessionId, state }),
        captureTarget: () => WINDOW,
        captureRequest: (_target, request) => {
          captures.push(request);
          return true;
        },
      },
      { debounceMs: 20, buildTimeoutMs: 200, captureTimeoutMs: 100 }
    );
  });

  afterEach(async () => {
    views.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  it('starts every conversation with no model, whatever another one has open', async () => {
    await views.for('chat-a').open(file);
    expect(views.current('chat-a')).toMatchObject({ path: file, generation: 1 });
    expect(views.current('chat-b')).toEqual(EMPTY_MODEL_STATE);
    expect(views.for('chat-b').current()).toEqual(EMPTY_MODEL_STATE);
  });

  it('keeps each conversation on its own file and generation', async () => {
    const other = join(dir, 'lamp.model.js');
    writeFileSync(other, SOURCE);
    await views.for('chat-a').open(file);
    await views.for('chat-b').open(other);
    await views.for('chat-b').open(other);
    expect(views.current('chat-a')).toMatchObject({ path: file, generation: 1 });
    expect(views.current('chat-b')).toMatchObject({ path: other, generation: 2 });
  });

  it('tags state broadcasts and capture requests with the conversation', async () => {
    await views.for('chat-a').open(file);
    expect(states).toEqual([{ sessionId: 'chat-a', state: expect.objectContaining({ path: file }) }]);

    views.for('chat-a').reportBuild({ generation: 1, ok: true }, WINDOW);
    const capture = views.for('chat-a').capture(['front']);
    await Promise.resolve();
    expect(captures).toEqual([expect.objectContaining({ sessionId: 'chat-a', views: ['front'] })]);
    views.for('chat-a').resolveCapture(captures[0].id, { bytes: new Uint8Array([1]) });
    await expect(capture).resolves.toEqual(new Uint8Array([1]));
  });

  it('routes a build report only to the conversation it names', async () => {
    await views.for('chat-a').open(file);
    await views.for('chat-b').open(file);
    const waiting = views.for('chat-a').waitForBuild();
    views.find('chat-b')?.reportBuild({ generation: 1, ok: false, error: 'not yours' }, WINDOW);
    views.find('chat-a')?.reportBuild({ generation: 1, ok: true }, WINDOW);
    await expect(waiting).resolves.toMatchObject({ ok: true });
  });

  it('forgets a deleted conversation and stops its watcher', async () => {
    await views.for('chat-a').open(file);
    views.forget('chat-a');
    expect(views.find('chat-a')).toBeUndefined();
    expect(views.current('chat-a')).toEqual(EMPTY_MODEL_STATE);
  });
});
