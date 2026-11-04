import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {}, ipcMain: {} }));

const { parseBuildReport } = await import('./modelIpc');

describe('parseBuildReport', () => {
  const summary = { parts: ['body', 'lid'], size: [60, 40, 40], units: 'mm', triangles: 24, params: { width: 60 } };

  it('keeps the joints the renderer reported', () => {
    const report = parseBuildReport({
      generation: 3,
      ok: true,
      summary: { ...summary, joints: ['lid: pivot (0, 40, 30), in body', 7] },
    });
    expect(report?.summary?.joints).toEqual(['lid: pivot (0, 40, 30), in body']);
  });

  it('leaves joints out when no part has a pivot', () => {
    const report = parseBuildReport({ generation: 3, ok: true, summary });
    expect(report?.summary).not.toHaveProperty('joints');
  });

  it('drops a report without a generation', () => {
    expect(parseBuildReport({ ok: true })).toBeNull();
  });
});
