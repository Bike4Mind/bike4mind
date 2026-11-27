// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_DRAG_TYPE } from '../sessionDrag';
import { singlePaneLayout } from './orchestratorLayout';
import { StageDropZones } from './StageDropZones';
import { createThemedMount, el, query } from './testUtils';

const themed = createThemedMount();
const onLayoutChange = vi.fn();

afterEach(() => {
  themed.unmount();
  onLayoutChange.mockReset();
});

const render = () =>
  themed.render(
    <StageDropZones
      layout={singlePaneLayout('board')}
      onLayoutChange={onLayoutChange}
      activeId="active"
      isListed={id => ['active', 'other'].includes(id)}
    >
      <div>stage</div>
    </StageDropZones>
  );

function dragEvent(type: string, payload: Record<string, string>, clientX: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clientX', { value: clientX });
  Object.defineProperty(event, 'clientY', { value: 50 });
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: Object.keys(payload), getData: (key: string) => payload[key] ?? '', dropEffect: 'none' },
  });
  return event;
}

async function dropAt(payload: Record<string, string>, clientX: number) {
  const target = el('orchestrator-stage-drop-target');
  target.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 }) as DOMRect;
  await act(async () => {
    target.dispatchEvent(dragEvent('dragover', payload, clientX));
  });
  await act(async () => {
    target.dispatchEvent(dragEvent('drop', payload, clientX));
  });
}

describe('StageDropZones', () => {
  it('opens a session dropped on the right edge as a pinned pane beside', async () => {
    await render();
    await dropAt({ [SESSION_DRAG_TYPE]: 'other' }, 95);
    expect(onLayoutChange).toHaveBeenCalledWith({
      split: 'row',
      panes: [
        { view: 'board', size: 0.5 },
        { view: 'board', size: 0.5, sessionId: 'other' },
      ],
    });
    expect(query('orchestrator-stage-drop-zones')).toBeNull();
  });

  it('takes a sidebar row through its own drag type', async () => {
    await render();
    await dropAt({ [SESSION_DRAG_TYPE]: 'other' }, 95);
    expect(onLayoutChange).toHaveBeenCalledTimes(1);
  });

  it('ignores the active session, an unlisted one, a malformed id and a zone the layout lacks', async () => {
    await render();
    await dropAt({ [SESSION_DRAG_TYPE]: 'active' }, 95);
    await dropAt({ [SESSION_DRAG_TYPE]: 'stranger' }, 95);
    await dropAt({ [SESSION_DRAG_TYPE]: 'has space' }, 95);
    await dropAt({ [SESSION_DRAG_TYPE]: 'other' }, 40);
    expect(onLayoutChange).not.toHaveBeenCalled();
  });
});
