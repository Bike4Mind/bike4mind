import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  runExample: vi.fn(),
  editExample: vi.fn(),
  createFile: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('sonner', () => ({ toast }));
vi.mock('@client/app/hooks/data/skillTemplate', () => ({
  useRunSkillTemplateExample: () => ({ mutateAsync: h.runExample, isPending: false }),
  useEditSkillTemplateExample: () => ({ mutateAsync: h.editExample, isPending: false }),
}));
vi.mock('@client/app/hooks/data/fabFileMutations', () => ({ useCreateFabFileWithUpload: () => h.createFile }));

import TemplateExampleSection, { EXAMPLE_STALE_TEXT, replyParagraphs } from './TemplateExampleSection';

const appTheme = extendTheme({ ...getThemeConfig() });

const REPLY = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';

const example = (overrides: Record<string, unknown> = {}) => ({
  status: 'ready',
  enabled: true,
  prompt: 'Summarize this post',
  reply: REPLY,
  replyTrimmedTo: null,
  steps: [],
  generatedFromVersionId: 'v1',
  ...overrides,
});

const template = (overrides: Record<string, unknown> = {}) => ({
  id: 't1',
  listingId: 'l1',
  slug: 'summarize',
  headline: 'Three bullets from any article',
  inputs: [],
  examplePrompt: 'Summarize this post',
  status: 'draft',
  freeRunEnabled: false,
  stale: false,
  scanFindings: [],
  example: example(),
  ...overrides,
});

const viewOf = (overrides: Record<string, unknown> = {}) => ({
  template: template(),
  listing: { id: 'l1', name: 'summarize', visibility: 'public', live: true },
  currentApprovedVersionId: 'v1',
  eligibility: null,
  suggestedSlug: null,
  previewImageUrl: null,
  previewImageStatus: null,
  exampleRunsLeftToday: 5,
  ...overrides,
});

const ui = (view: unknown) => (
  <CssVarsProvider theme={appTheme}>
    <TemplateExampleSection listingId="l1" view={view as never} />
  </CssVarsProvider>
);
const byId = (id: string) => screen.getByTestId(id);

beforeEach(() => {
  vi.clearAllMocks();
  h.runExample.mockResolvedValue(template({ example: example({ status: 'running' }) }));
  h.editExample.mockResolvedValue(template());
});

