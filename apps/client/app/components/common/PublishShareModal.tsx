import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  FormHelperText,
  Switch,
  Alert,
  Checkbox,
  type ColorPaletteProp,
} from '@mui/joy';
import { useTheme } from '@mui/joy/styles';
import PublicIcon from '@mui/icons-material/Public';
import LinkIcon from '@mui/icons-material/Link';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import TravelExploreIcon from '@mui/icons-material/TravelExplore';
import { isAxiosError } from 'axios';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { CommentPolicy, PublishResult, PublishVisibility } from '@bike4mind/common';
import { ELISION_PUBLISH_TITLE } from '@bike4mind/common';
import { registrableDomain } from '@bike4mind/utils/registrableDomain';
import { getValidationViolationsMessage } from '@client/app/utils/error';
import { ShareActions } from './ShareActions';
import { EmbedAllowlistEditor } from './EmbedAllowlistEditor';
import { ClearGateConfirmModal, StoredGateNote, STORED_GATE_CLEARED_MESSAGE } from './StoredGateClear';
import { getPublishAccess, LIGHT_WARNING_TEXT, PUBLISH_ACCESS_META, type PublishAccess } from './PublishAccessBadge';
import {
  toShareUrl,
  toShareTokenUrl,
  createOrGetShareToken,
  regenerateShareToken,
  revokeShareToken,
  updatePublishedVisibility,
  updatePublishedCommentPolicy,
  updatePublishedDiscoverable,
  updatePublishedAccessGate,
  getPublishedManageState,
  getShareTokenState,
  isRevokeOrphanGateRefusal,
  type PublishAccessGateInput,
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
    /** Whether the prior publication opted into search-engine indexing. */
    discoverable?: boolean;
  } | null>;
  /**
   * Optional lookup, run on open, for a source that has at most one publication (a chat reply).
   * When it resolves to one, the dialog opens straight onto that live page - its link and its
   * current visibility, gate and comment state - so a Private pick changes the link the owner
   * already handed out. Without it a reopened reply showed a blank "nothing is published" form.
   */
  resolvePublished?: () => Promise<PublishResult | null>;
  /**
   * When set, offers a "Team" (organization) visibility choice, publishing an org-scoped
   * page visible to org members. Supplied only when the caller is in an org ("Team") account
   * context - the publish callback maps org visibility to an org-tier page. Omit for personal
   * scope (only Public/Private are offered).
   */
  orgOption?: { label: string; hint: string };
  /**
   * Set when the content looks abbreviated/non-functional (see `detectElidedContent`). Shown
   * as a warning that must be acknowledged before the publish button enables. A published
   * link is the point of no return - it can reach a teammate or client before anyone
   * notices the artifact's controls are inert. Heuristic, hence acknowledge-and-proceed
   * rather than a hard block.
   */
  incompleteWarning?: string;
}

type VisibilityOption = { value: PublishVisibility; label: string; hint: string };

const PUBLIC_OPTION: VisibilityOption = {
  value: 'public',
  label: 'Anyone with the link',
  hint: 'Anyone you send the link to can view it',
};
// Non-public hints name private links, as the access badge does: the share-token section below offers
// one at these visibilities, and it opens for anyone it is sent to.
const PRIVATE_OPTION: VisibilityOption = {
  value: 'private',
  label: 'Private',
  hint: PUBLISH_ACCESS_META.private.description,
};
const TEAM_FALLBACK_OPTION: VisibilityOption = {
  value: 'organization',
  label: 'Team',
  hint: PUBLISH_ACCESS_META.organization.description,
};
/** Appended to a caller's Team hint ("Members of Acme"). Must stay in sync with the non-public
 *  descriptions in PUBLISH_ACCESS_META. */
const PRIVATE_LINK_REACH = ', and anyone you send a private link to';

/** Client-side mirror of the server's registrable-domain check (server is authoritative). */
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

type GateKind = 'none' | 'passphrase' | 'domain';

type GateOption = {
  value: GateKind;
  label: string;
  hint: string;
  /** The access state this choice produces on a public page, as the access badge names it. */
  access: PublishAccess;
};

const GATE_OPTIONS: GateOption[] = [
  {
    value: 'none',
    label: 'No passphrase needed',
    hint: 'Viewers just open the link',
    access: 'public',
  },
  {
    value: 'passphrase',
    label: 'Passphrase required',
    hint: 'Viewers enter a passphrase you share with them',
    access: 'passphrase',
  },
  {
    value: 'domain',
    label: 'Specific email domains',
    hint: 'Viewers sign in with a verified work email you allow',
    access: 'domain',
  },
];

type StoredGate = Exclude<GateKind, 'none'>;
type StoredAccess = { status: 'unknown' } | { status: 'known'; gate: StoredGate | null };

/** Who a private link (/a/<token>) opens for when a gate is stored. The server enforces the gate on
 *  those links at every visibility (checkShareGrant), so "without signing in" would be false. */
