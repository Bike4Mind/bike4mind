import React, { useEffect, useMemo, useState } from 'react';
import {
  Modal,
  ModalDialog,
  ModalClose,
  Typography,
  Box,
  Input,
  IconButton,
  Tooltip,
  Button,
  RadioGroup,
  Radio,
  FormControl,
  FormLabel,
  Switch,
} from '@mui/joy';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import PublicIcon from '@mui/icons-material/Public';
import LockIcon from '@mui/icons-material/Lock';
import GroupIcon from '@mui/icons-material/Group';
import LinkIcon from '@mui/icons-material/Link';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import type { CommentPolicy, PublishResult, PublishVisibility } from '@bike4mind/common';
import { ShareActions } from './ShareActions';
import {
  toShareUrl,
  toShareTokenUrl,
  createOrGetShareToken,
  regenerateShareToken,
  revokeShareToken,
  updatePublishedVisibility,
  updatePublishedCommentPolicy,
  type PublishMode,
  type ArtifactPublishOpts,
} from '@client/app/utils/publishApi';

export interface PublishShareModalProps {
  open: boolean;
  onClose: () => void;
  /**
   * Performs the publish with the chosen visibility (and update-vs-new mode + slug to
   * reuse when a prior publication is found). Called ONLY when the user confirms - so
   * opening/closing the dialog never publishes anything.
   */
  publish: ((visibility: PublishVisibility, opts?: ArtifactPublishOpts) => Promise<PublishResult>) | null;
  /** Title used for the share text. */
  title: string;
  /** Optional markdown body, enabling the "Copy Markdown" action. */
  markdown?: string;
  /** Pre-selected visibility before the user confirms (default 'public'). */
  defaultVisibility?: PublishVisibility;
  /**
   * Optional async lookup run when the dialog opens to detect a prior publication of this
   * artifact. When it resolves to one, the dialog offers "update existing publication"
   * (lands a new version) vs "publish as new" (a separate page). Runs only after
   * open, so it never publishes anything.
   */
  resolveExisting?: () => Promise<{
    title: string;
    versionsCount?: number;
    slug: string;
    // Current exposure of the prior publication. Carried into an "update" so the default
    // one-click re-publish can't silently widen visibility or re-enable comments.
    visibility: PublishVisibility;
    commentPolicy?: CommentPolicy;
  } | null>;
  /**
   * When set, offers a "Team" (organization) visibility choice, publishing an org-scoped
   * page visible to org members. Supplied only when the caller is in an org ("Team") account
   * context - the publish callback maps org visibility to an org-tier page. Omit for personal
   * scope (only Public/Private are offered).
   */
  orgOption?: { label: string; hint: string };
}

type VisibilityOption = { value: PublishVisibility; label: string; hint: string; icon: React.ReactNode };

const PUBLIC_OPTION: VisibilityOption = {
  value: 'public',
  label: 'Public',
  hint: 'Anyone with the link',
  icon: <PublicIcon />,
};
const PRIVATE_OPTION: VisibilityOption = { value: 'private', label: 'Private', hint: 'Only you', icon: <LockIcon /> };

/** Amber accent for the currently-selected visibility - draws the eye to the
 *  active choice (and signals exposure when Public is selected). */
const AMBER = '#f59e0b';

function errorMessage(err: unknown): string {
  if (isAxiosError(err)) return (err.response?.data as { error?: string })?.error || err.message || 'Failed to publish';
  return err instanceof Error ? err.message : 'Failed to publish';
}

/**
 * Consent-first publish-and-share dialog. Phase 1 ("choose"): pick visibility and
 * confirm - nothing is published until the user clicks "Create share link", so
 * opening/closing exposes nothing. Phase 2 ("shared"): show the URL + social bar,
 * with the same visibility control now updating the live item.
 */
