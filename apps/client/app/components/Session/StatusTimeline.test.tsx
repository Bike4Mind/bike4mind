import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';

// sonner's `toast` is called both as a function (success) and as `toast.error`.
const toastFn = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: Object.assign((...args: unknown[]) => toastFn(...args), {
    error: (...args: unknown[]) => toastError(...args),
  }),
}));

import StatusTimeline, { buildStatusLogMarkdown, computeTimeline, type StatusLogEntry } from './StatusTimeline';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

// Fixed base + relative offsets keep deltas/total timezone-independent; the
// absolute HH:mm:ss cells render in local time, so we assert their shape (regex)
// rather than exact clock values.
const base = new Date('2026-07-06T12:00:00.000Z').getTime();
const at = (ms: number) => new Date(base + ms).toISOString();

const log: StatusLogEntry[] = [
  { status: 'Submitted from client', timestamp: at(0) },
  { status: 'Received by backend', timestamp: at(460) },
  { status: '🔎 Searching the data lake', timestamp: at(460 + 3100) },
  { status: 'weird | label', timestamp: at(460 + 3100 + 2000) }, // total = 5560ms
];

describe('computeTimeline', () => {
  it('computes per-stage deltas and total, first delta is 0', () => {
    const { total, rows } = computeTimeline(log);
    expect(total).toBe(5560);
    expect(rows.map(r => r.delta)).toEqual([0, 460, 3100, 2000]);
  });

  it('sorts chronologically regardless of input order', () => {
    const { rows } = computeTimeline([log[2], log[0], log[3], log[1]]);
    expect(rows.map(r => r.entry.status)).toEqual([
      'Submitted from client',
      'Received by backend',
      '🔎 Searching the data lake',
      'weird | label',
    ]);
  });
});

describe('buildStatusLogMarkdown', () => {
  const md = buildStatusLogMarkdown(log);

  it('emits the header with total elapsed and an HH:mm:ss range', () => {
    expect(md).toMatch(/^### Status Log — Total elapsed: 5\.6s \(\d\d:\d\d:\d\d → \d\d:\d\d:\d\d\)/);
  });

  it('emits a markdown table header + separator', () => {
    expect(md).toContain('| Time | Δ | Step |');
    expect(md).toContain('| --- | --- | --- |');
  });

  it('renders one row per stage with the right delta and label', () => {
    expect(md).toContain('| start | Submitted from client |');
    expect(md).toContain('| +460ms | Received by backend |');
    expect(md).toContain('| +3.1s | 🔎 Searching the data lake |');
    const dataRows = md.split('\n').filter(l => /^\| \d\d:\d\d:\d\d \|/.test(l));
    expect(dataRows).toHaveLength(4);
  });

  it('escapes pipe characters in labels so the table is not broken', () => {
    expect(md).toContain('| +2.0s | weird \\| label |');
  });
});

describe('StatusTimeline copy button', () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    toastFn.mockClear();
    toastError.mockClear();
  });

  it('renders the copy affordance and, on click, writes the markdown + toasts', async () => {
    render(
      <TestWrapper>
        <StatusTimeline statusLog={log} />
      </TestWrapper>
    );
    fireEvent.click(screen.getByTestId('status-log-copy-md-btn'));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(buildStatusLogMarkdown(log)));
    expect(toastFn).toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('toasts an error if the clipboard write fails', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    render(
      <TestWrapper>
        <StatusTimeline statusLog={log} />
      </TestWrapper>
    );
    fireEvent.click(screen.getByTestId('status-log-copy-md-btn'));
    await vi.waitFor(() => expect(toastError).toHaveBeenCalled());
  });
});
