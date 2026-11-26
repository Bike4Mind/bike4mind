import { FC, ReactNode, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  Checkbox,
  Chip,
  CircularProgress,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormHelperText,
  FormLabel,
  IconButton,
  Input,
  Modal,
  ModalDialog,
  Stack,
  Switch,
  Textarea,
  Typography,
} from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import {
  SKILL_TEMPLATE_EXAMPLE_PROMPT_MAX,
  SKILL_TEMPLATE_HEADLINE_MAX,
  SKILL_TEMPLATE_INPUT_LABEL_MAX,
  SKILL_TEMPLATE_MAX_INPUTS,
  SKILL_TEMPLATE_SLUG_MAX,
  skillTemplatePagePath,
  type ISkillListingTemplate,
  type SkillTemplateEditorView,
  type SkillTemplateStatus,
} from '@bike4mind/common';
import {
  useDraftSkillTemplate,
  usePublishSkillTemplate,
  useSaveSkillTemplate,
  useSetSkillTemplateFreeRun,
  useSkillTemplate,
  useUnpublishSkillTemplate,
} from '@client/app/hooks/data/skillTemplate';
import { getErrorMessage } from '@client/app/utils/error';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';
import { FindingsList, formatCount } from '@client/app/components/SkillMarket/parts';
import TemplatePreview from './TemplatePreview';
import TemplateImageSection from './TemplateImageSection';
import TemplateExampleSection from './TemplateExampleSection';
import TemplateLivePreview from './TemplateLivePreview';
import {
  EMPTY_DRAFT,
  formFromDraft,
  formFromTemplate,
  formIsDirty,
  formToUpdate,
  inputsProblem,
  slugProblem,
  type TemplateForm,
} from './templateForm';

const SLUG_HINT = 'Lowercase letters, digits and hyphens. It is fixed once the page is first published.';

const STATUS_CHIP: Record<SkillTemplateStatus, { label: string; color: 'neutral' | 'warning' | 'success' }> = {
  draft: { label: 'Draft', color: 'neutral' },
  in_review: { label: 'Being scanned', color: 'warning' },
  published: { label: 'Published', color: 'success' },
};

const Section: FC<{ title: string; action?: ReactNode; children: ReactNode; testId?: string }> = ({
  title,
  action,
  children,
  testId,
}) => (
  <Card variant="outlined" sx={{ gap: 1.5 }} data-testid={testId}>
    <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1}>
      <Typography level="title-md">{title}</Typography>
      {action}
    </Stack>
    {children}
  </Card>
);

/** Why Publish is unavailable, or null when it can run. */
function publishBlocker(view: SkillTemplateEditorView, template: ISkillListingTemplate | null, dirty: boolean) {
  if (!view.listing.live) return 'Only an approved listing can have a template page.';
  if (!template) return 'Save the template first.';
  if (dirty) return 'Save your changes first.';
  if (!template.headline.trim()) return 'Add a headline first.';
  if (template.previewImage && !template.previewImage.approved) return 'Approve the preview image first.';
  return null;
}

