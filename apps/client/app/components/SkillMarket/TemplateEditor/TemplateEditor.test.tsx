import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  view: null as unknown,
  navigate: vi.fn(),
  draft: vi.fn(),
  save: vi.fn(),
  publish: vi.fn(),
  unpublish: vi.fn(),
  freeRun: vi.fn(),
  setImage: vi.fn(),
  generate: vi.fn(),
  approve: vi.fn(),
  remove: vi.fn(),
  createFile: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('sonner', () => ({ toast }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => h.navigate }));
vi.mock('@client/app/hooks/data/skillTemplate', () => ({
  useSkillTemplate: () => ({ data: h.view, isLoading: false, isError: false, error: null }),
  useDraftSkillTemplate: () => ({ mutateAsync: h.draft, isPending: false }),
  useSaveSkillTemplate: () => ({ mutateAsync: h.save, isPending: false }),
  usePublishSkillTemplate: () => ({ mutateAsync: h.publish, isPending: false }),
  useUnpublishSkillTemplate: () => ({ mutateAsync: h.unpublish, isPending: false }),
  useSetSkillTemplateFreeRun: () => ({ mutateAsync: h.freeRun, isPending: false }),
  useSetSkillTemplateImage: () => ({ mutateAsync: h.setImage, isPending: false }),
  useGenerateSkillTemplateImage: () => ({ mutateAsync: h.generate, isPending: false }),
  useApproveSkillTemplateImage: () => ({ mutateAsync: h.approve, isPending: false }),
  useRemoveSkillTemplateImage: () => ({ mutateAsync: h.remove, isPending: false }),
}));
vi.mock('@client/app/hooks/data/fabFileMutations', () => ({ useCreateFabFileWithUpload: () => h.createFile }));

import TemplateEditor from './TemplateEditor';

const appTheme = extendTheme({ ...getThemeConfig() });

const template = (overrides: Record<string, unknown> = {}) => ({
  id: 't1',
  listingId: 'l1',
  slug: 'summarize',
  headline: 'Three bullets from any article',
  inputs: [{ label: 'Article', required: true }],
  examplePrompt: 'Summarize this post',
  previewImage: null,
  status: 'draft',
  freeRunEnabled: false,
  generatedFromVersionId: 'v1',
  stale: false,
  viewCount: 12,
  freeRunCount: 3,
  tryCount: 2,
  scanFindings: [],
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
  ...overrides,
});

const viewOf = (overrides: Record<string, unknown> = {}) => ({
  template: template(),
  listing: { id: 'l1', name: 'summarize', visibility: 'public', live: true },
  currentApprovedVersionId: 'v1',
  eligibility: { eligible: true },
  suggestedSlug: null,
  previewImageUrl: null,
  previewImageStatus: null,
  ...overrides,
});

const draftResponse = {
  draft: {
    headline: 'Turn any article into three bullets',
    inputs: [
      { label: 'Article text', required: true },
      { label: 'Tone', required: false },
    ],
    examplePrompt: 'Summarize this post about solar panels',
  },
  generatedFromVersionId: 'v1',
};

const renderEditor = (view: unknown) => {
  h.view = view;
  return render(
    <CssVarsProvider theme={appTheme}>
      <TemplateEditor listingId="l1" />
    </CssVarsProvider>
  );
};

const byId = (id: string) => screen.getByTestId(id);
const writeText = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  h.draft.mockResolvedValue(draftResponse);
  h.save.mockImplementation(async (body: Record<string, unknown>) => template({ ...body }));
  h.approve.mockResolvedValue(undefined);
  h.remove.mockResolvedValue(undefined);
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

describe('TemplateEditor first open', () => {
  it('drafts copy and the suggested slug without saving anything', async () => {
    renderEditor(viewOf({ template: null, suggestedSlug: 'summarize-2' }));

    await waitFor(() => expect(byId('template-editor-headline-input')).toHaveValue(draftResponse.draft.headline));
    expect(h.draft).toHaveBeenCalledTimes(1);
    expect(h.save).not.toHaveBeenCalled();
    expect(byId('template-editor-slug-input')).toHaveValue('summarize-2');
    expect(byId('template-editor-status-chip')).toHaveTextContent('Not saved');
    expect(byId('template-image-save-first')).toBeInTheDocument();
  });

  it('saves the drafted copy with the slug and the version it was drafted from', async () => {
    renderEditor(viewOf({ template: null, suggestedSlug: 'summarize-2' }));
    await waitFor(() => expect(byId('template-editor-save-btn')).not.toBeDisabled());

    fireEvent.click(byId('template-editor-save-btn'));

    await waitFor(() =>
      expect(h.save).toHaveBeenCalledWith({
        slug: 'summarize-2',
        headline: draftResponse.draft.headline,
        inputs: draftResponse.draft.inputs,
        examplePrompt: draftResponse.draft.examplePrompt,
        generatedFromVersionId: 'v1',
      })
    );
  });

  it('previews the headline, solid and dashed input chips, the image slot and a disabled try button', async () => {
    renderEditor(viewOf({ template: null, suggestedSlug: 'summarize' }));
    await waitFor(() => expect(byId('template-preview-headline')).toHaveTextContent(draftResponse.draft.headline));

    const chips = screen.getAllByTestId('template-preview-input-chip');
    expect(chips.map(c => c.getAttribute('data-required'))).toEqual(['true', 'false']);
    expect(byId('template-preview-no-image')).toBeInTheDocument();
    expect(byId('template-preview-example')).toHaveTextContent(draftResponse.draft.examplePrompt);
    expect(byId('template-preview-try-btn')).toBeDisabled();

    fireEvent.change(byId('template-editor-headline-input'), { target: { value: 'Edited headline' } });
    expect(byId('template-preview-headline')).toHaveTextContent('Edited headline');
  });
});

