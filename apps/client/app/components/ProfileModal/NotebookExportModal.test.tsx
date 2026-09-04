import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { NotebookExportRequestSchema } from '../../../types/api';

// A UTC runner cannot tell the local-zone resolution from the UTC-anchoring bug it replaced: both
// render "2026-01-15" as the same instant. The expected values below are literals for the same
// reason - re-deriving them from `new Date(...).toISOString()` would just re-run the production
// formula against this same zone and assert nothing.
process.env.TZ = 'America/Los_Angeles';

const { mockPost, mockToastError } = vi.hoisted(() => ({ mockPost: vi.fn(), mockToastError: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: mockPost } }));
vi.mock('sonner', () => ({ toast: { error: mockToastError, success: vi.fn() } }));
vi.mock('@client/app/components/help', () => ({ ContextHelpButton: () => null }));

import NotebookExportModal from './NotebookExportModal';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

/**
 * Judges the body the modal built against the route's real request schema, so a field the modal
 * cannot express correctly fails here rather than only in production.
 */
const routeDouble = vi.fn(async (_url: string, body: unknown) => {
  const parsed = NotebookExportRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`schema rejected: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')}`);
  }
  return { data: { success: true, data: { downloadUrl: 'x', fileSize: 1, notebookCount: 1 } } };
});

const renderModal = () =>
  render(
    <TestWrapper>
      <NotebookExportModal open onClose={vi.fn()} />
    </TestWrapper>
  );

const clickExport = () => fireEvent.click(screen.getByText('Export Notebooks', { selector: 'button' }));

beforeEach(() => {
  mockPost.mockReset().mockImplementation(routeDouble);
  mockToastError.mockReset();
});

describe('NotebookExportModal', () => {
  it("sends the picked day resolved in the viewer's own zone, not UTC", async () => {
    // The picker yields a bare "2026-01-15", which carries no offset - so whoever resolves it picks
    // the zone. Resolving it against UTC cost a user in UTC-8 the last 8 hours of the day they chose.
    renderModal();
    const from = screen.getByTestId('notebook-export-from-date-input');
    const to = screen.getByTestId('notebook-export-to-date-input');
    fireEvent.change(from, { target: { value: '2026-01-15' } });
    fireEvent.change(to, { target: { value: '2026-01-20' } });
    clickExport();

    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    expect(mockPost.mock.calls[0][1]).toMatchObject({
      fromDate: '2026-01-15T08:00:00.000Z',
      toDate: '2026-01-21T07:59:59.999Z',
    });
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('keeps the size box clearable, and does not submit the empty value', async () => {
    // The input is controlled: an onChange that skips setState leaves React restoring the old text,
    // so the box could never be emptied to type a fresh number.
    renderModal();
    const box = screen.getByTestId('notebook-export-size-input') as HTMLInputElement;
    fireEvent.change(box, { target: { value: '' } });
    expect(box.value).toBe('');

    clickExport();
    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    expect(mockPost.mock.calls[0][1]).toMatchObject({ maxFileSize: 10 * 1024 * 1024 });
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('does not submit a stale size after the box is backspaced empty', async () => {
    // A real backspace on "10" fires "1" before it fires "": the first keystroke is a valid number
    // and sets the option, the second cannot, so a guard that only skips the unparseable value
    // leaves 1 MB behind while the box shows nothing. Clearing must restore the default, not the
    // last digit that happened to parse.
    renderModal();
    const box = screen.getByTestId('notebook-export-size-input') as HTMLInputElement;
    fireEvent.change(box, { target: { value: '1' } });
    fireEvent.change(box, { target: { value: '' } });
    expect(box.value).toBe('');

    clickExport();
    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    expect(mockPost.mock.calls[0][1]).toMatchObject({ maxFileSize: 10 * 1024 * 1024 });
  });

  it('submits a retyped size', async () => {
    renderModal();
    const box = screen.getByTestId('notebook-export-size-input');
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.change(box, { target: { value: '25' } });
    clickExport();

    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    expect(mockPost.mock.calls[0][1]).toMatchObject({ maxFileSize: 25 * 1024 * 1024 });
  });

  it('holds a number input to the bounds it advertises', async () => {
    // A number input accepts more than its min/max attributes suggest: those are submit-time hints
    // the browser does not enforce on typed text. "1e3" is the case worth pinning - it is valid
    // input, and parseInt reads it as 1, the opposite end of the range from what it says.
    renderModal();
    const box = screen.getByTestId('notebook-export-size-input') as HTMLInputElement;
    // The real sequence, captured from Chromium: a number input reports "" for the transient "1e",
    // so typing this passes through the same intermediate the backspace case does.
    for (const step of ['1', '', '1e3']) fireEvent.change(box, { target: { value: step } });
    clickExport();

    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    expect(mockPost.mock.calls[0][1]).toMatchObject({ maxFileSize: 100 * 1024 * 1024 });
  });

  it('names the offending field when the server rejects the body', async () => {
    mockPost.mockRejectedValue({
      response: {
        status: 400,
        data: {
          success: false,
          message: 'Invalid request body',
          errors: [{ field: 'notebookIds', message: 'must be a 24-character hex notebook id' }],
        },
      },
    });
    renderModal();
    clickExport();

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(mockToastError.mock.calls[0][0]).toContain('must be a 24-character hex notebook id');
  });

  it('falls back to the server message when there are no per-field errors', async () => {
    mockPost.mockRejectedValue({
      response: { status: 404, data: { success: false, message: 'No notebooks found to export' } },
      message: 'Request failed with status code 404',
    });
    renderModal();
    clickExport();

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(mockToastError.mock.calls[0][0]).toBe('No notebooks found to export');
  });
});
