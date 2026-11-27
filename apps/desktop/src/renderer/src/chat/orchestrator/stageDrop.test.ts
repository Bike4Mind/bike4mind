import { describe, expect, it } from 'vitest';
import { applyPreset, singlePaneLayout, type OrchestratorLayout } from './orchestratorLayout';
import { allowedDropZones, applySessionDrop, dropZoneAt } from './stageDrop';

const single = singlePaneLayout('board');
const row = applyPreset(single, 'side-by-side');
const column = applyPreset(single, 'stacked');
const full = applyPreset(single, 'three-across');

describe('allowedDropZones', () => {
  it('offers both edges to a single pane and no center, which always follows the active session', () => {
    expect(allowedDropZones(single)).toEqual(['right', 'bottom']);
  });

  it('offers only the edge that keeps a split, plus re-pinning', () => {
    expect(allowedDropZones(row)).toEqual(['right', 'center']);
    expect(allowedDropZones(column)).toEqual(['bottom', 'center']);
  });

  it('offers only re-pinning once the stage is full', () => {
    expect(allowedDropZones(full)).toEqual(['center']);
  });
});

describe('dropZoneAt', () => {
  it('picks an edge within its band and the center elsewhere', () => {
    expect(dropZoneAt(row, { x: 0.9, y: 0.5 })).toBe('right');
    expect(dropZoneAt(row, { x: 0.3, y: 0.95 })).toBe('center');
    expect(dropZoneAt(column, { x: 0.3, y: 0.95 })).toBe('bottom');
  });

  it('takes the nearer edge in the corner', () => {
    expect(dropZoneAt(single, { x: 0.95, y: 0.8 })).toBe('right');
    expect(dropZoneAt(single, { x: 0.8, y: 0.95 })).toBe('bottom');
  });

  it('has nothing for the middle of a single pane', () => {
    expect(dropZoneAt(single, { x: 0.4, y: 0.4 })).toBeUndefined();
  });
});

describe('applySessionDrop', () => {
  it('splits a single pane beside or below with the dropped session pinned', () => {
    const beside = applySessionDrop(single, 'right', 'other');
    expect(beside.split).toBe('row');
    expect(beside.panes.map(pane => pane.sessionId)).toEqual([undefined, 'other']);
    expect(applySessionDrop(single, 'bottom', 'other').split).toBe('column');
  });

  it('re-pins the pane under the cursor in the center', () => {
    const repinned = applySessionDrop(full, 'center', 'other', 1);
    expect(repinned.panes.map(pane => pane.sessionId)).toEqual([undefined, 'other', undefined]);
  });

  it('ignores a zone the layout does not offer', () => {
    const stacked: OrchestratorLayout = column;
    expect(applySessionDrop(stacked, 'right', 'other')).toBe(stacked);
    expect(applySessionDrop(full, 'right', 'other')).toBe(full);
  });
});
