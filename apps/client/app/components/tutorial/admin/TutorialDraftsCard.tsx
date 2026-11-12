import { FC, useEffect, useState } from 'react';
import {
  Box,
  Button,
  Card,
  Chip,
  CircularProgress,
  FormControl,
  FormLabel,
  Input,
  Option,
  Select,
  Stack,
  Switch,
  Textarea,
  Typography,
} from '@mui/joy';
import type { CoreTutorialVisibility, TutorialDraftView, ValidationIssue } from '@bike4mind/common';
import {
  TutorialDraftRefused,
  useTutorialDraftAction,
  useTutorialDrafts,
  type TutorialDraftAction,
} from '@client/app/hooks/tutorials/useTutorialDrafts';
import { downloadModuleBundle } from './tutorialOverrideExport';

const REASON_MAX = 500;

type VisibilityKind = 'entitlement' | 'public' | '';
interface VisibilityChoice {
  kind: VisibilityKind;
  key: string;
}
const NO_VISIBILITY: VisibilityChoice = { kind: '', key: '' };

const visibilityChoiceOf = (visibility?: CoreTutorialVisibility): VisibilityChoice =>
  visibility?.public
    ? { kind: 'public', key: '' }
    : visibility
      ? { kind: 'entitlement', key: visibility.entitlement }
      : NO_VISIBILITY;

function visibilityOf({ kind, key }: VisibilityChoice): CoreTutorialVisibility | null {
  if (kind === 'public') return { public: true };
  return kind === 'entitlement' && key.trim() ? { entitlement: key.trim() } : null;
}

/** No default: an admin picks who may run the tutorial, so Everyone is never chosen by omission. */
const VisibilityControl: FC<{
  value: VisibilityChoice;
  onChange: (next: VisibilityChoice) => void;
  testid: string;
}> = ({ value, onChange, testid }) => (
  <Stack direction="row" gap={1} alignItems="center">
    <Select
      size="sm"
      placeholder="Who may run it"
      value={value.kind || null}
      onChange={(_, kind) => onChange({ ...value, kind: kind ?? '' })}
      slotProps={{ button: { 'data-testid': `${testid}-kind` } }}
    >
      <Option value="entitlement">Entitlement key</Option>
      <Option value="public">Everyone</Option>
    </Select>
    {value.kind === 'entitlement' && (
      <Input
        size="sm"
        placeholder="entitlement:key"
        value={value.key}
        onChange={event => onChange({ ...value, key: event.target.value })}
        slotProps={{ input: { 'data-testid': `${testid}-key`, 'aria-label': 'Entitlement key' } }}
      />
    )}
  </Stack>
);

interface Buffers {
  title: string;
  pitch: string;
  canvasNodeId: string;
  finaleTitle: string;
  finaleBody: string;
  steps: string;
  replies: Record<number, string>;
  attachTurn: number | null;
  visibility: VisibilityChoice;
}

function buffersOf(draft: TutorialDraftView): Buffers {
  const { content } = draft;
  return {
    title: content.title,
    pitch: content.pitch,
    canvasNodeId: content.canvasNodeId ?? '',
    finaleTitle: content.finale.title,
    finaleBody: content.finale.body,
    steps: JSON.stringify(content.steps, null, 2),
    replies: Object.fromEntries(content.transcript.map((t, i) => [i, t.reply])),
    attachTurn: content.transcript.findIndex(t => t.attachSheet),
    visibility: visibilityChoiceOf(content.visibility),
  };
}

const Rules: FC<{ rules: ValidationIssue[]; testid: string }> = ({ rules, testid }) =>
  rules.length === 0 ? null : (
    <Stack gap={0.25} data-testid={testid}>
      {rules.map((rule, i) => (
        <Typography key={i} level="body-xs" color="danger">
          {rule.stepId ? `${rule.stepId}: ` : ''}
          {rule.message} ({rule.rule})
        </Typography>
      ))}
    </Stack>
  );

/** Admin tab card for making a tutorial module from a session of your own, and approving it before learners see it. */
export interface TutorialDraftsCardProps {
  apiBase: string;
  /** Written into every export, so the apply script can refuse it in the wrong repo. */
  owner: string;
}