describe('TemplateExampleSection', () => {
  it('runs the example once by itself when a saved template has none', async () => {
    const view = viewOf({ template: template({ example: null }) });
    const { rerender } = render(ui(view));
    await waitFor(() => expect(h.runExample).toHaveBeenCalledWith({}));
    rerender(ui({ ...view }));
    rerender(ui(viewOf({ template: template({ example: null, updatedAt: 'later' }) })));
    expect(h.runExample).toHaveBeenCalledTimes(1);
  });

  it('does not run by itself without a saved template, a prompt or runs left', () => {
    const { rerender } = render(ui(viewOf({ template: null })));
    expect(byId('template-example-save-first')).toBeInTheDocument();
    rerender(ui(viewOf({ template: template({ example: null, examplePrompt: ' ' }) })));
    rerender(ui(viewOf({ template: template({ example: null }), exampleRunsLeftToday: 0 })));
    expect(h.runExample).not.toHaveBeenCalled();
  });

  it('does not run again over an existing example', () => {
    render(ui(viewOf()));
    expect(h.runExample).not.toHaveBeenCalled();
  });

  it('re-runs with the edited prompt and shows the runs left', async () => {
    render(ui(viewOf()));
    expect(byId('template-example-runs-left')).toHaveTextContent('5 of');
    fireEvent.change(byId('template-example-prompt-input'), { target: { value: 'Summarize the wind farm post' } });
    fireEvent.click(byId('template-example-rerun-btn'));
    await waitFor(() => expect(h.runExample).toHaveBeenCalledWith({ prompt: 'Summarize the wind farm post' }));
  });

  it('disables re-run with the reason once the daily runs are spent', () => {
    render(ui(viewOf({ exampleRunsLeftToday: 0 })));
    expect(byId('template-example-rerun-btn')).toBeDisabled();
    expect(byId('template-example-runs-left')).toHaveTextContent('used all');
  });

  it('shows a running state with every edit locked', () => {
    render(ui(viewOf({ template: template({ example: example({ status: 'running' }) }) })));
    expect(byId('template-example-running')).toBeInTheDocument();
    expect(byId('template-example-rerun-btn')).toBeDisabled();
    expect(byId('template-example-enabled-switch')).toBeDisabled();
  });

  it('shows a failed run with its error and a retry', async () => {
    render(ui(viewOf({ template: template({ example: example({ status: 'failed', error: 'The run timed out' }) }) })));
    expect(byId('template-example-error')).toHaveTextContent('The run timed out');
    fireEvent.click(byId('template-example-retry-btn'));
    await waitFor(() => expect(h.runExample).toHaveBeenCalledTimes(1));
  });

  it('trims the reply at the end of a chosen paragraph and can restore it', async () => {
    const { rerender } = render(ui(viewOf()));
    expect(screen.queryByTestId('template-example-trim-btn-2')).toBeNull();
    fireEvent.click(byId('template-example-trim-btn-0'));
    await waitFor(() => expect(h.editExample).toHaveBeenCalledWith({ replyTrimmedTo: 'First paragraph.'.length }));

    rerender(ui(viewOf({ template: template({ example: example({ replyTrimmedTo: 16 }) }) })));
    expect(byId('template-example-paragraph-1')).toHaveAttribute('data-hidden', 'true');
    fireEvent.click(byId('template-example-trim-reset-btn'));
    await waitFor(() => expect(h.editExample).toHaveBeenCalledWith({ replyTrimmedTo: null }));
  });

  it('switches the demo off and on', async () => {
    render(ui(viewOf()));
    fireEvent.click(byId('template-example-enabled-switch'));
    await waitFor(() => expect(h.editExample).toHaveBeenCalledWith({ enabled: false }));
  });

  it('warns when a published example change fails its scan', async () => {
    h.editExample.mockResolvedValue(template({ status: 'draft', scanStatus: 'failed' }));
    render(ui(viewOf({ template: template({ status: 'published' }) })));
    fireEvent.click(byId('template-example-enabled-switch'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('did not pass the scan')));
  });

  it('asks for a re-run when the template is stale or the run used an older version', () => {
    const { rerender } = render(ui(viewOf({ template: template({ stale: true }) })));
    expect(byId('template-example-stale-warning')).toHaveTextContent(EXAMPLE_STALE_TEXT);
    expect(byId('template-example-stale-rerun-btn')).toBeEnabled();

    rerender(ui(viewOf({ currentApprovedVersionId: 'v2' })));
    expect(byId('template-example-stale-warning')).toBeInTheDocument();

    rerender(ui(viewOf()));
    expect(screen.queryByTestId('template-example-stale-warning')).toBeNull();
  });

  it('offers the sample file swap only for a skill that takes a file', async () => {
    const { rerender } = render(ui(viewOf()));
    expect(screen.queryByTestId('template-example-sample')).toBeNull();

    const sampleFile = { name: 'notes.md', mime: 'text/markdown', source: 'upload', fabFileId: 'f9' };
    rerender(ui(viewOf({ template: template({ takesFile: true, example: example({ sampleFile }) }) })));
    expect(byId('template-example-sample-name')).toHaveTextContent('notes.md');

    h.createFile.mockResolvedValue({ id: 'f10' });
    const file = new File(['# brief'], 'brief.md', { type: 'text/markdown' });
    fireEvent.change(byId('template-example-sample-input'), { target: { files: [file] } });
    await waitFor(() => expect(h.editExample).toHaveBeenCalledWith({ sampleFabFileId: 'f10' }));
    expect(h.createFile).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'brief.md' }), file);

    fireEvent.click(byId('template-example-sample-reset-btn'));
    await waitFor(() => expect(h.editExample).toHaveBeenCalledWith({ sampleFabFileId: null }));
  });

  it('never offers a way to write the reply', () => {
    render(ui(viewOf()));
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
  });
});

describe('replyParagraphs', () => {
  it('splits on blank lines and records where each paragraph ends', () => {
    expect(replyParagraphs(REPLY)).toEqual([
      { text: 'First paragraph.', start: 0, end: 16 },
      { text: 'Second paragraph.', start: 18, end: 35 },
      { text: 'Third paragraph.', start: 37, end: REPLY.length },
    ]);
    expect(replyParagraphs('One block only')).toHaveLength(1);
  });

  it('never splits inside a fenced code block', () => {
    const reply = 'Intro\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nOutro\n\n~~~\nx\n\ny\n~~~';
    const parts = replyParagraphs(reply);
    expect(parts.map(p => p.text)).toEqual([
      'Intro',
      '```js\nconst a = 1;\n\nconst b = 2;\n```',
      'Outro',
      '~~~\nx\n\ny\n~~~',
    ]);
    for (const part of parts) expect(reply.slice(0, part.end).split(/^ {0,3}(?:```|~~~)/m).length % 2).toBe(1);
  });

  it('keeps an unclosed fence as one trailing paragraph', () => {
    expect(replyParagraphs('Intro\n\n```\na\n\nb').map(p => p.text)).toEqual(['Intro', '```\na\n\nb']);
  });
});