export function PublishShareModal({
  open,
  onClose,
  publish,
  title,
  markdown,
  defaultVisibility = 'public',
  resolveExisting,
  orgOption,
}: PublishShareModalProps) {
  const [visibility, setVisibility] = useState<PublishVisibility>(defaultVisibility);
  const [commentsOn, setCommentsOn] = useState(true);
  const [result, setResult] = useState<PublishResult | null>(null);
  const [busy, setBusy] = useState(false);
  // A prior publication of this artifact, resolved asynchronously after the dialog opens.
  // Its presence reveals the "update existing vs publish as new" choice. We keep the
  // prior commentPolicy so an update can RE-ASSERT it exactly rather than collapsing the binary
  // toggle back to 'open' - see handleCreate.
  const [existing, setExisting] = useState<{
    title: string;
    versionsCount: number;
    slug: string;
    commentPolicy?: CommentPolicy;
  } | null>(null);
  const [mode, setMode] = useState<PublishMode>('new');
  // The opt-in no-sign-in (`/a/<token>`) share link, minted lazily only when the owner asks.
  const [shareToken, setShareToken] = useState<string | null>(null);
  const [shareBusy, setShareBusy] = useState(false);

  // Reset to the choose phase each time the dialog is opened fresh.
  useEffect(() => {
    if (open) {
      setResult(null);
      setVisibility(defaultVisibility);
      setCommentsOn(true);
      setBusy(false);
      setExisting(null);
      setMode('new');
      setShareToken(null);
      setShareBusy(false);
    }
  }, [open, defaultVisibility]);

  // Detect a prior publication once the dialog is open. Default to "update" when found so
  // re-publishing lands a new version (the discoverable path); guard against a resolution
  // landing after the dialog closed.
  useEffect(() => {
    if (!open || !resolveExisting) return;
    let active = true;
    void resolveExisting()
      .then(found => {
        if (!active || !found) return;
        // `|| 1` (not `?? 1`): legacy rows report versionsCount 0 but already have
        // one served version, so treat 0 like undefined - "at least 1".
        setExisting({
          title: found.title,
          versionsCount: found.versionsCount || 1,
          slug: found.slug,
          commentPolicy: found.commentPolicy,
        });
        setMode('update');
        // Carry the existing publication's exposure into the (now default) "update" action.
        // finalize $sets visibility/commentPolicy unconditionally from what we publish, so NOT
        // seeding these would silently widen a private page to public - and re-enable comments
        // the owner had turned off - on a plain "add a new version".
        setVisibility(found.visibility);
        setCommentsOn(found.commentPolicy === 'open' || found.commentPolicy === 'restricted');
      })
      .catch(() => {
        /* lookup failure -> no choice shown; publishes as new */
      });
    return () => {
      active = false;
    };
  }, [open, resolveExisting]);

  const phase: 'choose' | 'shared' = result ? 'shared' : 'choose';
  const url = result ? toShareUrl(result) : '';
  const isPublic = visibility === 'public';

  // Visibility choices, ordered by openness. The Team (org) entry appears only when the caller
  // supplied `orgOption` (an org account context).
  //
  // In the SHARED phase we can only PATCH the existing record's `visibility` - we cannot migrate
  // its scope tier - so the offered set must be valid for the published record's tier:
  //   • user-tier page  -> Public/Private only. Offering Team here would PATCH visibility to
  //     'organization' on a user-scoped record, whose scopeId is the user id, so the serve gate
  //     would 403 every org member (moving to org scope requires re-publishing, not a PATCH).
  //   • org-tier page   -> Public/Team only. 'private' isn't a valid override for org tier
  //     (SCOPE_POLICY), so the server would reject it - don't offer a dead-end.
  // In the CHOOSE phase the publish callback maps a Team pick to a real org-tier page, so the
  // full set is safe.
  const visibilityOptions = useMemo<VisibilityOption[]>(() => {
    const orgEntry: VisibilityOption | null = orgOption
      ? { value: 'organization', ...orgOption, icon: <GroupIcon /> }
      : null;
    if (result) {
      return result.tier === 'organization'
        ? orgEntry
          ? [PUBLIC_OPTION, orgEntry]
          : [PUBLIC_OPTION]
        : [PUBLIC_OPTION, PRIVATE_OPTION];
    }
    return orgEntry ? [PUBLIC_OPTION, orgEntry, PRIVATE_OPTION] : [PUBLIC_OPTION, PRIVATE_OPTION];
  }, [orgOption, result]);

  // Phase 1 -> publish with the chosen visibility.
  const handleCreate = async () => {
    if (!publish) return;
    setBusy(true);
    const id = toast.loading(mode === 'update' ? 'Publishing new version…' : 'Creating share link…');
    try {
      const r = await publish(visibility, { mode, existingSlug: existing?.slug });
      // The publish callback creates the item with the server-default comment policy
      // ('none'); if the user left comments enabled, turn them on. Re-assert the PRESERVED
      // policy, not a blanket 'open': the binary toggle can't express 'restricted', so
      // collapsing comments-on to 'open' on an update would silently WIDEN a policy the
      // owner had constrained. A fresh enable (prior was 'none'/new, or a reply/fabfile with
      // no prior publication) still opens.
      if (commentsOn) {
        const nextPolicy: CommentPolicy = existing?.commentPolicy === 'restricted' ? 'restricted' : 'open';
        await updatePublishedCommentPolicy(r.publicId, nextPolicy).catch(() => {
          toast.warning('Published, but enabling comments failed — you can toggle them below.');
        });
      }
      setResult(r);
      toast.success('Share link ready', { id });
    } catch (err) {
      toast.error(errorMessage(err), { id });
    } finally {
      setBusy(false);
    }
  };

  // Toggle comments. Live-PATCH once published; otherwise just stage the choice.
  const onToggleComments = async (next: boolean) => {
    if (busy) return;
    if (phase !== 'shared' || !result) {
      setCommentsOn(next);
      return;
    }
    const prev = commentsOn;
    setCommentsOn(next);
    setBusy(true);
    try {
      await updatePublishedCommentPolicy(result.publicId, next ? 'open' : 'none');
      toast.success(next ? 'Comments enabled' : 'Comments turned off');
    } catch {
      setCommentsOn(prev);
      toast.error('Failed to update comments');
    } finally {
      setBusy(false);
    }
  };

  // Phase 2 -> change visibility of the already-published item (live PATCH).
  const changeVisibilityLive = async (next: PublishVisibility) => {
    if (!result || next === visibility) return;
    const prev = visibility;
    setVisibility(next);
    setBusy(true);
    try {
      await updatePublishedVisibility(result.publicId, next);
      toast.success(next === 'public' ? 'Now public — anyone with the link can view' : `Visibility set to ${next}`);
    } catch {
      setVisibility(prev);
      toast.error('Failed to update visibility');
    } finally {
      setBusy(false);
    }
  };

  const onPick = (next: PublishVisibility) => {
    if (busy) return;
    if (phase === 'shared') void changeVisibilityLive(next);
    else setVisibility(next);
  };

  // No-sign-in link (`/a/<token>`): mint on demand, rotate (revokes old links), or revoke.
  const runShareToken = async (action: () => Promise<string | null>, successMsg: string): Promise<void> => {
    if (!result || shareBusy) return;
    setShareBusy(true);
    try {
      setShareToken(await action());
      toast.success(successMsg);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setShareBusy(false);
    }
  };
  const onCreateShareToken = () =>
    runShareToken(async () => (await createOrGetShareToken(result!.publicId)).shareToken, 'No-sign-in link created');
  const onRegenerateShareToken = () =>
    runShareToken(
      async () => (await regenerateShareToken(result!.publicId)).shareToken,
      'Link regenerated — the old link no longer works'
    );
  const onRevokeShareToken = () =>
    runShareToken(async () => {
      await revokeShareToken(result!.publicId);
      return null;
    }, 'No-sign-in link revoked');

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Link copied to clipboard!');
    } catch {
      toast.error("Couldn't copy — select the URL manually");
    }
  };

  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog sx={{ maxWidth: 520, width: '100%' }} data-testid="publish-share-modal">
        <ModalClose />
        <Typography level="title-lg" sx={{ mb: 0.5 }}>
          {phase === 'shared' ? 'Shared & ready' : 'Share'}
        </Typography>
        <Typography level="body-sm" sx={{ mb: 2, opacity: 0.8 }}>
          {phase === 'shared'
            ? 'Send the link, or change who can see it below.'
            : 'Choose who can see this, then create the link. Nothing is published until you do.'}
        </Typography>

        {phase === 'choose' && existing && (
          <FormControl sx={{ mb: 2 }}>
            <FormLabel>This artifact is already published</FormLabel>
            <RadioGroup
              value={mode}
              onChange={e => setMode(e.target.value as PublishMode)}
              data-testid="publish-share-mode"
              sx={{ gap: 1 }}
            >
              <Radio
                value="update"
                disabled={busy}
                data-testid="publish-share-mode-update"
                label={`Update “${existing.title}” — adds a new version`}
              />
              <Radio
                value="new"
                disabled={busy}
                data-testid="publish-share-mode-new"
                label="Publish as new — a separate page"
              />
            </RadioGroup>
            {mode === 'update' && (
              <Typography level="body-xs" sx={{ mt: 0.75, opacity: 0.75 }}>
                {existing.versionsCount >= 2
                  ? `Currently ${existing.versionsCount} versions — your update becomes the newest, switchable on the published page.`
                  : 'Re-publishing adds a 2nd version and turns on the version switcher on the published page.'}
              </Typography>
            )}
          </FormControl>
        )}

        <FormControl sx={{ mb: 2 }}>
          <FormLabel>Visibility</FormLabel>
          <RadioGroup
            value={visibility}
            onChange={e => onPick(e.target.value as PublishVisibility)}
            data-testid="publish-share-visibility"
            sx={{ gap: 1 }}
          >
            {visibilityOptions.map(o => {
              const selected = visibility === o.value;
              return (
                <Box
                  key={o.value}
                  onClick={() => onPick(o.value)}
                  data-testid={`publish-share-visibility-${o.value}`}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1.25,
                    p: 1,
                    borderRadius: 'sm',
                    border: '1px solid',
                    borderColor: selected ? AMBER : 'divider',
                    bgcolor: selected ? `${AMBER}1F` : 'transparent',
                    cursor: busy ? 'default' : 'pointer',
                    transition: 'border-color .15s, background-color .15s',
                  }}
                >
                  <Radio
                    value={o.value}
                    disabled={busy}
                    sx={{ ...(selected && { color: AMBER, '& svg': { color: AMBER } }) }}
                    slotProps={{ radio: selected ? { sx: { backgroundColor: AMBER, borderColor: AMBER } } : undefined }}
                  />
                  <Box
                    sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1, color: selected ? AMBER : 'inherit' }}
                  >
                    {o.icon}
                    <Box>
                      <Typography level="title-sm" sx={{ color: selected ? AMBER : 'inherit', lineHeight: 1.2 }}>
                        {o.label}
                      </Typography>
                      <Typography level="body-xs" sx={{ opacity: 0.75, color: selected ? AMBER : 'inherit' }}>
                        {o.hint}
                      </Typography>
                    </Box>
                  </Box>
                </Box>
              );
            })}
          </RadioGroup>
          {isPublic && (
            <Typography level="body-xs" sx={{ mt: 0.75, color: AMBER }}>
              ⚠ Public: anyone with the link will be able to view this.
            </Typography>
          )}
        </FormControl>

        <FormControl
          orientation="horizontal"
          sx={{ mb: 2, justifyContent: 'space-between', alignItems: 'center', gap: 1 }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <ChatBubbleOutlineIcon fontSize="small" />
            <Box>
              <FormLabel sx={{ mb: 0 }}>Allow comments</FormLabel>
              <Typography level="body-xs" sx={{ opacity: 0.75 }}>
                Viewers can leave feedback; you can AI-revise from it.
              </Typography>
            </Box>
          </Box>
          <Switch
            checked={commentsOn}
            disabled={busy}
            onChange={e => void onToggleComments(e.target.checked)}
            data-testid="publish-share-comments-toggle"
          />
        </FormControl>

        {phase === 'choose' ? (
          <Button
            onClick={() => void handleCreate()}
            loading={busy}
            startDecorator={<PublicIcon />}
            data-testid="publish-share-create"
          >
            {mode === 'update' ? 'Publish new version' : 'Create share link'}
          </Button>
        ) : (
          <>
            <Box sx={{ display: 'flex', gap: 1, mb: 2 }}>
              <Input
                value={url}
                readOnly
                slotProps={{ input: { 'data-testid': 'publish-share-url', onFocus: e => e.currentTarget.select() } }}
                sx={{ flex: 1, fontFamily: 'monospace', fontSize: '13px' }}
              />
              <Tooltip title="Copy link">
                <IconButton
                  variant="outlined"
                  color="neutral"
                  onClick={() => void copyToClipboard(url)}
                  data-testid="publish-share-copy"
                >
                  <ContentCopyIcon />
                </IconButton>
              </Tooltip>
            </Box>
            <ShareActions title={title} url={url} markdown={markdown} />

            <Box
              sx={{ mt: 2, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}
              data-testid="publish-share-token-section"
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                <LinkIcon fontSize="small" />
                <FormLabel sx={{ mb: 0 }}>No-sign-in link</FormLabel>
              </Box>
              <Typography level="body-xs" sx={{ opacity: 0.75, mb: 1 }}>
                A link anyone can open without an account. Regenerate to instantly revoke old links.
              </Typography>
              {shareToken ? (
                <>
                  <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
                    <Input
                      value={toShareTokenUrl(shareToken)}
                      readOnly
                      slotProps={{
                        input: { 'data-testid': 'publish-share-token-url', onFocus: e => e.currentTarget.select() },
                      }}
                      sx={{ flex: 1, fontFamily: 'monospace', fontSize: '13px' }}
                    />
                    <Tooltip title="Copy no-sign-in link">
                      <IconButton
                        variant="outlined"
                        color="neutral"
                        onClick={() => void copyToClipboard(toShareTokenUrl(shareToken))}
                        data-testid="publish-share-token-copy"
                      >
                        <ContentCopyIcon />
                      </IconButton>
                    </Tooltip>
                  </Box>
                  <Box sx={{ display: 'flex', gap: 1 }}>
                    <Button
                      size="sm"
                      variant="outlined"
                      color="neutral"
                      loading={shareBusy}
                      onClick={() => void onRegenerateShareToken()}
                      data-testid="publish-share-token-regenerate"
                    >
                      Regenerate
                    </Button>
                    <Button
                      size="sm"
                      variant="outlined"
                      color="danger"
                      loading={shareBusy}
                      onClick={() => void onRevokeShareToken()}
                      data-testid="publish-share-token-revoke"
                    >
                      Revoke
                    </Button>
                  </Box>
                  <Typography level="body-xs" sx={{ mt: 0.75, color: AMBER }}>
                    ⚠ Anyone with this link can view without signing in.
                  </Typography>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="outlined"
                  color="neutral"
                  loading={shareBusy}
                  startDecorator={<LinkIcon />}
                  onClick={() => void onCreateShareToken()}
                  data-testid="publish-share-token-create"
                >
                  Create no-sign-in link
                </Button>
              )}
            </Box>
          </>
        )}
      </ModalDialog>
    </Modal>
  );
}

export default PublishShareModal;