describe('TemplateEditor copy fields', () => {
  it.each([
    ['bad slug', /lowercase letters, digits and hyphens/],
    ['-lead', /lowercase letters, digits and hyphens/],
    ['login', /That link name is reserved/],
  ])('refuses the link name %j', (slug, message) => {
    renderEditor(viewOf());
    fireEvent.change(byId('template-editor-slug-input'), { target: { value: slug } });
    expect(byId('template-editor-slug-help')).toHaveTextContent(message);
    expect(byId('template-editor-save-btn')).toBeDisabled();
  });

  it('freezes the link name after the first publish', () => {
    renderEditor(viewOf({ template: template({ status: 'published', firstPublishedAt: '2026-01-02' }) }));
    expect(byId('template-editor-slug-input')).toBeDisabled();
    expect(byId('template-editor-slug-help')).toHaveTextContent('cannot change after the first publish');
  });

  it('edits inputs up to the maximum, with a label and a required toggle each', () => {
    renderEditor(viewOf());
    expect(byId('template-editor-save-btn')).toBeDisabled();

    fireEvent.click(byId('template-editor-add-input-btn'));
    expect(byId('template-editor-form-problem')).toHaveTextContent('Give every input a label');
    fireEvent.change(byId('template-editor-input-label-1'), { target: { value: 'Tone' } });
    fireEvent.click(byId('template-editor-input-required-1'));
    fireEvent.click(byId('template-editor-add-input-btn'));
    fireEvent.change(byId('template-editor-input-label-2'), { target: { value: 'Length' } });
    expect(byId('template-editor-add-input-btn')).toBeDisabled();

    fireEvent.click(byId('template-editor-input-remove-2'));
    expect(byId('template-editor-add-input-btn')).not.toBeDisabled();
    fireEvent.click(byId('template-editor-save-btn'));
    expect(h.save).toHaveBeenCalledWith(
      expect.objectContaining({
        inputs: [
          { label: 'Article', required: true },
          { label: 'Tone', required: false },
        ],
      })
    );
  });

  it('asks before regenerating, then replaces the copy but keeps the slug', async () => {
    renderEditor(viewOf());
    fireEvent.click(byId('template-editor-regenerate-btn'));
    expect(byId('template-editor-regenerate-dialog')).toBeInTheDocument();
    expect(h.draft).not.toHaveBeenCalled();

    fireEvent.click(byId('template-editor-regenerate-confirm'));

    await waitFor(() => expect(byId('template-editor-headline-input')).toHaveValue(draftResponse.draft.headline));
    expect(byId('template-editor-slug-input')).toHaveValue('summarize');
    expect(h.save).not.toHaveBeenCalled();
  });

  it('flags a stale template and can keep the current copy against the new version', async () => {
    renderEditor(viewOf({ template: template({ stale: true }), currentApprovedVersionId: 'v2' }));
    expect(byId('template-editor-stale-banner')).toHaveTextContent('This template may be out of date');

    fireEvent.click(byId('template-editor-keep-copy-btn'));

    await waitFor(() => expect(h.save).toHaveBeenCalledWith({ generatedFromVersionId: 'v2' }));
  });
});

describe('TemplateEditor free run', () => {
  it('offers the switch when the skill is eligible', async () => {
    renderEditor(viewOf());
    expect(screen.queryByTestId('template-editor-free-run-reason')).toBeNull();
    fireEvent.click(byId('template-editor-free-run-switch'));
    await waitFor(() => expect(h.freeRun).toHaveBeenCalledWith(true));
  });

  it('shows the reason instead when it is not', () => {
    const reason = 'This skill uses tools, so it cannot offer a free run.';
    renderEditor(viewOf({ eligibility: { eligible: false, reason } }));
    expect(screen.queryByTestId('template-editor-free-run-switch')).toBeNull();
    expect(byId('template-editor-free-run-reason')).toHaveTextContent(reason);
  });
});

