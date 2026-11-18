import { describe, expect, it } from 'vitest';
import { RUNNING_STATUS_FRESH_MS } from './runRender';
import { renderMessageDisposition, type RenderMessageResult, type RenderMessageDisposition } from './disposition';

describe('renderMessageDisposition', () => {
  it.each<[RenderMessageResult, RenderMessageDisposition]>([
    [{ outcome: 'malformed' }, { action: 'delete' }],
    [{ outcome: 'skipped', reason: 'missing' }, { action: 'delete' }],
    [{ outcome: 'skipped', reason: 'not_render' }, { action: 'delete' }],
    [{ outcome: 'skipped', reason: 'not_running' }, { action: 'delete' }],
    [{ outcome: 'skipped', reason: 'cancel_requested' }, { action: 'delete' }],
    // The task encoding the job holds its own message; this duplicate is dropped.
    [{ outcome: 'skipped', reason: 'in_progress' }, { action: 'delete' }],
    [{ outcome: 'cancelled' }, { action: 'delete' }],
    [{ outcome: 'already_succeeded' }, { action: 'delete' }],
    [{ outcome: 'succeeded', bytes: 10, durationSeconds: 4 }, { action: 'delete' }],
    [{ outcome: 'failed', message: 'boom' }, { action: 'delete' }],
    [{ outcome: 'not_yet_running' }, { action: 'change_visibility', seconds: 20 }],
    [
      { outcome: 'aborted', released: true },
      { action: 'change_visibility', seconds: 0 },
    ],
    [
      { outcome: 'aborted', released: false },
      { action: 'change_visibility', seconds: Math.ceil(RUNNING_STATUS_FRESH_MS / 1000) + 5 },
    ],
    [{ outcome: 'shutting_down' }, { action: 'change_visibility', seconds: 0 }],
    [{ outcome: 'errored' }, { action: 'leave' }],
  ])('%j -> %j', (result, disposition) => {
    expect(renderMessageDisposition(result)).toEqual(disposition);
  });
});