const TutorialDraftsCard: FC<TutorialDraftsCardProps> = ({ apiBase, owner }) => {
  const drafts = useTutorialDrafts(apiBase);
  const act = useTutorialDraftAction(apiBase);
  const [reason, setReason] = useState('');
  const [capture, setCapture] = useState({ sessionId: '', moduleId: '', title: '' });
  const [captureVisibility, setCaptureVisibility] = useState<VisibilityChoice>(NO_VISIBILITY);
  const [openId, setOpenId] = useState<string | null>(null);
  const [buffers, setBuffers] = useState<Buffers | null>(null);
  const [refused, setRefused] = useState<ValidationIssue[]>([]);
  const reasonGiven = reason.trim().length > 0;
  const draft = drafts.data?.drafts.find(d => d.moduleId === openId);
  const asksVisibility = drafts.data?.choices.visibility ?? false;
  const showCanvasNode = (drafts.data?.choices.canvasTabs.length ?? 0) > 0;

  useEffect(() => {
    setBuffers(draft ? buffersOf(draft) : null);
    setRefused([]);
  }, [draft?.moduleId, draft?.contentSeq]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = (input: TutorialDraftAction) => {
    setRefused([]);
    act.mutate(input, {
      onSuccess: () => {
        if (input.action === 'capture') {
          setOpenId(input.moduleId);
          setCapture({ sessionId: '', moduleId: '', title: '' });
          setCaptureVisibility(NO_VISIBILITY);
        }
        if (input.action === 'delete') setOpenId(null);
      },
      onError: error => setRefused(error instanceof TutorialDraftRefused ? error.rules : []),
    });
  };

  const save = () => {
    if (!draft || !buffers) return;
    const visibilityChanged =
      JSON.stringify(visibilityOf(buffers.visibility)) !== JSON.stringify(draft.content.visibility ?? null);
    let steps: unknown;
    try {
      steps = JSON.parse(buffers.steps);
    } catch {
      setRefused([{ rule: 'draft-step', message: 'The steps are not valid JSON' }]);
      return;
    }
    run({
      action: 'save',
      moduleId: draft.moduleId,
      contentSeq: draft.contentSeq,
      reason,
      title: buffers.title,
      pitch: buffers.pitch,
      ...(buffers.canvasNodeId && { canvasNodeId: buffers.canvasNodeId }),
      ...(asksVisibility && visibilityChanged && { visibility: visibilityOf(buffers.visibility) }),
      finale: { title: buffers.finaleTitle, body: buffers.finaleBody },
      steps,
      replies: Object.entries(buffers.replies)
        .filter(([turn, reply]) => reply !== draft.content.transcript[Number(turn)]?.reply)
        .map(([turn, reply]) => ({ turn: Number(turn), reply })),
      attachTurn: buffers.attachTurn !== null && buffers.attachTurn >= 0 ? buffers.attachTurn : null,
    });
  };

  const uploadSheet = async (file: File | undefined) => {
    if (!draft || !file) return;
    run({
      action: 'sheet',
      moduleId: draft.moduleId,
      contentSeq: draft.contentSeq,
      reason,
      name: file.name,
      csv: await file.text(),
    });
  };

  const exportDraft = () => {
    if (draft) downloadModuleBundle(draft.content, owner);
  };

  const set = (patch: Partial<Buffers>) => setBuffers(current => (current ? { ...current, ...patch } : current));
  const nodes =
    (draft?.content.canvas as { doc?: { nodes?: { id: string; label?: string }[] } } | undefined)?.doc?.nodes ?? [];

  return (
    <Card variant="outlined" data-testid="tutorial-drafts-card">
      <Box>
        <Typography level="title-md">Made tutorials</Typography>
        <Typography level="body-sm" sx={{ color: 'text.tertiary', mt: 0.5 }}>
          Make a tutorial from a finished session of your own. It plays under Examples only, and only once you approve
          it in the preview and switch it on. Any change after approval switches it off again.
        </Typography>
      </Box>
      <FormControl>
        <Input
          size="sm"
          placeholder="Reason for the change"
          value={reason}
          onChange={event => setReason(event.target.value.slice(0, REASON_MAX))}
          slotProps={{ input: { 'data-testid': 'tutorial-drafts-reason', 'aria-label': 'Reason for the change' } }}
        />
      </FormControl>

      <Stack direction={{ xs: 'column', sm: 'row' }} gap={1}>
        <Input
          size="sm"
          placeholder="Session id"
          value={capture.sessionId}
          onChange={event => setCapture({ ...capture, sessionId: event.target.value.trim() })}
          slotProps={{ input: { 'data-testid': 'tutorial-capture-session', 'aria-label': 'Session id' } }}
        />
        <Input
          size="sm"
          placeholder="new-module-id"
          value={capture.moduleId}
          onChange={event => setCapture({ ...capture, moduleId: event.target.value.toLowerCase() })}
          slotProps={{ input: { 'data-testid': 'tutorial-capture-module-id', 'aria-label': 'Module id' } }}
        />
        <Input
          size="sm"
          placeholder="Title"
          value={capture.title}
          onChange={event => setCapture({ ...capture, title: event.target.value })}
          slotProps={{ input: { 'data-testid': 'tutorial-capture-title', 'aria-label': 'Title' } }}
        />
        <Button
          size="sm"
          data-testid="tutorial-capture-submit"
          loading={act.isPending}
          disabled={
            !capture.sessionId ||
            !capture.moduleId ||
            !capture.title.trim() ||
            (asksVisibility && !visibilityOf(captureVisibility))
          }
          onClick={() =>
            run({
              action: 'capture',
              ...capture,
              ...(asksVisibility && { visibility: visibilityOf(captureVisibility) }),
              ...(reasonGiven && { reason }),
            })
          }
        >
          Capture
        </Button>
      </Stack>
      {asksVisibility && (
        <VisibilityControl
          value={captureVisibility}
          onChange={setCaptureVisibility}
          testid="tutorial-capture-visibility"
        />
      )}

      {drafts.isLoading ? (
        <CircularProgress size="sm" />
      ) : drafts.isError ? (
        <Typography level="body-sm" color="danger">
          Could not read the tutorial drafts.
        </Typography>
      ) : (
        <Stack direction="row" gap={1} flexWrap="wrap">
          {(drafts.data?.drafts ?? []).map(row => (
            <Button
              key={row.moduleId}
              size="sm"
              variant={row.moduleId === openId ? 'solid' : 'outlined'}
              data-testid={`tutorial-draft-open-${row.moduleId}`}
              onClick={() => setOpenId(row.moduleId === openId ? null : row.moduleId)}
            >
              {row.title}
              {row.enabled ? ' (on)' : row.approved ? ' (approved)' : ''}
            </Button>
          ))}
        </Stack>
      )}

      <Rules rules={refused} testid="tutorial-draft-refused" />

      {draft && buffers && (
        <Stack gap={1.5} data-testid={`tutorial-draft-${draft.moduleId}`}>
          <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
            <Typography level="title-sm">{draft.title}</Typography>
            <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
              from session {draft.sourceSessionId}
            </Typography>
            <Chip size="sm" variant="soft" color={draft.approved ? 'success' : 'warning'}>
              {draft.approved ? 'approved' : 'not approved'}
            </Chip>
            {draft.content.sheet && (
              <Chip size="sm" variant="soft">
                {draft.content.sheet.name}
              </Chip>
            )}
          </Stack>

          <Box data-testid="tutorial-draft-preview">
            <Typography level="title-sm">Preview: what a learner walks</Typography>
            <Stack component="ol" gap={0.5} sx={{ pl: 2, my: 0.5 }}>
              {draft.preview.map(step => (
                <Typography component="li" key={step.id} level="body-sm">
                  <b>{step.title ?? step.id}</b> ({step.type}): {step.body}
                </Typography>
              ))}
            </Stack>
            <Rules rules={draft.issues} testid="tutorial-draft-issues" />
          </Box>

          <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
            <Button
              size="sm"
              color="success"
              data-testid="tutorial-draft-approve"
              disabled={!reasonGiven || draft.approved || draft.issues.length > 0 || act.isPending}
              onClick={() => run({ action: 'approve', moduleId: draft.moduleId, contentSeq: draft.contentSeq, reason })}
            >
              Approve this preview
            </Button>
            <Switch
              checked={draft.enabled}
              disabled={!reasonGiven || act.isPending || (!draft.enabled && !draft.approved)}
              onChange={event =>
                run({
                  action: 'enable',
                  moduleId: draft.moduleId,
                  contentSeq: draft.contentSeq,
                  reason,
                  enabled: event.target.checked,
                })
              }
              slotProps={{ input: { 'aria-label': `Switch ${draft.title} on` } }}
              data-testid="tutorial-draft-enable"
              endDecorator={draft.enabled ? 'On' : 'Off'}
            />
            <Button size="sm" variant="outlined" component="label" data-testid="tutorial-draft-sheet-upload">
              Upload sheet (.csv)
              <input
                hidden
                type="file"
                accept=".csv,text/csv"
                data-testid="tutorial-draft-sheet-input"
                disabled={!reasonGiven}
                onChange={event => void uploadSheet(event.target.files?.[0])}
              />
            </Button>
            <Button size="sm" variant="outlined" data-testid="tutorial-draft-export" onClick={exportDraft}>
              Export
            </Button>
            <Button
              size="sm"
              variant="outlined"
              color="danger"
              data-testid="tutorial-draft-delete"
              disabled={!reasonGiven || act.isPending}
              onClick={() => run({ action: 'delete', moduleId: draft.moduleId, reason })}
            >
              Delete
            </Button>
          </Stack>

          <Stack gap={1}>
            <FormControl>
              <FormLabel>Title</FormLabel>
              <Input
                size="sm"
                value={buffers.title}
                onChange={event => set({ title: event.target.value })}
                slotProps={{ input: { 'data-testid': 'tutorial-draft-title' } }}
              />
            </FormControl>
            <FormControl>
              <FormLabel>Pitch</FormLabel>
              <Input
                size="sm"
                value={buffers.pitch}
                onChange={event => set({ pitch: event.target.value })}
                slotProps={{ input: { 'data-testid': 'tutorial-draft-pitch' } }}
              />
            </FormControl>
            {showCanvasNode && (
              <FormControl>
                <FormLabel>Canvas node the setup and race work on</FormLabel>
                <Select
                  size="sm"
                  value={buffers.canvasNodeId || null}
                  onChange={(_, value) => set({ canvasNodeId: value ?? '' })}
                  data-testid="tutorial-draft-canvas-node"
                >
                  {nodes.map(node => (
                    <Option key={node.id} value={node.id}>
                      {node.label || node.id}
                    </Option>
                  ))}
                </Select>
              </FormControl>
            )}
            {asksVisibility && (
              <FormControl>
                <FormLabel>Who may run it</FormLabel>
                <VisibilityControl
                  value={buffers.visibility}
                  onChange={visibility => set({ visibility })}
                  testid="tutorial-draft-visibility"
                />
              </FormControl>
            )}
            <FormControl>
              <FormLabel>Turn that attaches the sheet</FormLabel>
              <Select
                size="sm"
                value={buffers.attachTurn ?? -1}
                onChange={(_, value) => set({ attachTurn: value ?? -1 })}
                data-testid="tutorial-draft-attach-turn"
              >
                <Option value={-1}>None</Option>
                {draft.content.transcript.map((_, i) => (
                  <Option key={i} value={i}>
                    Turn {i}
                  </Option>
                ))}
              </Select>
            </FormControl>
            {draft.content.transcript.map((turn, i) => (
              <FormControl key={i}>
                <FormLabel>
                  Turn {i}: {turn.prompt.slice(0, 120)}
                </FormLabel>
                <Textarea
                  size="sm"
                  minRows={2}
                  maxRows={8}
                  value={buffers.replies[i] ?? ''}
                  onChange={event => set({ replies: { ...buffers.replies, [i]: event.target.value } })}
                  slotProps={{ textarea: { 'data-testid': `tutorial-draft-reply-${i}` } }}
                />
              </FormControl>
            ))}
            <FormControl>
              <FormLabel>Finale title and body</FormLabel>
              <Input
                size="sm"
                value={buffers.finaleTitle}
                onChange={event => set({ finaleTitle: event.target.value })}
                slotProps={{ input: { 'data-testid': 'tutorial-draft-finale-title' } }}
              />
              <Textarea
                size="sm"
                minRows={2}
                value={buffers.finaleBody}
                onChange={event => set({ finaleBody: event.target.value })}
                slotProps={{ textarea: { 'data-testid': 'tutorial-draft-finale-body' } }}
                sx={{ mt: 0.5 }}
              />
            </FormControl>
            <FormControl>
              <FormLabel>Steps (JSON; types: {drafts.data?.choices.stepTypes.join(', ')})</FormLabel>
              <Textarea
                size="sm"
                minRows={6}
                maxRows={24}
                value={buffers.steps}
                onChange={event => set({ steps: event.target.value })}
                slotProps={{ textarea: { 'data-testid': 'tutorial-draft-steps', spellCheck: false } }}
                sx={{ fontFamily: 'code' }}
              />
            </FormControl>
            <Box>
              <Button
                size="sm"
                data-testid="tutorial-draft-save"
                disabled={!reasonGiven || act.isPending}
                onClick={save}
              >
                Save (clears approval)
              </Button>
            </Box>
          </Stack>
        </Stack>
      )}
    </Card>
  );
};

export default TutorialDraftsCard;