describe('TemplateEditor publishing', () => {
  const unapproved = { fabFileId: 'f1', source: 'upload', approved: false };

  it('holds Publish until the preview image is approved, with the reason', () => {
    renderEditor(
      viewOf({
        template: template({ previewImage: unapproved }),
        previewImageUrl: 'https://img.example/f1.jpg',
        previewImageStatus: 'ready',
      })
    );
    expect(byId('template-editor-publish-btn')).toBeDisabled();
    expect(byId('template-editor-publish-reason')).toHaveTextContent('Approve the preview image first.');
    expect(byId('template-preview-image')).toHaveAttribute('src', 'https://img.example/f1.jpg');
  });

  it('holds Publish while there are unsaved changes', () => {
    renderEditor(viewOf());
    expect(byId('template-editor-publish-btn')).not.toBeDisabled();
    fireEvent.change(byId('template-editor-headline-input'), { target: { value: 'Changed' } });
    expect(byId('template-editor-publish-btn')).toBeDisabled();
    expect(byId('template-editor-publish-reason')).toHaveTextContent('Save your changes first.');
  });

  it('publishes a saved draft', async () => {
    h.publish.mockResolvedValue(template({ status: 'published' }));
    renderEditor(viewOf());
    fireEvent.click(byId('template-editor-publish-btn'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Template published'));
  });

  it('shows the scan findings of a failed publish', () => {
    const finding = {
      rule: 'html_or_script',
      severity: 'critical',
      message: 'Markup in the headline',
      source: 'rules',
    };
    renderEditor(viewOf({ template: template({ scanStatus: 'failed', scanFindings: [finding] }) }));
    const failed = byId('template-editor-scan-failed');
    expect(within(failed).getByTestId('market-findings')).toHaveTextContent('Markup in the headline');
  });

  it('offers Unpublish, the template link and the counters once published', async () => {
    renderEditor(viewOf({ template: template({ status: 'published', firstPublishedAt: '2026-01-02' }) }));
    expect(screen.queryByTestId('template-editor-publish-btn')).toBeNull();
    expect(byId('template-editor-counters')).toHaveTextContent('12 views, 3 free runs, 2 tries');

    fireEvent.click(byId('template-editor-copy-link-btn'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/t/summarize`));

    h.unpublish.mockResolvedValue(template());
    fireEvent.click(byId('template-editor-unpublish-btn'));
    await waitFor(() => expect(h.unpublish).toHaveBeenCalled());
  });
});

describe('TemplateEditor preview image', () => {
  it('approves a checked image and shows the source', async () => {
    renderEditor(
      viewOf({
        template: template({ previewImage: { fabFileId: 'f1', source: 'generated', approved: false } }),
        previewImageUrl: 'https://img.example/f1.jpg',
        previewImageStatus: 'ready',
      })
    );
    expect(byId('template-image-source')).toHaveTextContent('Generated');
    fireEvent.click(byId('template-image-approve-btn'));
    await waitFor(() => expect(h.approve).toHaveBeenCalled());
  });

  it('waits for moderation before the image can be approved', () => {
    renderEditor(
      viewOf({
        template: template({ previewImage: { fabFileId: 'f1', source: 'upload', approved: false } }),
        previewImageStatus: 'pending',
      })
    );
    expect(byId('template-image-approve-btn')).toBeDisabled();
    expect(byId('template-image-status')).toHaveTextContent('Checking the image');
  });

  it('shows Approved and Remove for an approved image', async () => {
    renderEditor(
      viewOf({
        template: template({ previewImage: { fabFileId: 'f1', source: 'upload', approved: true } }),
        previewImageUrl: 'https://img.example/f1.jpg',
        previewImageStatus: 'ready',
      })
    );
    expect(byId('template-image-approved-chip')).toBeInTheDocument();
    expect(screen.queryByTestId('template-image-approve-btn')).toBeNull();
    fireEvent.click(byId('template-image-remove-btn'));
    await waitFor(() => expect(h.remove).toHaveBeenCalled());
  });

  it('locks the image while the template is published', () => {
    renderEditor(
      viewOf({
        template: template({
          status: 'published',
          previewImage: { fabFileId: 'f1', source: 'upload', approved: true },
        }),
        previewImageStatus: 'ready',
      })
    );
    expect(byId('template-image-locked-hint')).toHaveTextContent('Unpublish the template to change its image.');
    expect(screen.queryByTestId('template-image-upload-input')).toBeNull();
    expect(byId('template-image-remove-btn')).toBeDisabled();
  });

  it('uploads a PNG as a file and uses it as the image', async () => {
    h.createFile.mockResolvedValue({ id: 'file-9' });
    renderEditor(viewOf());
    const file = new File(['png'], 'shot.png', { type: 'image/png' });

    fireEvent.change(byId('template-image-upload-input'), { target: { files: [file] } });

    await waitFor(() => expect(h.setImage).toHaveBeenCalledWith('file-9'));
    expect(h.createFile).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: 'shot.png', mimeType: 'image/png', fileSize: file.size }),
      file
    );
  });

  it('refuses a file type the server cannot read before uploading', () => {
    renderEditor(viewOf());
    const file = new File(['gif'], 'anim.gif', { type: 'image/gif' });
    fireEvent.change(byId('template-image-upload-input'), { target: { files: [file] } });
    expect(toast.error).toHaveBeenCalledWith('Upload a PNG or JPEG image');
    expect(h.createFile).not.toHaveBeenCalled();
  });

  it('generates from a pasted result on the Generate tab and notes the credits', async () => {
    renderEditor(viewOf());
    fireEvent.click(byId('template-image-generate-tab'));
    expect(await screen.findByTestId('template-image-credits-note')).toHaveTextContent('your own credits');

    fireEvent.change(byId('template-image-result-input'), { target: { value: '  - one\n- two  ' } });
    fireEvent.click(byId('template-image-generate-btn'));

    await waitFor(() => expect(h.generate).toHaveBeenCalledWith('- one\n- two'));
  });
});

describe('TemplateEditor stale responses', () => {
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => {
      resolve = r;
    });
    return { promise, resolve };
  };

  it('keeps edits made while a save is in flight', async () => {
    const pending = deferred<ReturnType<typeof template>>();
    h.save.mockImplementationOnce(() => pending.promise);
    renderEditor(viewOf());

    fireEvent.change(byId('template-editor-headline-input'), { target: { value: 'First edit' } });
    fireEvent.click(byId('template-editor-save-btn'));
    await waitFor(() => expect(h.save).toHaveBeenCalled());
    fireEvent.change(byId('template-editor-headline-input'), { target: { value: 'Newer edit' } });

    pending.resolve(template({ headline: 'First edit' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Template saved'));

    expect(byId('template-editor-headline-input')).toHaveValue('Newer edit');
  });

  it('discards a regenerated draft when the copy was edited while it drafted', async () => {
    const pending = deferred<typeof draftResponse>();
    h.draft.mockImplementationOnce(() => pending.promise);
    renderEditor(viewOf());

    fireEvent.click(byId('template-editor-regenerate-btn'));
    fireEvent.click(byId('template-editor-regenerate-confirm'));
    await waitFor(() => expect(h.draft).toHaveBeenCalled());
    fireEvent.change(byId('template-editor-headline-input'), { target: { value: 'Mine' } });

    pending.resolve(draftResponse);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());

    expect(byId('template-editor-headline-input')).toHaveValue('Mine');
  });

  const viewB = () =>
    viewOf({
      template: template({ listingId: 'l2', slug: 'b-slug', headline: 'B headline' }),
      listing: { id: 'l2', name: 'other', visibility: 'public', live: true },
    });

  const wrap = (listingId: string) => (
    <CssVarsProvider theme={appTheme}>
      <TemplateEditor listingId={listingId} />
    </CssVarsProvider>
  );

  // Without the [listingId] reset effect, A's edited form would stay (the seed effect skips a set form).
  it('resets to the new listing fields, not the edited ones of the previous listing, when listingId changes', async () => {
    h.view = viewOf({ template: template({ headline: 'A headline', slug: 'a-slug' }) });
    const { rerender } = render(wrap('l1'));
    await waitFor(() => expect(byId('template-editor-headline-input')).toHaveValue('A headline'));
    fireEvent.change(byId('template-editor-headline-input'), { target: { value: 'A edited' } });

    h.view = viewB();
    rerender(wrap('l2'));

    await waitFor(() => expect(byId('template-editor-headline-input')).toHaveValue('B headline'));
    expect(byId('template-editor-slug-input')).toHaveValue('b-slug');
  });

  // Without the isCurrent guard, A's late draft would call setForm and overwrite B's form.
  it('ignores a draft for the previous listing that resolves after the listingId changed', async () => {
    const pending = deferred<typeof draftResponse>();
    h.draft.mockImplementationOnce(() => pending.promise);
    h.view = viewOf({ template: null, suggestedSlug: 'a-slug' });
    const { rerender } = render(wrap('l1'));
    await waitFor(() => expect(h.draft).toHaveBeenCalled());

    h.view = viewB();
    rerender(wrap('l2'));
    await waitFor(() => expect(byId('template-editor-headline-input')).toHaveValue('B headline'));

    await act(async () => {
      pending.resolve(draftResponse);
    });
    expect(byId('template-editor-headline-input')).toHaveValue('B headline');
    expect(byId('template-editor-slug-input')).toHaveValue('b-slug');
  });
});
