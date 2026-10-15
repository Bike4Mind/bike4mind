import { useCallback, useEffect, useState } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import CircularProgress from '@mui/joy/CircularProgress';
import Link from '@mui/joy/Link';
import Radio from '@mui/joy/Radio';
import RadioGroup from '@mui/joy/RadioGroup';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type {
  ChatArtifactPublish,
  ChatArtifactPublishProgress,
  ChatArtifactPublishVisibility,
  ChatArtifactView,
} from '@shared/chat';

/**
 * What each rung MEANS, in the words someone deciding needs rather than the server's token.
 *
 * Spelled out on the control itself, not behind a tooltip or a docs link: this is the one
 * choice on the card that determines who else can read the content, and a label the user has
 * to go and look up is a label they will not look up.
 */
const VISIBILITY: ReadonlyArray<{
  value: ChatArtifactPublishVisibility;
  label: string;
  detail: string;
}> = [
  { value: 'private', label: 'Only me', detail: 'Published to a link that nobody else can open.' },
  {
    value: 'organization',
    label: 'People in my organization',
    detail: 'Anyone signed in to your organization can open the link.',
  },
  { value: 'public', label: 'Anyone on the internet', detail: 'No sign-in needed. Anyone with the link can read it.' },
];

const STEP_LABEL: Record<Exclude<ChatArtifactPublishProgress['step'], 'done'>, string> = {
  requesting: 'Preparing...',
  uploading: 'Uploading...',
  finalizing: 'Publishing...',
};

/** What a settled publish should say, and how loudly. */
function outcomeTone(status: ChatArtifactPublish['status']): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'published') return 'success';
  if (status === 'rejected') return 'danger';
  if (status === 'unknown') return 'warning';
  return 'neutral';
}

function PublishedLink({ state }: { state: ChatArtifactPublish }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    if (!state.url) return;
    void navigator.clipboard.writeText(state.url).then(
      () => setCopied(true),
      () => setCopied(false)
    );
  };

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const reach = VISIBILITY.find(entry => entry.value === state.visibility);

  return (
    <Stack spacing={0.75}>
      <Stack direction="row" spacing={1} alignItems="center">
        <Typography level="body-xs" fontWeight="lg">
          Published
        </Typography>
        {reach && (
          <Chip
            size="sm"
            variant="soft"
            color={state.visibility === 'public' ? 'warning' : 'neutral'}
            data-testid="artifact-publish-visibility"
          >
            {reach.label}
          </Chip>
        )}
      </Stack>
      {state.url && (
        <>
          <Link
            level="body-xs"
            href={state.url}
            target="_blank"
            rel="noreferrer"
            sx={{ wordBreak: 'break-all' }}
            data-testid="artifact-publish-url"
          >
            {state.url}
          </Link>
          <Box>
            <Button size="sm" variant="soft" color="neutral" onClick={copy} data-testid="artifact-publish-copy-btn">
              {copied ? 'Copied' : 'Copy link'}
            </Button>
          </Box>
        </>
      )}
    </Stack>
  );
}

/**
 * Every reason the bundle was refused, one line each.
 *
 * Listed rather than summarized: `validateBundle` answers a 422 with structured violations
 * precisely so a publisher can tell what to change, and folding them into "publish failed"
 * throws away the only part of the response that is actionable.
 */
function Violations({ state }: { state: ChatArtifactPublish }) {
  if (!state.violations?.length) return null;

  return (
    <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2.5 }} data-testid="artifact-publish-violations">
      {state.violations.map((violation, index) => (
        <Typography
          component="li"
          level="body-xs"
          key={`${violation.type}-${index}`}
          data-testid="artifact-publish-violation"
        >
          {violation.message}
          {violation.file && (
            <Typography textColor="text.tertiary">
              {' '}
              ({violation.file}
              {typeof violation.line === 'number' ? `:${violation.line}` : ''})
            </Typography>
          )}
        </Typography>
      ))}
    </Box>
  );
}

function Outcome({ state }: { state: ChatArtifactPublish }) {
  if (state.status === 'published') return <PublishedLink state={state} />;

  return (
    <Alert
      size="sm"
      variant="soft"
      color={outcomeTone(state.status)}
      sx={{ alignItems: 'flex-start' }}
      data-testid={`artifact-publish-${state.status}`}
    >
      <Box>
        <Typography level="body-xs">{state.reason ?? 'This artifact was not published.'}</Typography>
        <Violations state={state} />
      </Box>
    </Alert>
  );
}

/**
 * Publishing one artifact: the choice, the confirmation, and where it ended up.
 *
 * Three properties this has to keep, in order of how badly they would be missed:
 *
 *  - Nothing publishes without a click. The form is inert until the user opens it and presses
 *    the button; there is no publish on mount, on artifact creation, or on a reply finishing.
 *    A model that writes "publish this" has written text, and text is all it has done - no tool
 *    reaches window.b4m.chat.publishArtifact and the renderer calls it from this handler only.
 *  - The reach is on screen before the button is, in plain words, and the public rung is marked
 *    as the one it is rather than sitting as a third equal option.
 *  - A publish that did not clearly succeed never reads as one. The outcome is whatever main
 *    reported, including 'unknown' when the server never confirmed, because guessing in either
 *    direction is a claim about who can see the content.
 */