const GATED_LINK_WHO: Record<StoredGate, string> = {
  passphrase: 'who also has the passphrase',
  domain: 'who signs in with a verified email from an allowed domain',
};
/** GATED_LINK_WHO for a plural subject ("viewers who ..."). */
const GATED_VIEWERS_WHO: Record<StoredGate, string> = {
  passphrase: 'who also have the passphrase',
  domain: 'who sign in with a verified email from an allowed domain',
};

/** The sentence a shared non-public option's hint adds about its private links, or null when there is
 *  nothing to add. The hints carry no closing period, so the caller ends that sentence first. */
function privateLinkHintNote(storedGate: StoredGate | null | undefined): string | null {
  if (storedGate === null) return null;
  if (storedGate === undefined) return 'Private-link access depends on its access settings.';
  return `Private links open only for viewers ${GATED_VIEWERS_WHO[storedGate]}.`;
}

/** The PublishAccessBadge chip's text color, including its light-mode warning shade. */
const softTextColor = (color: ColorPaletteProp, mode: 'light' | 'dark') =>
  color === 'warning' && mode === 'light' ? LIGHT_WARNING_TEXT : `${color}.softColor`;

/** The PublishAccessBadge chip without its word: same icon and soft tones. The option title beside it
 *  already says who can open the page. */
function AccessIcon({ access, 'data-testid': testId }: { access: PublishAccess; 'data-testid': string }) {
  const mode = useTheme().palette.mode;
  const { color, Icon } = PUBLISH_ACCESS_META[access];
  return (
    <Box
      component="span"
      sx={theme => ({
        display: 'inline-flex',
        flexShrink: 0,
        p: 0.5,
        borderRadius: 'sm',
        bgcolor: `${color}.softBg`,
        color: softTextColor(color, mode),
        // Joy icons read their color and size from these, not from the inherited color.
        '--Icon-color': 'currentColor',
        '--Icon-fontSize': theme.vars.fontSize.xl,
      })}
      data-testid={testId}
      data-access={access}
    >
      <Icon />
    </Box>
  );
}

/** Exposure note in the access badge's treatment for `access` (icon and soft tones), so a line that
 *  says who can open a link reads the same here as that badge in Live Artifacts. */
function AccessNote({
  access,
  children,
  'data-testid': testId,
}: {
  access: PublishAccess;
  children: React.ReactNode;
  'data-testid': string;
}) {
  const mode = useTheme().palette.mode;
  const { color, Icon } = PUBLISH_ACCESS_META[access];
  return (
    <Typography
      level="body-xs"
      variant="soft"
      color={color}
      startDecorator={<Icon sx={{ fontSize: 14, mt: '1px' }} />}
      sx={{
        mt: 0.75,
        mx: 0,
        p: 0.75,
        borderRadius: 'sm',
        alignItems: 'flex-start',
        color: softTextColor(color, mode),
      }}
      data-testid={testId}
      data-access={access}
    >
      {children}
    </Typography>
  );
}

/** Parse the domains textarea; null when any entry is invalid. Mirrors the server:
 *  entries are validated as real registrable domains (rejecting bare suffixes like
 *  co.uk / github.io) but kept AS ENTERED - matching is exact-or-subdomain, so a
 *  subdomain entry is never widened to its parent. */
function parseDomains(text: string): string[] | null {
  const items = [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map(d => d.trim().toLowerCase())
        .filter(Boolean)
    ),
  ];
  if (items.length === 0 || items.length > 20) return null;
  if (!items.every(d => DOMAIN_RE.test(d))) return null;
  if (items.some(d => registrableDomain(d, { allowPrivateDomains: true }) === null)) return null;
  return items;
}

