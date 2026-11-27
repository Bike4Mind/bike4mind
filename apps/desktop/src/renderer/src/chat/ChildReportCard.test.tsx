// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatChildReport, ChatMessage } from '@shared/chat';
import { afterEach, describe, expect, it } from 'vitest';
import { desktopTheme } from '../theme';
import { ChildReportCard, workspaceLine } from './ChildReportCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const REPORT: ChatChildReport = {
  sessionId: 'child-1',
  title: 'Tidy imports',
  outcome: 'finished',
  branch: 'agent/tidy-imports',
  headSha: 'abc1234',
  reply: 'Done. <img src=x onerror=alert(1)> **not bold**',
};

function message(report: ChatChildReport): ChatMessage {
  return {
    id: 'm1',
    role: 'user',
    system: true,
    content: 'MODEL COPY: session_read (child-1) <child-reply>secret</child-reply>',
    display: `The session "${report.title}" has finished.`,
    createdAt: '2026-01-01T00:00:00.000Z',
    childReport: report,
  };
}

function render(report: ChatChildReport): void {
  host ??= document.body.appendChild(document.createElement('div'));
  root ??= createRoot(host);
  act(() => {
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <ChildReportCard message={message(report)} report={report} />
      </CssVarsProvider>
    );
  });
}

function byTestId(id: string): HTMLElement | null {
  return host?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
}

describe('workspaceLine', () => {
  it('joins branch and sha, or keeps whichever half there is', () => {
    expect(workspaceLine({ branch: 'agent/x', headSha: 'abc' })).toBe('agent/x @ abc');
    expect(workspaceLine({ branch: 'agent/x' })).toBe('agent/x');
    expect(workspaceLine({ headSha: 'abc' })).toBe('abc');
    expect(workspaceLine({})).toBeNull();
  });
});

describe('ChildReportCard', () => {
  it('shows the display line and workspace, with the reply folded away, and never the model copy', () => {
    render(REPORT);
    expect(byTestId('child-report-headline')?.textContent).toBe('The session "Tidy imports" has finished.');
    expect(byTestId('child-report-workspace')?.textContent).toBe('agent/tidy-imports @ abc1234');
    expect(byTestId('child-report-reply')).toBeNull();
    expect(host?.textContent).not.toContain('MODEL COPY');
    expect(host?.textContent).not.toContain('session_read');
  });

  it('says the reply was cut short only when it was', () => {
    render({ ...REPORT, replyTruncated: true });
    act(() => byTestId('child-report-expand-btn')?.click());
    expect(byTestId('child-report-truncated')).not.toBeNull();
    expect(byTestId('child-report-reply')?.textContent).not.toContain('session_read');
  });

  it('expands to the reply as plain text, with no markup injected', () => {
    render(REPORT);
    const toggle = byTestId('child-report-expand-btn');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    act(() => toggle?.click());
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    const reply = byTestId('child-report-reply');
    expect(reply?.textContent).toBe(REPORT.reply);
    expect(reply?.querySelector('img')).toBeNull();
    expect(reply?.querySelector('strong')).toBeNull();
  });

  it('marks a failed outcome and drops the toggle and workspace line when there is nothing to show', () => {
    render({ sessionId: 'c2', title: 'Broke', outcome: 'failed' });
    expect(byTestId('child-report-card')?.dataset.outcome).toBe('failed');
    expect(byTestId('child-report-expand-btn')).toBeNull();
    expect(byTestId('child-report-workspace')).toBeNull();
  });
});
