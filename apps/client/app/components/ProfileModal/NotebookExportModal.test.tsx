import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { NotebookExportRequestSchema } from '../../../types/api';

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
    const [from, to] = Array.from(document.querySelectorAll('input[type="date"]')) as HTMLInputElement[];
    fireEvent.change(from, { target: { value: '2026-01-15' } });
    fireEvent.change(to, { target: { value: '2026-01-20' } });
    clickExport();

    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    expect(mockPost.mock.calls[0][1]).toMatchObject({
      fromDate: new Date('2026-01-15T00:00:00.000').toISOString(),
      toDate: new Date('2026-01-20T23:59:59.999').toISOString(),
    });
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('keeps the size box clearable, and does not submit the empty value', async () => {
    // The input is controlled: an onChange that skips setState leaves React restoring the old text,
    // so the box could never be emptied to type a fresh number.
    renderModal();
    const box = screen.getByDisplayValue('10') as HTMLInputElement;
    fireEvent.change(box, { target: { value: '' } });
    expect(box.value).toBe('');

    clickExport();
    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    expect(mockPost.mock.calls[0][1]).toMatchObject({ maxFileSize: 10 * 1024 * 1024 });
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('submits a retyped size', async () => {
    renderModal();
    const box = screen.getByDisplayValue('10');
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.change(box, { target: { value: '25' } });
    clickExport();

    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    expect(mockPost.mock.calls[0][1]).toMatchObject({ maxFileSize: 25 * 1024 * 1024 });
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