function errorMessage(err: unknown): string {
  const violations = getValidationViolationsMessage(err);
  if (violations) return violations;
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
  resolvePublished,
  orgOption,
  incompleteWarning,
}: PublishShareModalProps) {
  const [visibility, setVisibility] = useState<PublishVisibility>(defaultVisibility);
  const [commentsOn, setCommentsOn] = useState(true);
  // Search-engine opt-IN, off by default. Publishing publicly must never imply
  // "list this in Google" - that has to be a deliberate click.
  const [discoverableOn, setDiscoverableOn] = useState(false);
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
    discoverable?: boolean;
  } | null>(null);
  const [mode, setMode] = useState<PublishMode>('new');
  // The opt-in no-sign-in (`/a/<token>`) share link, minted lazily only when the owner asks.
  const [shareToken, setShareToken] = useState<string | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  // Access gate on top of Public (issue #383). `gateTouched` distinguishes "left at
  // defaults" from an explicit choice, so an update-publish never clobbers an existing
  // gate the user didn't interact with.
  const [gateKind, setGateKind] = useState<GateKind>('none');
  const [gatePassphrase, setGatePassphrase] = useState('');
  const [gateDomainsText, setGateDomainsText] = useState('');
  const [gateTouched, setGateTouched] = useState(false);
  // The gate live on the published item, seeded from the record. Drives whether the embed editor is
  // offered (embedding is open-public only) and what the private-link note promises.
  const [storedAccess, setStoredAccess] = useState<StoredAccess>({ status: 'unknown' });
  const storedGate = storedAccess.status === 'known' ? storedAccess.gate : undefined;
  // A read started before a successful local gate write must not replace that newer state.
  const gateRevision = useRef(0);
  const setStoredGate = useCallback((gate: StoredGate | null) => {
    gateRevision.current += 1;
    setStoredAccess({ status: 'known', gate });
  }, []);
  const queryClient = useQueryClient();
  const [confirmingClear, setConfirmingClear] = useState(false);
  const revokeButtonRef = useRef<HTMLButtonElement>(null);
  // Set by a successful clear: the Clear button is gone by then, so focus moves on to Revoke, the
  // action the owner was after.
  const focusRevokeAfterClear = useRef(false);
  // Explicit acknowledgement of `incompleteWarning`; gates the publish button.
  const [incompleteAck, setIncompleteAck] = useState(false);
  // `resolvePublished` is in flight: hold the create button so a click can't race the lookup.
  const [resolving, setResolving] = useState(false);
  // The dialog opened onto a publication that already existed (see `resolvePublished`).
  const [reopened, setReopened] = useState(false);

  // Reset to the choose phase each time the dialog is opened fresh.
  useEffect(() => {
    if (open) {
      setResult(null);
      setVisibility(defaultVisibility);
      setCommentsOn(true);
      setDiscoverableOn(false);
      setBusy(false);
      setExisting(null);
      setMode('new');
      setShareToken(null);
      setShareBusy(false);
      setGateKind('none');
      setGatePassphrase('');
      setGateDomainsText('');
      setGateTouched(false);
      gateRevision.current += 1;
      setStoredAccess({ status: 'unknown' });
      setConfirmingClear(false);
      setIncompleteAck(false);
      setReopened(false);
    }
  }, [open, defaultVisibility]);

  // Seed whether a gate is live once we have a published item (the embed editor
  // seeds its own origin list).
  useEffect(() => {
    if (!open || !result?.publicId) return;
    let active = true;
    const revision = gateRevision.current;
    void getPublishedManageState(result.publicId)
      .then(state => {
        if (!active || revision !== gateRevision.current) return;
        setStoredAccess({ status: 'known', gate: state.accessGate?.kind ?? null });
      })
      .catch(() => {
        if (!active || revision !== gateRevision.current) return;
        toast.warning('Could not refresh access settings. Check access before sharing.');
      });
    return () => {
      active = false;
    };
  }, [open, result?.publicId]);

  // Seed any live /a link from a past session (read-only, never mints) so a page that is
  // public now can still revoke a link made while it was private. A mint in flight wins.
  useEffect(() => {
    if (!open || !result?.publicId) return;
    let active = true;
    void getShareTokenState(result.publicId)
      .then(state => {
        if (active && state.shareToken) setShareToken(prev => prev ?? state.shareToken);
      })
      .catch(() => {
        /* best-effort seed; Create still surfaces an existing link idempotently */
      });
    return () => {
      active = false;
    };
  }, [open, result?.publicId]);

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
          discoverable: found.discoverable,
        });
        setMode('update');
        // Carry the existing publication's exposure into the (now default) "update" action.
        // finalize $sets visibility/commentPolicy unconditionally from what we publish, so NOT
        // seeding these would silently widen a private page to public - and re-enable comments
        // the owner had turned off - on a plain "add a new version".
        setVisibility(found.visibility);
        setCommentsOn(found.commentPolicy === 'open' || found.commentPolicy === 'restricted');
        // Unlike visibility/commentPolicy, finalize does NOT $set discoverable, so an
        // update can't widen it. Seeded anyway so the toggle shows the artifact's real
        // current state instead of a misleading "off".
        setDiscoverableOn(!!found.discoverable);
      })
      .catch(() => {
        /* lookup failure -> no choice shown; publishes as new */
      });
    return () => {
      active = false;
    };
  }, [open, resolveExisting]);

  // Reopen onto an existing publication. Its live state is read from the record itself (not the
  // lookup row) so the controls show what is actually being served, gate included.
  useEffect(() => {
    if (!open || !resolvePublished) return;
    let active = true;
    setResolving(true);
    void resolvePublished()
      .then(async found => {
        if (!active || !found) return;
        const [state, links] = await Promise.all([
          getPublishedManageState(found.publicId).catch(() => null),
          getShareTokenState(found.publicId).catch(() => null),
        ]);
        if (!active) return;
        const live = state?.visibility ?? found.visibility;
        setResult({ ...found, visibility: live });
        setVisibility(live);
        setReopened(true);
        if (state) {
          setCommentsOn(state.commentPolicy === 'open' || state.commentPolicy === 'restricted');
          setDiscoverableOn(state.discoverable);
          setGateKind(state.accessGate?.kind ?? 'none');
          setStoredGate(state.accessGate?.kind ?? null);
          if (state.accessGate?.kind === 'domain') setGateDomainsText(state.accessGate.allowedDomains.join(', '));
        }
        if (links?.shareToken) setShareToken(links.shareToken);
      })
      .catch(() => {
        /* lookup failure -> the plain publish form; the server still updates in place */
      })
      .finally(() => {
        if (active) setResolving(false);
      });
    return () => {
      active = false;
      // Closing mid-lookup must not leave the create button held for the next open, which may
      // come from a surface with no lookup at all (one hook instance serves many surfaces).
      setResolving(false);
    };
  }, [open, resolvePublished, setStoredGate]);

  const phase: 'choose' | 'shared' = result ? 'shared' : 'choose';
  const url = result ? toShareUrl(result) : '';
  const isPublic = visibility === 'public';

  // Visibility choices, ordered by openness. The Team (org) entry appears only when the caller
  // supplied `orgOption` (an org account context).
  //
  // In the SHARED phase we can only PATCH the existing record's `visibility` - we cannot migrate
  // its scope tier - so the offered set must be valid for the published record's tier:
  //   - user-tier page  -> Public/Private only. Offering Team here would PATCH visibility to
  //     'organization' on a user-scoped record, whose scopeId is the user id, so the serve gate
  //     would 403 every org member (moving to org scope requires re-publishing, not a PATCH).
  //   - org-tier page   -> Public/Team/Private. Private is valid at every tier (SCOPE_POLICY), so
  //     the owner can take a Team page back to owner-only without re-publishing it.
  // In the CHOOSE phase the publish callback maps a Team pick to a real org-tier page, so the
  // full set is safe.
  const visibilityOptions = useMemo<VisibilityOption[]>(() => {
    const orgEntry: VisibilityOption | null = orgOption
      ? { value: 'organization', label: orgOption.label, hint: `${orgOption.hint}${PRIVATE_LINK_REACH}` }
      : null;
    if (result) {
      // A reopened Team page keeps its Team choice even when the dialog was opened outside a team
      // context (no `orgOption`), so its current visibility is shown rather than leaving only Public.
      return result.tier === 'organization'
        ? [PUBLIC_OPTION, orgEntry ?? TEAM_FALLBACK_OPTION, PRIVATE_OPTION]
        : [PUBLIC_OPTION, PRIVATE_OPTION];
    }
    return orgEntry ? [PUBLIC_OPTION, orgEntry, PRIVATE_OPTION] : [PUBLIC_OPTION, PRIVATE_OPTION];
  }, [orgOption, result]);

  /** The staged gate as API input; 'invalid' blocks submission with a specific message. */
  const buildGateInput = (): PublishAccessGateInput | 'invalid' => {
    if (gateKind === 'none') return null;
    if (gateKind === 'passphrase') {
      if (gatePassphrase.length < 8) {
        toast.error('Passphrase must be at least 8 characters');
        return 'invalid';
      }
      return { kind: 'passphrase', passphrase: gatePassphrase };
    }
    const domains = parseDomains(gateDomainsText);
    if (!domains) {
      toast.error('Enter 1-20 valid domains (like acme.com), separated by commas');
      return 'invalid';
    }
    return { kind: 'domain', allowedDomains: domains };
  };

  // Phase 1 -> publish with the chosen visibility.
  const handleCreate = async () => {
    if (!publish) return;
    // Validate the staged gate BEFORE publishing so a typo'd passphrase doesn't
    // leave the page momentarily open-public.
    const stagedGate = isPublic && gateTouched ? buildGateInput() : null;
    if (stagedGate === 'invalid') return;
    setBusy(true);
    try {
      const r = await publish(visibility, { mode, existingSlug: existing?.slug });
      if (stagedGate) {
        await updatePublishedAccessGate(r.publicId, stagedGate).then(
          () => setStoredGate(stagedGate.kind),
          () => {
            toast.warning('Published, but protecting the link failed - set access below before sharing.');
          }
        );
      }
      // The publish callback creates the item with the server-default comment policy
      // ('none'); if the user left comments enabled, turn them on. Re-assert the PRESERVED
      // policy, not a blanket 'open': the binary toggle can't express 'restricted', so
      // collapsing comments-on to 'open' on an update would silently WIDEN a policy the
      // owner had constrained. A fresh enable (prior was 'none'/new, or a reply/fabfile with
      // no prior publication) still opens.
      if (commentsOn) {
        const nextPolicy: CommentPolicy = existing?.commentPolicy === 'restricted' ? 'restricted' : 'open';
        await updatePublishedCommentPolicy(r.publicId, nextPolicy).catch(() => {
          toast.warning('Published, but enabling comments failed - you can toggle them below.');
        });
      }
      // Search listing. `finalize` does not $set `discoverable` (unlike commentPolicy), so
      // a re-publish PRESERVES whatever was stored - which means the OFF direction has to
      // be written explicitly too, or a listed artifact can never be de-listed from this
      // dialog. Hence "on change", not "when on": `wanted` is what the user is asking for,
      // `existing?.discoverable` is what storage currently holds.
      //
      // The visibility/gate guard forces `wanted` to false rather than skipping the call:
      // staging the switch ON and then picking Private (or adding a gate) hides the
      // control, and persisting `true` there would arm a silent opt-in that fires the
      // moment someone widens the artifact back to public. A failed call leaves the
      // artifact at its stored value, and the server de-arms on any downgrade anyway.
      const wanted = discoverableOn && visibility === 'public' && gateKind === 'none';
      if (wanted !== !!existing?.discoverable) {
        await updatePublishedDiscoverable(r.publicId, wanted).catch(() => {
          toast.warning('Published, but the search-listing setting failed - you can toggle it below.');
        });
      }
      setResult(r);
    } catch (err) {
      toast.error(errorMessage(err));
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

  // Toggle search-engine listing. Live-PATCH once published; otherwise stage the choice.
  const onToggleDiscoverable = async (next: boolean) => {
    if (busy) return;
    if (phase !== 'shared' || !result) {
      setDiscoverableOn(next);
      return;
    }
    const prev = discoverableOn;
    setDiscoverableOn(next);
    setBusy(true);
    try {
      await updatePublishedDiscoverable(result.publicId, next);
      toast.success(
        next
          ? 'Search engines may now list this page'
          : 'Hidden from search engines - the link still works for anyone you send it to'
      );
    } catch {
      setDiscoverableOn(prev);
      toast.error('Failed to update search listing');
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
      toast.success(next === 'public' ? 'Now public - anyone with the link can view' : `Visibility set to ${next}`);
    } catch {
      setVisibility(prev);
      toast.error('Failed to update visibility');
    } finally {
      setBusy(false);
    }
  };

  const onPick = (next: PublishVisibility) => {
    if (busy) return;
    // Leaving public retires a staged search-listing choice rather than parking it on a
    // hidden control. Re-picking Public starts from off, so listing is always a choice
    // made against the exposure the artifact actually has.
    if (next !== 'public') setDiscoverableOn(false);
    if (phase === 'shared') void changeVisibilityLive(next);
    else setVisibility(next);
  };

  const readStoredGate = async () => {
    if (!result) return;
    const revision = gateRevision.current;
    try {
      const state = await getPublishedManageState(result.publicId);
      // A clear (or a reopen) that landed while this read was out is newer than what it returned.
      if (revision !== gateRevision.current) return;
      setStoredGate(state.accessGate?.kind ?? null);
    } catch {
      /* the refusal toast already said why; the seed read's own warning covers an unreadable record */
    }
  };

  // Clear a gate stored on a non-public page (the same PATCH and confirmation AccessGateEditor uses).
  // Its private links stop asking for it, so the last of them can be revoked.
  const clearStoredGate = async () => {
    if (!result || busy) return;
    setBusy(true);
    try {
      await updatePublishedAccessGate(result.publicId, null);
      setStoredGate(null);
      // Drop the draft that was seeded from the stored gate, so a later switch to Public starts open.
      setGateKind('none');
      setGatePassphrase('');
      setGateDomainsText('');
      setGateTouched(false);
      focusRevokeAfterClear.current = true;
      toast.success(STORED_GATE_CLEARED_MESSAGE);
      // Not opened from the Live Artifacts tab, so its row badge is refreshed by a refetch.
      void queryClient.invalidateQueries({ queryKey: ['published-artifacts', 'mine'] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
      setConfirmingClear(false);
    }
  };

  // Waits for the confirmation to close as well: its focus restore runs on unmount and would undo this.
  useEffect(() => {
    if (!focusRevokeAfterClear.current || confirmingClear) return;
    focusRevokeAfterClear.current = false;
    revokeButtonRef.current?.focus();
  }, [confirmingClear]);

  // No-sign-in link (`/a/<token>`): mint on demand, rotate (revokes old links), or revoke.
  const runShareToken = async (action: () => Promise<string | null>, successMsg: string): Promise<void> => {
    if (!result || shareBusy) return;
    setShareBusy(true);
    try {
      setShareToken(await action());
      toast.success(successMsg);
    } catch (err) {
      toast.error(errorMessage(err));
      // A refusal means a gate is stored whatever this dialog last read, so learn which kind and
      // offer its Clear action instead of leaving the owner with only the message.
      if (isRevokeOrphanGateRefusal(err)) void readStoredGate();
    } finally {
      setShareBusy(false);
    }
  };
  const onCreateShareToken = () =>
    runShareToken(async () => (await createOrGetShareToken(result!.publicId)).shareToken, 'Link created');
  const onRegenerateShareToken = () =>
    runShareToken(
      async () => (await regenerateShareToken(result!.publicId)).shareToken,
      'Link regenerated - the old link no longer works'
    );
  const onRevokeShareToken = () =>
    runShareToken(async () => {
      await revokeShareToken(result!.publicId);
      return null;
    }, 'Link turned off');

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Link copied to clipboard!');
    } catch {
      toast.error("Couldn't copy - select the URL manually");
    }
  };

  // Phase 2 -> apply the staged access gate to the live item (explicit button,
  // since passphrase/domains need typing before they're applyable).
  const applyGateLive = async () => {
    if (!result || busy) return;
    const gate = buildGateInput();
    if (gate === 'invalid') return;
    setBusy(true);
    try {
      await updatePublishedAccessGate(result.publicId, gate);
      setGateTouched(false);
      setGatePassphrase('');
      // Embedding is open-public only, so hide the embed editor the moment a gate
      // goes on (and reveal it again when the gate is cleared) - matches the server rule.
      setStoredGate(gate ? gate.kind : null);
      // The PATCH above left open-public, so the server de-armed `discoverable`. Mirror
      // that here rather than leaving the switch showing a value storage no longer holds.
      // Clearing a gate does NOT restore it - re-opting-in is an explicit choice.
      if (gate !== null) setDiscoverableOn(false);
      toast.success(
        gate === null
          ? 'Link is open to anyone again'
          : gate.kind === 'passphrase'
            ? 'Passphrase set - share it with your viewers'
            : 'Domain restriction applied'
      );
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const onPickGate = (next: GateKind) => {
    if (busy) return;
    // Deliberately does NOT touch discoverableOn. Unlike a visibility pick, a gate pick is
    // not persisted here - it waits for the explicit "Update access" button - so resetting
    // now would make the switch disagree with storage the moment the user picks `none`
    // again. applyGateLive does the reset, once the gate is actually live and the server
    // has de-armed the flag. While gated the switch is hidden anyway, and the staged-
    // publish path forces `wanted` to false independently.
    setGateKind(next);
    setGateTouched(true);
  };

  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog
        sx={{ maxWidth: 640, width: '100%', maxHeight: '90vh', overflow: 'auto' }}
        data-testid="publish-share-modal"
      >
        <ModalClose />
        <Typography level="title-lg" sx={{ mb: 0.5 }}>
          {phase === 'shared' ? (reopened ? 'Already shared' : 'Shared & ready') : 'Share'}
        </Typography>
        <Typography level="body-sm" textColor="text.secondary" sx={{ mb: 2 }} data-testid="publish-share-intro">
          {phase === 'shared'
            ? reopened
              ? 'This is already published. Change who can see it below - choosing Private stops this link from working for anyone else.'
              : 'Send the link, or change who can see it below.'
            : resolving
              ? 'Checking whether this is already shared...'
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
                label={`Update "${existing.title}" - adds a new version`}
              />
              <Radio
                value="new"
                disabled={busy}
                data-testid="publish-share-mode-new"
                label="Publish as new - a separate page"
              />
            </RadioGroup>
            {mode === 'update' && (
              <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.75 }}>
                {existing.versionsCount >= 2
                  ? `Currently ${existing.versionsCount} versions - your update becomes the newest, switchable on the published page.`
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
              const linkNote = phase === 'shared' && o.value !== 'public' ? privateLinkHintNote(storedGate) : null;
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
                    borderColor: selected ? 'primary.500' : 'divider',
                    bgcolor: selected ? 'primary.softBg' : 'transparent',
                    cursor: busy ? 'default' : 'pointer',
                    transition: 'border-color .15s, background-color .15s',
                  }}
                >
                  <Radio value={o.value} disabled={busy} />
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1 }}>
                    <AccessIcon
                      access={getPublishAccess({ visibility: o.value })}
                      data-testid={`publish-share-visibility-${o.value}-icon`}
                    />
                    <Box>
                      <Typography level="title-sm" sx={{ lineHeight: 1.2 }}>
                        {o.label}
                      </Typography>
                      <Typography
                        level="body-xs"
                        textColor="text.tertiary"
                        data-testid={`publish-share-visibility-${o.value}-hint`}
                      >
                        {linkNote ? `${o.hint}. ${linkNote}` : o.hint}
                      </Typography>
                    </Box>
                  </Box>
                </Box>
              );
            })}
          </RadioGroup>
          {/* Only assert open exposure when we KNOW it's open - i.e. a fresh
              publish the user hasn't gated. For an already-published artifact
              (update flow) the modal doesn't load the existing gate, so claiming
              "anyone with the link" would be a falsehood when a gate is set; the
              Access note below tells the truth instead. */}
          {isPublic &&
            gateKind === 'none' &&
            !existing &&
            !gateTouched &&
            (phase === 'choose' || storedGate === null) && (
              <AccessNote access="public" data-testid="publish-share-public-note">
                Anyone with the link can view this. It stays out of search engines unless you turn on &quot;Show in
                search results&quot; below.
              </AccessNote>
            )}
        </FormControl>

        {isPublic && (
          <FormControl sx={{ mb: 2 }}>
            <FormLabel>Access</FormLabel>
            {existing && !gateTouched && (
              // Update flow: the modal doesn't hydrate the existing gate, so this
              // control starts neutral. Reassure the owner their current setting
              // is untouched - handleCreate only sends a gate when gateTouched.
              <Typography
                level="body-xs"
                textColor="text.tertiary"
                sx={{ mb: 0.75 }}
                data-testid="publish-share-gate-preserved"
              >
                Any existing access setting is kept unless you change it here.
              </Typography>
            )}
            <RadioGroup
              value={gateKind}
              onChange={e => onPickGate(e.target.value as GateKind)}
              data-testid="publish-share-gate"
              sx={{ gap: 0.75 }}
            >
              {GATE_OPTIONS.map(o => {
                const selected = gateKind === o.value;
                return (
                  <Box
                    key={o.value}
                    onClick={() => onPickGate(o.value)}
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 1.25,
                      p: 1,
                      borderRadius: 'sm',
                      border: '1px solid',
                      borderColor: selected ? 'primary.500' : 'divider',
                      bgcolor: selected ? 'primary.softBg' : 'transparent',
                      cursor: busy ? 'default' : 'pointer',
                      transition: 'border-color .15s, background-color .15s',
                    }}
                  >
                    <Radio
                      value={o.value}
                      disabled={busy}
                      aria-label={o.label}
                      data-testid={`publish-share-gate-${o.value}`}
                    />
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1 }}>
                      <AccessIcon access={o.access} data-testid={`publish-share-gate-${o.value}-icon`} />
                      <Box>
                        <Typography level="title-sm" sx={{ lineHeight: 1.2 }}>
                          {o.label}
                        </Typography>
                        <Typography level="body-xs" textColor="text.tertiary">
                          {o.hint}
                        </Typography>
                      </Box>
                    </Box>
                  </Box>
                );
              })}
            </RadioGroup>
            {gateKind === 'passphrase' && (
              <Box sx={{ mt: 1 }}>
                <Input
                  type="password"
                  placeholder="Passphrase (8+ characters)"
                  value={gatePassphrase}
                  disabled={busy}
                  onChange={e => {
                    setGatePassphrase(e.target.value);
                    setGateTouched(true);
                  }}
                  slotProps={{ input: { 'data-testid': 'publish-share-gate-passphrase', autoComplete: 'off' } }}
                />
                <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
                  Share it however you like - anyone with the link and passphrase can view. It&apos;s stored only as a
                  hash; to change it later, set a new one.
                </Typography>
              </Box>
            )}
            {gateKind === 'domain' && (
              <Box sx={{ mt: 1 }}>
                <Input
                  placeholder="acme.com, partner.co"
                  value={gateDomainsText}
                  disabled={busy}
                  onChange={e => {
                    setGateDomainsText(e.target.value);
                    setGateTouched(true);
                  }}
                  slotProps={{ input: { 'data-testid': 'publish-share-gate-domains' } }}
                />
                <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
                  Viewers sign in (or sign up free) with a verified email on one of these domains.
                </Typography>
              </Box>
            )}
            {phase === 'shared' && gateTouched && (
              <Button
                size="sm"
                variant="outlined"
                onClick={() => void applyGateLive()}
                loading={busy}
                sx={{ mt: 1, alignSelf: 'flex-start' }}
                data-testid="publish-share-gate-apply"
              >
                Update access
              </Button>
            )}
          </FormControl>
        )}

        {/* Search listing. Offered ONLY for an ungated public item, matching the server
            rule (discoverable is ANDed with isOpenPublic on every request) - showing it
            for a private or gated item would promise something that never takes effect. */}
        {isPublic && gateKind === 'none' && (
          <FormControl
            orientation="horizontal"
            sx={{ mb: 2, justifyContent: 'space-between', alignItems: 'center', gap: 1 }}
          >
            {/* flex: 1 + minWidth: 0 here and flexShrink: 0 on the Switch stop the long helper from squeezing
                the switch on narrow screens. Keep in sync with DiscoverableToggle. */}
            <Box
              sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1, minWidth: 0 }}
              data-testid="publish-share-discoverable-text"
            >
              <TravelExploreIcon fontSize="small" />
              <Box>
                <FormLabel sx={{ mb: 0 }}>Show in search results</FormLabel>
                {/* FormHelperText, not Typography: only a FormHelperText child registers itself into
                    Joy's FormControl context and lands in the switch's aria-describedby, so a screen-
                    reader user actually hears this caveat instead of just the label. */}
                <FormHelperText sx={{ color: 'text.tertiary' }}>
                  Off by default. When off, the link still works for anyone you send it to - it just won&apos;t show up
                  in Google. Link previews in chat apps work either way.
                </FormHelperText>
              </Box>
            </Box>
            <Switch
              checked={discoverableOn}
              disabled={busy}
              sx={{ flexShrink: 0 }}
              data-testid="publish-share-discoverable-switch"
              onChange={e => void onToggleDiscoverable(e.target.checked)}
              // On the INPUT slot, not the root: Joy spreads bare props to the root span,
              // where a test can't read `.checked`.
              slotProps={{ input: { 'data-testid': 'publish-share-discoverable-toggle' } }}
            />
          </FormControl>
        )}

        <FormControl
          orientation="horizontal"
          sx={{ mb: 2, justifyContent: 'space-between', alignItems: 'center', gap: 1 }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <ChatBubbleOutlineIcon fontSize="small" />
            <Box>
              <FormLabel sx={{ mb: 0 }}>Allow comments</FormLabel>
              <Typography level="body-xs" textColor="text.tertiary">
                Viewers can leave feedback; you can AI-revise from it.
              </Typography>
            </Box>
          </Box>
          <Switch
            checked={commentsOn}
            disabled={busy}
            onChange={e => void onToggleComments(e.target.checked)}
            slotProps={{ input: { 'data-testid': 'publish-share-comments-toggle' } }}
          />
        </FormControl>

        {phase === 'choose' && incompleteWarning && (
          <Alert
            color="warning"
            variant="soft"
            sx={{ mb: 2, flexDirection: 'column', alignItems: 'flex-start', gap: 1 }}
            data-testid="publish-share-incomplete-warning"
          >
            <Typography level="title-sm">{ELISION_PUBLISH_TITLE}</Typography>
            <Typography level="body-sm">{incompleteWarning}</Typography>
            <Checkbox
              size="sm"
              checked={incompleteAck}
              onChange={e => setIncompleteAck(e.target.checked)}
              label="Publish anyway"
              slotProps={{ input: { 'data-testid': 'publish-share-incomplete-ack' } }}
            />
          </Alert>
        )}

        {phase === 'choose' ? (
          <Button
            onClick={() => void handleCreate()}
            loading={busy}
            disabled={resolving || (!!incompleteWarning && !incompleteAck)}
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
                  <LinkIcon />
                </IconButton>
              </Tooltip>
            </Box>
            <ShareActions title={title} url={url} markdown={markdown} />

            {/* The /a link only grants access the main link doesn't when the page isn't
                public; still shown once minted so it can be rotated or revoked. */}
            {(!isPublic || shareToken) && (
              <Box
                sx={{ mt: 2, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}
                data-testid="publish-share-token-section"
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                  <LinkIcon fontSize="small" />
                  <FormLabel sx={{ mb: 0 }} data-testid="publish-share-token-label">
                    {storedGate === null ? 'Private link anyone can open, no sign-in' : 'Private link'}
                  </FormLabel>
                </Box>
                <Typography
                  level="body-xs"
                  textColor="text.tertiary"
                  sx={{ mb: 1 }}
                  data-testid="publish-share-token-hint"
                >
                  {storedGate === undefined
                    ? 'Check the access settings before sharing this private link.'
                    : isPublic
                      ? `This page is public, so the link above already opens for anyone${storedGate ? ` ${GATED_LINK_WHO[storedGate]}` : ''}. Revoke this one if you no longer need it.`
                      : `The link above only opens for ${visibility === 'organization' ? 'your team' : 'you'}. This one opens for anyone you send it to${storedGate ? ` ${GATED_LINK_WHO[storedGate]}` : ', without signing in'}.`}
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
                      <Tooltip title="Copy private link">
                        <IconButton
                          variant="outlined"
                          color="neutral"
                          onClick={() => void copyToClipboard(toShareTokenUrl(shareToken))}
                          data-testid="publish-share-token-copy"
                        >
                          <LinkIcon />
                        </IconButton>
                      </Tooltip>
                    </Box>
                    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                      <Button
                        size="sm"
                        variant="outlined"
                        color="neutral"
                        loading={shareBusy}
                        onClick={() => void onRegenerateShareToken()}
                        data-testid="publish-share-token-regenerate"
                      >
                        Make a new link and stop the old ones
                      </Button>
                      <Button
                        ref={revokeButtonRef}
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
                    <AccessNote
                      access={storedGate === undefined ? 'private' : (storedGate ?? 'public')}
                      data-testid="publish-share-token-warning"
                    >
                      {storedGate === undefined
                        ? 'Access settings are unavailable. Check access before sharing this link.'
                        : storedGate
                          ? `Anyone with this link ${GATED_LINK_WHO[storedGate]} can view.`
                          : 'Anyone with this link can view without signing in.'}
                    </AccessNote>
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
                    {storedGate === null ? 'Create private link anyone can open' : 'Create private link'}
                  </Button>
                )}
                {/* On a non-public page the stored gate lives only on its private links, and the server
                    refuses to revoke the last one while it stands, so the way to clear it is offered here. */}
                {!isPublic && storedGate && (
                  <StoredGateNote
                    kind={storedGate}
                    visibility={visibility}
                    sx={{ mt: 1.5 }}
                    data-testid="publish-share-stored-gate"
                  >
                    {shareToken && (
                      <Typography level="body-xs" sx={{ mt: 0.5 }} data-testid="publish-share-stored-gate-revoke-note">
                        The private link can only be turned off once this gate is cleared.
                      </Typography>
                    )}
                    <Button
                      size="sm"
                      variant="outlined"
                      color="danger"
                      disabled={busy}
                      onClick={() => setConfirmingClear(true)}
                      sx={{ mt: 1 }}
                      data-testid="publish-share-gate-clear"
                    >
                      Clear gate
                    </Button>
                  </StoredGateNote>
                )}
                {storedGate && (
                  <ClearGateConfirmModal
                    open={confirmingClear}
                    onClose={() => setConfirmingClear(false)}
                    onConfirm={clearStoredGate}
                    loading={busy}
                    kind={storedGate}
                  />
                )}
              </Box>
            )}

            {result && isPublic && storedGate === null && (
              <Box sx={{ mt: 2, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
                <EmbedAllowlistEditor publicId={result.publicId} shareUrl={url} title={title} isOpenPublic />
              </Box>
            )}
          </>
        )}
      </ModalDialog>
    </Modal>
  );
}

export default PublishShareModal;