/** The listing author's editor for the listing's public template page. */
const TemplateEditor: FC<{ listingId: string }> = ({ listingId }) => {
  const navigate = useNavigate();
  const { data: view, isLoading, isError, error } = useSkillTemplate(listingId);
  const { mutateAsync: requestDraft, isPending: drafting } = useDraftSkillTemplate(listingId);
  const save = useSaveSkillTemplate(listingId);
  const publish = usePublishSkillTemplate(listingId);
  const unpublish = useUnpublishSkillTemplate(listingId);
  const freeRun = useSetSkillTemplateFreeRun(listingId);
  const [form, setForm] = useState<TemplateForm | null>(null);
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const draftRequested = useRef<string | null>(null);
  const currentListingId = useRef(listingId);
  const alive = useRef(true);
  // Bumped on every edit of the working copy, so a server response can tell whether it is still current.
  const revision = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    currentListingId.current = listingId;
    draftRequested.current = null;
    revision.current += 1;
    setForm(null);
  }, [listingId]);

  // Seed the form once: from the saved template, or from a draft that is only stored on Save.
  useEffect(() => {
    if (!view || form) return;
    if (view.template) {
      setForm(formFromTemplate(view.template));
      return;
    }
    if (!view.listing.live || draftRequested.current === listingId) return;
    draftRequested.current = listingId;
    const slug = view.suggestedSlug ?? '';
    const isCurrent = () => alive.current && currentListingId.current === listingId;
    requestDraft()
      .then(({ draft, generatedFromVersionId }) => {
        if (isCurrent()) setForm(formFromDraft(slug, draft, generatedFromVersionId));
      })
      .catch(e => {
        if (!isCurrent()) return;
        toast.error(getErrorMessage(e));
        setForm(formFromDraft(slug, EMPTY_DRAFT, view.currentApprovedVersionId));
      });
  }, [view, form, requestDraft, listingId]);

  const back = (
    <Button
      variant="plain"
      size="sm"
      startDecorator={<ArrowBackIcon />}
      onClick={() => navigate({ to: '/skills/market/mine' })}
      sx={{ alignSelf: 'flex-start' }}
    >
      My listings
    </Button>
  );

  if (isLoading) {
    return (
      <Stack alignItems="center" sx={{ py: 6 }}>
        <CircularProgress />
      </Stack>
    );
  }
  if (isError || !view) {
    return (
      <Stack spacing={2} sx={{ p: { xs: 2, md: 3 }, maxWidth: 1200, mx: 'auto' }}>
        {back}
        <Alert color="danger" data-testid="template-editor-load-error">
          {getErrorMessage(error) || "Couldn't load the template."}
        </Alert>
      </Stack>
    );
  }

  const template = view.template;
  const slugFrozen = Boolean(template?.firstPublishedAt);
  const scanning = template?.status === 'in_review';
  const dirty = form ? formIsDirty(form, template) : false;
  const slugError = form ? slugProblem(form, slugFrozen) : null;
  const inputsError = form ? inputsProblem(form) : null;
  const blocker = publishBlocker(view, template, dirty);
  const status = template ? STATUS_CHIP[template.status] : null;

  const update = (patch: Partial<TemplateForm>) => {
    revision.current += 1;
    setForm(current => (current ? { ...current, ...patch } : current));
  };
  const updateInput = (index: number, patch: Partial<TemplateForm['inputs'][number]>) => {
    revision.current += 1;
    setForm(current =>
      current
        ? { ...current, inputs: current.inputs.map((input, i) => (i === index ? { ...input, ...patch } : input)) }
        : current
    );
  };

  const doSave = async () => {
    if (!form) return;
    const submittedRevision = revision.current;
    try {
      const saved = await save.mutateAsync(formToUpdate(form, slugFrozen));
      if (alive.current && revision.current === submittedRevision) setForm(formFromTemplate(saved));
      // Saving new copy on a published page re-runs the scan; a miss takes the page down to a draft.
      if (template?.status === 'published' && saved.status !== 'published') {
        toast.error('The new copy did not pass the scan, so the page is a draft again');
      } else {
        toast.success('Template saved');
      }
    } catch (e) {
      toast.error(getErrorMessage(e));
    }
  };

  const keepMyCopy = async () => {
    if (!view.currentApprovedVersionId) return;
    try {
      await save.mutateAsync({ generatedFromVersionId: view.currentApprovedVersionId });
      toast.success('Kept your copy');
    } catch (e) {
      toast.error(getErrorMessage(e));
    }
  };

  const regenerate = async () => {
    setRegenerateOpen(false);
    const startedRevision = revision.current;
    try {
      const { draft, generatedFromVersionId } = await requestDraft();
      if (!alive.current || currentListingId.current !== listingId) return;
      if (revision.current !== startedRevision) {
        toast.error('You edited the copy while it was drafting, so the new draft was discarded');
        return;
      }
      setForm(current => formFromDraft(current?.slug ?? template?.slug ?? '', draft, generatedFromVersionId));
      toast.success('New copy drafted. Save to keep it.');
    } catch (e) {
      toast.error(getErrorMessage(e));
    }
  };

  const doPublish = async () => {
    try {
      const result = await publish.mutateAsync();
      if (result.status === 'published') toast.success('Template published');
      else toast.error('The template did not pass the scan. See the findings below.');
    } catch (e) {
      toast.error(getErrorMessage(e));
    }
  };

  const doUnpublish = async () => {
    try {
      await unpublish.mutateAsync();
      toast.success('Template unpublished');
    } catch (e) {
      toast.error(getErrorMessage(e));
    }
  };

  const setFreeRun = async (enabled: boolean) => {
    try {
      await freeRun.mutateAsync(enabled);
    } catch (e) {
      toast.error(getErrorMessage(e));
    }
  };

  const copyLink = (slug: string) =>
    void navigator.clipboard
      .writeText(`${window.location.origin}${skillTemplatePagePath(slug)}`)
      .then(() => toast.success('Template link copied'));

  return (
    <Box sx={{ height: '100%', overflowY: 'auto', ...scrollbarStyles }} data-testid="template-editor">
      <Stack spacing={3} sx={{ p: { xs: 2, md: 3 }, maxWidth: 1200, mx: 'auto' }}>
        {back}
        <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography level="h2">Template page</Typography>
          <Typography level="title-md" component="code" sx={{ fontFamily: 'code' }}>
            /{view.listing.name}
          </Typography>
          {status ? (
            <Chip size="sm" variant="solid" color={status.color} data-testid="template-editor-status-chip">
              {status.label}
            </Chip>
          ) : (
            <Chip size="sm" variant="outlined" data-testid="template-editor-status-chip">
              Not saved
            </Chip>
          )}
        </Stack>

        {!view.listing.live ? (
          <Alert color="warning" variant="soft" data-testid="template-editor-not-live">
            Only an approved listing can have a template page. It can be edited again once the listing is live.
          </Alert>
        ) : null}

        {template?.stale ? (
          <Alert
            color="warning"
            variant="soft"
            data-testid="template-editor-stale-banner"
            endDecorator={
              <Stack direction="row" spacing={1}>
                <Button
                  size="sm"
                  variant="solid"
                  color="warning"
                  disabled={scanning || drafting}
                  onClick={() => setRegenerateOpen(true)}
                  data-testid="template-editor-stale-regenerate-btn"
                >
                  Regenerate
                </Button>
                <Button
                  size="sm"
                  variant="plain"
                  color="warning"
                  disabled={scanning || save.isPending || !view.currentApprovedVersionId}
                  onClick={() => void keepMyCopy()}
                  data-testid="template-editor-keep-copy-btn"
                >
                  Keep my copy
                </Button>
              </Stack>
            }
          >
            <Box>
              <Typography level="title-sm">This template may be out of date</Typography>
              <Typography level="body-sm">
                A newer version of the skill was approved after this copy was written.
              </Typography>
            </Box>
          </Alert>
        ) : null}

        <Box sx={{ display: 'grid', gap: 3, gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) 420px' } }}>
          <Stack spacing={2.5} sx={{ minWidth: 0 }}>
            {!form ? (
              <Card variant="outlined" sx={{ alignItems: 'center', py: 4 }} data-testid="template-editor-drafting">
                {view.listing.live ? <CircularProgress size="sm" /> : null}
                <Typography level="body-sm" textColor="text.tertiary">
                  {view.listing.live ? 'Drafting copy from your skill...' : 'There is no template yet.'}
                </Typography>
              </Card>
            ) : (
              <Section
                title="Copy"
                testId="template-editor-copy"
                action={
                  <Button
                    size="sm"
                    variant="plain"
                    startDecorator={<RefreshIcon />}
                    disabled={!view.listing.live || scanning || drafting}
                    loading={drafting}
                    onClick={() => setRegenerateOpen(true)}
                    data-testid="template-editor-regenerate-btn"
                  >
                    Regenerate
                  </Button>
                }
              >
                <FormControl error={Boolean(slugError)}>
                  <FormLabel>Link name</FormLabel>
                  <Input
                    value={form.slug}
                    disabled={slugFrozen}
                    startDecorator={
                      <Typography level="body-sm" textColor="text.tertiary">
                        /t/
                      </Typography>
                    }
                    onChange={e => update({ slug: e.target.value.toLowerCase() })}
                    slotProps={{
                      input: { maxLength: SKILL_TEMPLATE_SLUG_MAX, 'data-testid': 'template-editor-slug-input' },
                    }}
                  />
                  <FormHelperText data-testid="template-editor-slug-help">
                    {slugFrozen ? 'The link name cannot change after the first publish.' : (slugError ?? SLUG_HINT)}
                  </FormHelperText>
                </FormControl>

                <FormControl>
                  <FormLabel>Headline</FormLabel>
                  <Input
                    value={form.headline}
                    placeholder="What the skill does for someone, in one line"
                    onChange={e => update({ headline: e.target.value })}
                    slotProps={{
                      input: {
                        maxLength: SKILL_TEMPLATE_HEADLINE_MAX,
                        'data-testid': 'template-editor-headline-input',
                      },
                    }}
                  />
                </FormControl>

                <Box>
                  <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 0.75 }}>
                    <FormLabel>What people bring</FormLabel>
                    <Button
                      size="sm"
                      variant="plain"
                      startDecorator={<AddIcon />}
                      disabled={form.inputs.length >= SKILL_TEMPLATE_MAX_INPUTS}
                      onClick={() => update({ inputs: [...form.inputs, { label: '', required: true }] })}
                      data-testid="template-editor-add-input-btn"
                    >
                      Add input
                    </Button>
                  </Stack>
                  <Stack spacing={1}>
                    {form.inputs.map((input, i) => (
                      <Stack key={i} direction="row" spacing={1} alignItems="center">
                        <Input
                          sx={{ flex: 1 }}
                          value={input.label}
                          placeholder="For example: Article text"
                          onChange={e => updateInput(i, { label: e.target.value })}
                          slotProps={{
                            input: {
                              maxLength: SKILL_TEMPLATE_INPUT_LABEL_MAX,
                              'data-testid': `template-editor-input-label-${i}`,
                            },
                          }}
                        />
                        <Checkbox
                          size="sm"
                          label="Required"
                          checked={input.required}
                          onChange={e => updateInput(i, { required: e.target.checked })}
                          slotProps={{ input: { 'data-testid': `template-editor-input-required-${i}` } }}
                        />
                        <IconButton
                          size="sm"
                          variant="plain"
                          color="neutral"
                          aria-label="Remove input"
                          onClick={() => update({ inputs: form.inputs.filter((_, j) => j !== i) })}
                          data-testid={`template-editor-input-remove-${i}`}
                        >
                          <DeleteOutlineIcon />
                        </IconButton>
                      </Stack>
                    ))}
                    {form.inputs.length === 0 ? (
                      <Typography level="body-xs" textColor="text.tertiary">
                        No inputs. Add up to {SKILL_TEMPLATE_MAX_INPUTS}.
                      </Typography>
                    ) : null}
                  </Stack>
                </Box>

                <FormControl>
                  <FormLabel>Example prompt</FormLabel>
                  <Textarea
                    minRows={2}
                    maxRows={8}
                    value={form.examplePrompt}
                    onChange={e => update({ examplePrompt: e.target.value })}
                    slotProps={{
                      textarea: {
                        maxLength: SKILL_TEMPLATE_EXAMPLE_PROMPT_MAX,
                        'data-testid': 'template-editor-example-input',
                      },
                    }}
                  />
                </FormControl>

                <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Button
                    disabled={!dirty || Boolean(slugError || inputsError) || scanning || !view.listing.live}
                    loading={save.isPending}
                    onClick={() => void doSave()}
                    data-testid="template-editor-save-btn"
                  >
                    Save
                  </Button>
                  {inputsError ? (
                    <Typography level="body-xs" color="danger" data-testid="template-editor-form-problem">
                      {inputsError}
                    </Typography>
                  ) : template?.status === 'published' && dirty ? (
                    <Typography level="body-xs" textColor="text.tertiary">
                      Saving a published template scans the new copy before it goes live again.
                    </Typography>
                  ) : !template ? (
                    <Typography level="body-xs" textColor="text.tertiary">
                      Nothing is stored until you save.
                    </Typography>
                  ) : null}
                </Stack>
              </Section>
            )}

            <Section title="Example run" testId="template-editor-example">
              <TemplateExampleSection listingId={listingId} view={view} />
            </Section>

            <Section title="Preview image" testId="template-editor-image">
              <TemplateImageSection listingId={listingId} view={view} />
            </Section>

            {view.eligibility ? (
              <Section title="Free run" testId="template-editor-free-run">
                {view.eligibility.eligible ? (
                  <Stack direction="row" spacing={1.5} alignItems="center">
                    <Switch
                      checked={template?.freeRunEnabled ?? false}
                      disabled={!template || scanning || freeRun.isPending}
                      onChange={e => void setFreeRun(e.target.checked)}
                      slotProps={{ input: { 'data-testid': 'template-editor-free-run-switch' } }}
                    />
                    <Typography level="body-sm">
                      {template
                        ? 'Let visitors try the skill once before they sign up.'
                        : 'Save the template to offer a free run.'}
                    </Typography>
                  </Stack>
                ) : (
                  <Typography level="body-sm" textColor="text.tertiary" data-testid="template-editor-free-run-reason">
                    {view.eligibility.reason}
                  </Typography>
                )}
              </Section>
            ) : null}

            <Section title="Publish" testId="template-editor-publish">
              {template?.scanStatus === 'failed' && template.status === 'draft' ? (
                <Alert color="danger" variant="soft" data-testid="template-editor-scan-failed">
                  <Box sx={{ width: '100%' }}>
                    <Typography level="title-sm">
                      The scan did not pass. Fix the copy, save, and publish again.
                    </Typography>
                    <FindingsList findings={template.scanFindings} />
                  </Box>
                </Alert>
              ) : null}
              {template?.scanStatus === 'error' && template.status === 'draft' ? (
                <Alert color="danger" variant="soft" data-testid="template-editor-scan-error">
                  The scan could not finish. Try publishing again.
                </Alert>
              ) : null}
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                {template?.status === 'published' || scanning ? (
                  <Button
                    variant="outlined"
                    color="danger"
                    loading={unpublish.isPending}
                    onClick={() => void doUnpublish()}
                    data-testid="template-editor-unpublish-btn"
                  >
                    Unpublish
                  </Button>
                ) : (
                  <Button
                    disabled={Boolean(blocker)}
                    loading={publish.isPending}
                    onClick={() => void doPublish()}
                    data-testid="template-editor-publish-btn"
                  >
                    Publish
                  </Button>
                )}
                {template?.status === 'published' ? (
                  <Button
                    variant="plain"
                    color="neutral"
                    startDecorator={<ContentCopyIcon />}
                    onClick={() => copyLink(template.slug)}
                    data-testid="template-editor-copy-link-btn"
                  >
                    Copy template link
                  </Button>
                ) : null}
                {template?.status !== 'published' && !scanning && blocker ? (
                  <Typography level="body-xs" textColor="text.tertiary" data-testid="template-editor-publish-reason">
                    {blocker}
                  </Typography>
                ) : null}
              </Stack>
              {template ? (
                <Typography level="body-xs" textColor="text.tertiary" data-testid="template-editor-counters">
                  {formatCount(template.viewCount)} views, {formatCount(template.freeRunCount)} free runs,{' '}
                  {formatCount(template.tryCount)} tries
                </Typography>
              ) : null}
            </Section>
          </Stack>

          <Box sx={{ position: { md: 'sticky' }, top: { md: 0 }, alignSelf: 'start' }}>
            {template ? (
              <TemplateLivePreview listingId={listingId} template={template} unsavedChanges={dirty} />
            ) : (
              <TemplatePreview
                skillName={view.listing.name}
                headline={form?.headline ?? ''}
                inputs={form?.inputs ?? []}
                examplePrompt={form?.examplePrompt ?? ''}
                imageUrl={view.previewImageUrl}
              />
            )}
          </Box>
        </Box>
      </Stack>

      <Modal open={regenerateOpen} onClose={() => setRegenerateOpen(false)}>
        <ModalDialog sx={{ width: 440, maxWidth: '95vw' }} data-testid="template-editor-regenerate-dialog">
          <DialogTitle>Regenerate the copy?</DialogTitle>
          <DialogContent>
            A new headline, inputs and example prompt are drafted from the skill&apos;s approved version and replace
            what is in the editor. Nothing is stored until you save.
          </DialogContent>
          <DialogActions>
            <Button onClick={() => void regenerate()} data-testid="template-editor-regenerate-confirm">
              Regenerate
            </Button>
            <Button variant="plain" color="neutral" onClick={() => setRegenerateOpen(false)}>
              Cancel
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>
    </Box>
  );
};

export default TemplateEditor;