export function ArtifactPublishControl({ artifact }: { artifact: ChatArtifactView }) {
  const [open, setOpen] = useState(false);
  const [visibility, setVisibility] = useState<ChatArtifactPublishVisibility>('private');
  const [step, setStep] = useState<ChatArtifactPublishProgress['step'] | null>(null);
  // `artifact.publish` is the state a transcript card arrives with; this holds whatever this
  // control has since learned, from a publish or from the lazy read below.
  const [state, setState] = useState<ChatArtifactPublish | null>(artifact.publish ?? null);
  const [checked, setChecked] = useState(!!artifact.publish);

  // One query, when the user opens the form - never on mount. A library of hundreds of rows
  // would otherwise be hundreds of requests to draw a list nobody has looked at yet.
  useEffect(() => {
    if (!open || checked) return;
    setChecked(true);
    void window.b4m.chat.readArtifactPublishState(artifact.id).then(
      existing => existing && setState(existing),
      () => undefined
    );
  }, [open, checked, artifact.id]);

  // Subscribed only while the form is open, which is also the only state a publish can be
  // started from. A transcript holds a card per artifact and the channel is broadcast to every
  // window, so a listener per mounted card would be hundreds of listeners for one publish that
  // at most one of them is running.
  useEffect(() => {
    if (!open) return;
    return window.b4m.chat.onArtifactPublishProgress((progress: ChatArtifactPublishProgress) => {
      if (progress.artifactId !== artifact.id) return;
      setStep(progress.step === 'done' ? null : progress.step);
      if (progress.result) setState(progress.result);
    });
  }, [open, artifact.id]);

  const publish = useCallback(() => {
    setStep('requesting');
    setState(null);
    void window.b4m.chat
      .publishArtifact({
        artifactId: artifact.id,
        type: artifact.type,
        title: artifact.title,
        content: artifact.content,
        visibility,
      })
      .then(
        result => setState(result),
        () =>
          setState({
            status: 'unknown',
            reason: 'The app lost track of this publish, so it may or may not be reachable.',
          })
      )
      .finally(() => setStep(null));
  }, [artifact.id, artifact.type, artifact.title, artifact.content, visibility]);

  const busy = step !== null;
  const isPublic = visibility === 'public';

  if (!open) {
    return (
      <Stack direction="row" spacing={1} alignItems="center">
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          onClick={() => setOpen(true)}
          data-testid="artifact-publish-open-btn"
        >
          Share...
        </Button>
        {state?.status === 'published' && (
          <Typography level="body-xs" textColor="text.tertiary">
            Already published
          </Typography>
        )}
      </Stack>
    );
  }

  return (
    <Sheet variant="soft" sx={{ borderRadius: 'sm', p: 1.25, mt: 0.5 }} data-testid="artifact-publish-panel">
      <Stack spacing={1}>
        <Typography level="body-xs" fontWeight="lg">
          Who should be able to open this?
        </Typography>

        <RadioGroup
          value={visibility}
          onChange={event => setVisibility(event.target.value as ChatArtifactPublishVisibility)}
          data-testid="artifact-publish-visibility-group"
        >
          <Stack spacing={0.75}>
            {VISIBILITY.map(entry => (
              <Radio
                key={entry.value}
                value={entry.value}
                disabled={busy}
                size="sm"
                color={entry.value === 'public' ? 'warning' : 'neutral'}
                data-testid={`artifact-publish-visibility-${entry.value}`}
                label={
                  <Box>
                    <Typography level="body-xs" fontWeight="lg">
                      {entry.label}
                    </Typography>
                    <Typography level="body-xs" textColor="text.tertiary">
                      {entry.detail}
                    </Typography>
                  </Box>
                }
              />
            ))}
          </Stack>
        </RadioGroup>

        {/* Said again, next to the button, because the radio may have scrolled out of view by
            the time the user reaches for it - and "public" is the one choice that cannot be
            taken back from whoever already opened the link. */}
        {isPublic && (
          <Alert size="sm" variant="soft" color="warning" data-testid="artifact-publish-public-warning">
            <Typography level="body-xs">This will be readable by anyone on the internet who has the link.</Typography>
          </Alert>
        )}

        <Stack direction="row" spacing={1} alignItems="center">
          <Button
            size="sm"
            variant="solid"
            color={isPublic ? 'warning' : 'primary'}
            disabled={busy}
            onClick={publish}
            data-testid="artifact-publish-confirm-btn"
          >
            {isPublic ? 'Publish publicly' : 'Publish'}
          </Button>
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            disabled={busy}
            onClick={() => setOpen(false)}
            data-testid="artifact-publish-close-btn"
          >
            Cancel
          </Button>
          {busy && step && step !== 'done' && (
            <Stack direction="row" spacing={0.75} alignItems="center" data-testid="artifact-publish-progress">
              <CircularProgress size="sm" sx={{ '--CircularProgress-size': '14px' }} />
              <Typography level="body-xs" textColor="text.tertiary">
                {STEP_LABEL[step]}
              </Typography>
            </Stack>
          )}
        </Stack>

        {state && !busy && <Outcome state={state} />}
      </Stack>
    </Sheet>
  );
}
