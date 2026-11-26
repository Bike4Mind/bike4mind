import { ChangeEvent, FC, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControl,
  FormLabel,
  Sheet,
  Stack,
  Switch,
  Textarea,
  Typography,
} from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import UploadIcon from '@mui/icons-material/Upload';
import { toast } from 'sonner';
import {
  KnowledgeType,
  SKILL_TEMPLATE_EXAMPLE_DAILY_RUN_CAP,
  SKILL_TEMPLATE_EXAMPLE_PROMPT_MAX,
  type SkillTemplateEditorView,
  type SkillTemplateExampleUpdate,
} from '@bike4mind/common';
import { useCreateFabFileWithUpload } from '@client/app/hooks/data/fabFileMutations';
import { useEditSkillTemplateExample, useRunSkillTemplateExample } from '@client/app/hooks/data/skillTemplate';
import { getErrorMessage } from '@client/app/utils/error';

export const EXAMPLE_STALE_TEXT = 'A newer version of this skill was approved. Re-run the example to update the page.';

/** Offset ranges covered by ``` or ~~~ fenced blocks; an unclosed fence runs to the end. */
function fencedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let open: { char: string; size: number; start: number } | null = null;
  let offset = 0;
  for (const line of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      const char = marker[1][0];
      const size = marker[1].length;
      if (!open) open = { char, size, start: offset };
      else if (char === open.char && size >= open.size && !line.slice(marker[0].length).trim()) {
        ranges.push([open.start, offset + line.length]);
        open = null;
      }
    }
    offset += line.length + 1;
  }
  if (open) ranges.push([open.start, text.length]);
  return ranges;
}

/**
 * The reply's paragraphs with the offset each ends at; a trim cuts the reply at one of those ends.
 * A blank line inside a fenced code block is not a break, so a trim never leaves a fence unclosed.
 */
export function replyParagraphs(reply: string): Array<{ text: string; start: number; end: number }> {
  const paragraphs: Array<{ text: string; start: number; end: number }> = [];
  const fences = fencedRanges(reply);
  const breaks = /\n\s*\n/g;
  let start = 0;
  for (let match = breaks.exec(reply); match; match = breaks.exec(reply)) {
    if (fences.some(([from, to]) => match.index >= from && match.index < to)) continue;
    if (reply.slice(start, match.index).trim()) {
      paragraphs.push({ text: reply.slice(start, match.index), start, end: match.index });
    }
    start = match.index + match[0].length;
  }
  if (reply.slice(start).trim()) paragraphs.push({ text: reply.slice(start), start, end: reply.length });
  return paragraphs;
}

type Props = { listingId: string; view: SkillTemplateEditorView };

/**
 * The example run the public page replays. The platform runs the skill; the author picks the prompt,
 * re-runs, trims the reply, swaps the sample file or switches the demo off, but never writes the
 * reply or artifact.
 */
const TemplateExampleSection: FC<Props> = ({ listingId, view }) => {
  const { template } = view;
  const example = template?.example ?? null;
  const runExample = useRunSkillTemplateExample(listingId);
  const editExample = useEditSkillTemplateExample(listingId);
  const createFile = useCreateFabFileWithUpload();
  const [prompt, setPrompt] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const autoRunFor = useRef<string | null>(null);

  const runsLeft = view.exampleRunsLeftToday ?? 0;
  const scanning = template?.status === 'in_review';
  const running = example?.status === 'running';
  const canRun = Boolean(template && view.listing.live && !scanning && !running && runsLeft > 0);

  // The first run happens by itself once the copy (and its example prompt) is saved, like the draft step.
  const { mutateAsync: startRun } = runExample;
  useEffect(() => {
    if (!template || example || !template.examplePrompt.trim() || !canRun) return;
    if (autoRunFor.current === listingId) return;
    autoRunFor.current = listingId;
    startRun({}).catch(e => toast.error(getErrorMessage(e)));
  }, [template, example, canRun, listingId, startRun]);

  if (!template) {
    return (
      <Typography level="body-sm" textColor="text.tertiary" data-testid="template-example-save-first">
        Save the template to run the example.
      </Typography>
    );
  }

  const promptValue = prompt ?? (example?.prompt || template.examplePrompt);
  const stale =
    Boolean(example) &&
    (template.stale ||
      Boolean(
        example?.generatedFromVersionId &&
        view.currentApprovedVersionId &&
        example.generatedFromVersionId !== view.currentApprovedVersionId
      ));
  const runBlocker = !view.listing.live
    ? 'Only an approved listing can run its example.'
    : scanning
      ? 'The template is being scanned.'
      : runsLeft <= 0
        ? `You have used all ${SKILL_TEMPLATE_EXAMPLE_DAILY_RUN_CAP} example runs for today. Try again tomorrow (UTC).`
        : null;
  const editLocked = scanning || running || editExample.isPending || uploading;

  const rerun = async () => {
    try {
      const trimmed = promptValue.trim();
      await runExample.mutateAsync(trimmed ? { prompt: trimmed } : {});
      setPrompt(null);
    } catch (e) {
      toast.error(getErrorMessage(e));
    }
  };

  const edit = async (body: SkillTemplateExampleUpdate, success?: string) => {
    try {
      const saved = await editExample.mutateAsync(body);
      if (template.status === 'published' && saved.status !== 'published') {
        toast.error('The example did not pass the scan, so the page is a draft again');
      } else if (success) {
        toast.success(success);
      }
    } catch (e) {
      toast.error(getErrorMessage(e));
    }
  };

  const onSampleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploading(true);
    try {
      const uploaded = await createFile(
        {
          type: KnowledgeType.FILE,
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          fileSize: file.size,
        },
        file
      );
      await edit({ sampleFabFileId: uploaded.id }, 'Sample file set. Re-run the example to use it.');
    } catch (e) {
      toast.error(getErrorMessage(e));
    } finally {
      setUploading(false);
    }
  };

  const rerunButton = (testId: string, label: string) => (
    <Button
      size="sm"
      startDecorator={<RefreshIcon />}
      disabled={!canRun || !promptValue.trim()}
      loading={runExample.isPending}
      onClick={() => void rerun()}
      data-testid={testId}
    >
      {label}
    </Button>
  );

  const paragraphs = example ? replyParagraphs(example.reply) : [];
  const cut = example?.replyTrimmedTo ?? example?.reply.length ?? 0;

  return (
    <Stack spacing={1.5} data-testid="template-example-section">
      {stale ? (
        <Alert
          color="warning"
          variant="soft"
          data-testid="template-example-stale-warning"
          endDecorator={rerunButton('template-example-stale-rerun-btn', 'Re-run')}
        >
          {EXAMPLE_STALE_TEXT}
        </Alert>
      ) : null}

      {running ? (
        <Stack direction="row" spacing={1} alignItems="center" data-testid="template-example-running">
          <CircularProgress size="sm" />
          <Typography level="body-sm">Running the example. This can take a minute.</Typography>
        </Stack>
      ) : null}

      {example?.status === 'failed' ? (
        <Alert
          color="danger"
          variant="soft"
          data-testid="template-example-failed"
          endDecorator={rerunButton('template-example-retry-btn', 'Retry')}
        >
          <Box>
            <Typography level="title-sm">The example run failed</Typography>
            <Typography level="body-sm" data-testid="template-example-error">
              {example.error || 'Something went wrong.'}
            </Typography>
          </Box>
        </Alert>
      ) : null}

      {!example && !running ? (
        <Typography level="body-sm" textColor="text.tertiary" data-testid="template-example-none">
          The platform runs your skill once on the example prompt and the page replays the result. Runs are on us.
        </Typography>
      ) : null}

      <FormControl>
        <FormLabel>Example run prompt</FormLabel>
        <Textarea
          minRows={2}
          maxRows={6}
          value={promptValue}
          disabled={scanning || running}
          onChange={e => setPrompt(e.target.value)}
          slotProps={{
            textarea: { maxLength: SKILL_TEMPLATE_EXAMPLE_PROMPT_MAX, 'data-testid': 'template-example-prompt-input' },
          }}
        />
      </FormControl>
      <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
        {rerunButton('template-example-rerun-btn', example ? 'Re-run' : 'Run example')}
        <Typography
          level="body-xs"
          textColor={runBlocker ? undefined : 'text.tertiary'}
          color={runBlocker ? 'warning' : undefined}
          data-testid="template-example-runs-left"
        >
          {runBlocker ?? `${runsLeft} of ${SKILL_TEMPLATE_EXAMPLE_DAILY_RUN_CAP} runs left today`}
        </Typography>
      </Stack>

      {example ? (
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Switch
            checked={example.enabled}
            disabled={editLocked}
            onChange={e => void edit({ enabled: e.target.checked })}
            slotProps={{ input: { 'data-testid': 'template-example-enabled-switch' } }}
          />
          <Typography level="body-sm">Show the example on the page</Typography>
        </Stack>
      ) : null}

      {example && paragraphs.length > 1 ? (
        <Box data-testid="template-example-trim">
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 0.5 }}>
            <Typography level="title-sm">Trim the reply</Typography>
            {example.replyTrimmedTo ? (
              <Button
                size="sm"
                variant="plain"
                disabled={editLocked}
                onClick={() => void edit({ replyTrimmedTo: null }, 'Showing the whole reply')}
                data-testid="template-example-trim-reset-btn"
              >
                Show the whole reply
              </Button>
            ) : null}
          </Stack>
          <Typography level="body-xs" textColor="text.tertiary" sx={{ mb: 0.75 }}>
            The page can stop the reply after any paragraph. It can only be shortened.
          </Typography>
          <Stack spacing={0.75}>
            {paragraphs.map((paragraph, i) => {
              const hidden = paragraph.start >= cut;
              const isCut = paragraph.end === example.replyTrimmedTo;
              return (
                <Sheet
                  key={paragraph.start}
                  variant="soft"
                  sx={{ p: 1, borderRadius: 'sm', opacity: hidden ? 0.45 : 1 }}
                  data-testid={`template-example-paragraph-${i}`}
                  data-hidden={hidden ? 'true' : 'false'}
                >
                  <Typography level="body-xs" sx={{ whiteSpace: 'pre-wrap' }}>
                    {paragraph.text.trim()}
                  </Typography>
                  {paragraph.end < example.reply.length ? (
                    <Button
                      size="sm"
                      variant={isCut ? 'solid' : 'plain'}
                      disabled={editLocked || isCut}
                      onClick={() => void edit({ replyTrimmedTo: paragraph.end }, 'Reply trimmed')}
                      sx={{ mt: 0.5 }}
                      data-testid={`template-example-trim-btn-${i}`}
                    >
                      {isCut ? 'The reply ends here' : 'End the reply here'}
                    </Button>
                  ) : null}
                </Sheet>
              );
            })}
          </Stack>
        </Box>
      ) : null}

      {template.takesFile ? (
        <Box data-testid="template-example-sample">
          <Typography level="title-sm" sx={{ mb: 0.5 }}>
            Sample file
          </Typography>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            {example?.sampleFile ? (
              <>
                <Typography level="body-sm" data-testid="template-example-sample-name">
                  {example.sampleFile.name}
                </Typography>
                <Chip size="sm" variant="outlined" data-testid="template-example-sample-source">
                  {example.sampleFile.source === 'upload' ? 'Uploaded' : 'Generated'}
                </Chip>
              </>
            ) : (
              <Typography level="body-sm" textColor="text.tertiary">
                A short sample file is generated for the run.
              </Typography>
            )}
            {example ? (
              <Button
                component="label"
                size="sm"
                variant="outlined"
                startDecorator={<UploadIcon />}
                loading={uploading}
                disabled={editLocked}
              >
                Upload my own
                <input
                  hidden
                  type="file"
                  onChange={e => void onSampleFile(e)}
                  data-testid="template-example-sample-input"
                />
              </Button>
            ) : null}
            {example?.sampleFile?.source === 'upload' ? (
              <Button
                size="sm"
                variant="plain"
                disabled={editLocked}
                onClick={() => void edit({ sampleFabFileId: null }, 'The next run generates a sample file')}
                data-testid="template-example-sample-reset-btn"
              >
                Use a generated sample
              </Button>
            ) : null}
          </Stack>
        </Box>
      ) : null}

      {template.status === 'published' && example ? (
        <Typography level="body-xs" textColor="text.tertiary">
          Changes to the example on a published page are scanned before they go live.
        </Typography>
      ) : null}
    </Stack>
  );
};

export default TemplateExampleSection;
