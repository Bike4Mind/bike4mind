import React, { useEffect, useRef, useState } from 'react';
import { Box, Button, FormLabel, IconButton, Input, Radio, Sheet, Textarea, Tooltip, Typography } from '@mui/joy';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import KeyIcon from '@mui/icons-material/Key';
import DomainIcon from '@mui/icons-material/Domain';
import PublicIcon from '@mui/icons-material/Public';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import AutorenewIcon from '@mui/icons-material/Autorenew';
import LockResetIcon from '@mui/icons-material/LockReset';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';
import {
  ClearGateConfirmModal,
  StoredGateNote,
  STORED_GATE_CLEARED_MESSAGE,
} from '@client/app/components/common/StoredGateClear';
import { generatePassphrase } from '@client/app/utils/generatePassphrase';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import {
  updatePublishedAccessGate,
  type PublishAccessGateInput,
  type PublishAccessGateRead,
} from '@client/app/utils/publishApi';
import { registrableDomain } from '@bike4mind/utils/registrableDomain';

export interface AccessGateEditorProps {
  publicId: string;
  /** On a public item the editor sets any gate. On a non-public item it only offers a gate that is
   *  already stored (the server still enforces it on private share links) and otherwise shows a hint. */
  visibility: string;
  /** The live gate, for seeding the control (passphrase value is never readable). */
  initialGate: PublishAccessGateRead;
  /** Notified after a successful apply so the parent can react (e.g. hide embed). */
  onGateChange?: (gate: PublishAccessGateRead) => void;
  testIdPrefix?: string;
}

type GateKind = 'none' | 'passphrase' | 'domain';
const GATE_OPTIONS: Array<{ value: GateKind; label: string; icon: React.ReactNode }> = [
  { value: 'none', label: 'Anyone with the link', icon: <PublicIcon sx={{ fontSize: 16 }} /> },
  { value: 'passphrase', label: 'Passphrase', icon: <KeyIcon sx={{ fontSize: 16 }} /> },
  { value: 'domain', label: 'Email domain', icon: <DomainIcon sx={{ fontSize: 16 }} /> },
];
/** Syntactic domain pre-filter (mirrors the server DOMAIN_RE); entries are then
 *  validated as real registrable domains and sent/stored AS ENTERED (never reduced). */
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

function errMessage(err: unknown): string {
  if (isAxiosError(err)) return (err.response?.data as { error?: string })?.error || err.message;
  return err instanceof Error ? err.message : 'Something went wrong';
}

/**
 * Access-gate editor for a published artifact: open, passphrase, or verified
 * email domain. Applies live (owner/admin). The passphrase is write-only - it is
 * sent once and stored as a hash, so re-applying a passphrase gate requires
 * typing a new one. Used by the Live Artifacts manage panel.
 *
 * A gate stored on a non-public item stays in force on its private share links
 * (/a/<token>) but not on the page's own address (/p/...), which follows visibility alone. So
 * such a gate is shown, with what it guards, and can be changed or cleared; setting a first gate
 * stays a public-page action, because the server only accepts one on a non-public item that
 * already has a live share link and this editor has no view of the links.
 */
export function AccessGateEditor({
  publicId,
  visibility,
  initialGate,
  onGateChange,
  testIdPrefix = 'manage-gate',
}: AccessGateEditorProps) {
  const [kind, setKind] = useState<GateKind>(initialGate?.kind ?? 'none');
  const [passphrase, setPassphrase] = useState('');
  const [domainsText, setDomainsText] = useState(
    initialGate?.kind === 'domain' ? initialGate.allowedDomains.join(', ') : ''
  );
  const [busy, setBusy] = useState(false);
  /** Unmask what is being typed. Never reveals a STORED passphrase - there is none to reveal. */
  const [reveal, setReveal] = useState(false);
  /** The passphrase just applied, held for this render only so the owner can copy it. Cleared
   *  on any further edit; never re-derivable once gone, since the server keeps only a hash. */
  const [justSet, setJustSet] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /** What is actually stored right now, tracked locally rather than read off `initialGate`: the
   *  parent is notified via onGateChange but is not obliged to feed a new prop back, and after a
   *  first apply the difference is exactly whether the button offers to "Generate" or warns that
   *  it will "Replace" a live passphrase. */
  const [liveGateKind, setLiveGateKind] = useState<GateKind>(initialGate?.kind ?? 'none');
  const [confirmingClear, setConfirmingClear] = useState(false);
  const hintRef = useRef<HTMLParagraphElement>(null);
  /** Set by a successful Clear. The button that opened the confirmation is gone by then, so the
   *  modal's focus restore has nowhere to go; focus lands on the hint that replaces the editor. */
  const focusHintAfterClear = useRef(false);

  const isPublic = visibility === 'public';
  /** Stored on a non-public item: still enforced on private links, so the owner can see and clear it. */
  const hasPrivateLinkGate = !isPublic && liveGateKind !== 'none';
  const showEditor = isPublic || hasPrivateLinkGate;
  // "Anyone with the link" is the Clear action on a non-public item, not a card to pick.
  const gateOptions = isPublic ? GATE_OPTIONS : GATE_OPTIONS.filter(o => o.value !== 'none');
  /** A passphrase is already in force, so generating another REVOKES it for existing holders. */
  const hasLiveGate = liveGateKind === 'passphrase';

  // Waits for the modal to close as well: its focus restore runs on unmount and would undo this.
  useEffect(() => {
    if (!focusHintAfterClear.current || confirmingClear || showEditor) return;
    focusHintAfterClear.current = false;
    hintRef.current?.focus();
  }, [confirmingClear, showEditor]);

  const copyJustSet = async () => {
    if (!justSet) return;
    try {
      await navigator.clipboard.writeText(justSet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (insecure context, or permission denied). The value is on screen and
      // selectable, so say so rather than failing silently.
      toast.error('Could not copy - select the passphrase and copy it manually');
    }
  };

  /** Change gate type. Clears the show-once passphrase: the panel renders as a sibling of the
   *  passphrase block, so without this it keeps displaying the plaintext after the owner switches
   *  to another gate - and switching also removes the input, the only other thing that clears it. */
  const chooseKind = (next: GateKind) => {
    setKind(next);
    setJustSet(null);
  };

  const buildInput = (): PublishAccessGateInput | 'invalid' => {
    if (kind === 'none') return null;
    if (kind === 'passphrase') {
      if (passphrase.length < 8) {
        toast.error('Passphrase must be at least 8 characters');
        return 'invalid';
      }
      return { kind: 'passphrase', passphrase };
    }
    const domains = [
      ...new Set(
        domainsText
          .split(/[\s,]+/)
          .map(d => d.trim().toLowerCase())
          .filter(Boolean)
      ),
    ];
    if (domains.length === 0) {
      toast.error('Add at least one email domain');
      return 'invalid';
    }
    const bad = domains.find(d => !DOMAIN_RE.test(d));
    if (bad) {
      toast.error(`Invalid domain: ${bad}`);
      return 'invalid';
    }
    // Validate each entry is a real registrable domain (rejects a bare suffix like
    // co.uk / github.io) but keep it AS ENTERED - matching is exact-or-subdomain, so
    // a subdomain entry is never widened to its parent org.
    const noReg = domains.find(d => registrableDomain(d, { allowPrivateDomains: true }) === null);
    if (noReg) {
      toast.error(`Enter a registrable domain (e.g. acme.com), not: ${noReg}`);
      return 'invalid';
    }
    return { kind: 'domain', allowedDomains: domains };
  };

  /** Sends the gate and mirrors the result locally. Resolves false when the server refused it. */
  const commit = async (gate: PublishAccessGateInput): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    try {
      await updatePublishedAccessGate(publicId, gate);
      // Move the plaintext out of the input and into the show-once panel. This is the last
      // moment it exists anywhere: the server stores only a bcrypt hash and no route returns it.
      setJustSet(gate !== null && gate.kind === 'passphrase' ? gate.passphrase : null);
      setLiveGateKind(gate === null ? 'none' : gate.kind);
      setPassphrase('');
      setReveal(false);
      const applied: PublishAccessGateRead =
        gate === null
          ? null
          : gate.kind === 'passphrase'
            ? { kind: 'passphrase' }
            : { kind: 'domain', allowedDomains: gate.allowedDomains };
      onGateChange?.(applied);
      toast.success(
        gate === null
          ? isPublic
            ? 'Gate removed - open to anyone with the link'
            : STORED_GATE_CLEARED_MESSAGE
          : gate.kind === 'passphrase'
            ? 'Passphrase set - share it with your viewers'
            : 'Domain restriction applied'
      );
      return true;
    } catch (err) {
      toast.error(errMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (busy) return;
    const gate = buildInput();
    if (gate === 'invalid') return;
    await commit(gate);
  };

  const clearGate = async () => {
    const cleared = await commit(null);
    if (cleared) focusHintAfterClear.current = true;
    setConfirmingClear(false);
    if (!cleared) return;
    // The stored gate is gone, so drop the draft that was seeded from it as well.
    setKind('none');
    setDomainsText('');
  };

  return (
    <Box data-testid={`${testIdPrefix}-section`}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
        <LockOpenIcon fontSize="small" />
        <FormLabel sx={{ mb: 0 }}>Who can view</FormLabel>
      </Box>
      {!showEditor ? (
        // Says what this editor can do, not where gates apply: a stored gate also guards private
        // links (the note below), and an owner reads this right after clearing one.
        <Typography
          ref={hintRef}
          tabIndex={-1}
          level="body-xs"
          textColor="text.tertiary"
          data-testid={`${testIdPrefix}-needs-public`}
        >
          To add a passphrase or domain restriction here, set visibility to Public.
        </Typography>
      ) : (
        <>
          {hasPrivateLinkGate && (
            <StoredGateNote
              kind={liveGateKind}
              visibility={visibility}
              sx={{ mb: 1 }}
              data-testid={`${testIdPrefix}-private-link-note`}
            />
          )}
          {/* The whole card is the click target (the Sheet owns onClick); the Radio
              is a read-only visual indicator with pointer-events disabled so it never
              eats the tap. role/aria + keyboard make it an accessible radio group. */}
          <Box
            role="radiogroup"
            aria-label="Who can view"
            sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, gap: 1, mb: 1 }}
          >
            {gateOptions.map(o => {
              const selected = kind === o.value;
              return (
                <Sheet
                  key={o.value}
                  variant="outlined"
                  role="radio"
                  aria-checked={selected}
                  tabIndex={0}
                  onClick={() => chooseKind(o.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      chooseKind(o.value);
                    }
                  }}
                  data-testid={`${testIdPrefix}-${o.value}`}
                  sx={{
                    flex: 1,
                    borderRadius: 'md',
                    p: 1,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 0.75,
                    cursor: 'pointer',
                    borderColor: selected ? 'primary.500' : 'divider',
                    bgcolor: selected ? 'primary.softBg' : 'background.surface',
                    '&:hover': { borderColor: selected ? 'primary.500' : 'neutral.400' },
                  }}
                >
                  <Radio checked={selected} readOnly value={o.value} tabIndex={-1} sx={{ pointerEvents: 'none' }} />
                  {o.icon}
                  <Typography level="body-sm" sx={{ fontWeight: selected ? 600 : 400 }}>
                    {o.label}
                  </Typography>
                </Sheet>
              );
            })}
          </Box>

          {kind === 'passphrase' && (
            <Box sx={{ mb: 1 }}>
              <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'flex-start' }}>
                <Input
                  type={reveal ? 'text' : 'password'}
                  value={passphrase}
                  placeholder={hasLiveGate ? 'Enter a NEW passphrase to change it' : 'At least 8 characters'}
                  onChange={e => {
                    setPassphrase(e.target.value);
                    setJustSet(null); // a new draft supersedes the one we are still displaying
                  }}
                  slotProps={{
                    input: { 'data-testid': `${testIdPrefix}-passphrase-input`, autoComplete: 'new-password' },
                  }}
                  endDecorator={
                    // The eye is where people reach expecting to unmask a SAVED passphrase, so
                    // the tooltip says plainly why that is not on offer. It only ever reveals
                    // the draft being typed: the stored value is a bcrypt hash and no route
                    // returns it, which is what makes this show-once rather than "show".
                    <Tooltip
                      title="Shows what you are typing. A saved passphrase can never be shown - it is stored hashed."
                      size="sm"
                    >
                      <IconButton
                        size="sm"
                        variant="plain"
                        color="neutral"
                        onClick={() => setReveal(v => !v)}
                        aria-label={reveal ? 'Hide passphrase' : 'Show passphrase'}
                        data-testid={`${testIdPrefix}-passphrase-reveal`}
                      >
                        {reveal ? (
                          <VisibilityOffIcon sx={{ fontSize: 16 }} />
                        ) : (
                          <VisibilityIcon sx={{ fontSize: 16 }} />
                        )}
                      </IconButton>
                    </Tooltip>
                  }
                  sx={{ flex: 1 }}
                />
                {/* Setting the first passphrase and REPLACING a live one are different acts with
                    different consequences, so they get different labels, icons and tooltips.
                    Replacing is the forgotten-passphrase path - the only one there is - and it
                    revokes access for everyone already holding the old value, which the button
                    has to say out loud rather than leave to be discovered. */}
                <Tooltip
                  title={
                    hasLiveGate
                      ? 'Forgot the passphrase? Generate a replacement - the current one cannot be recovered. Anyone you already gave it to will need the new one.'
                      : 'Generate a strong passphrase. You will see it once, after you apply it.'
                  }
                  size="sm"
                >
                  <Button
                    size="sm"
                    variant="soft"
                    color={hasLiveGate ? 'warning' : 'neutral'}
                    startDecorator={
                      hasLiveGate ? <LockResetIcon sx={{ fontSize: 16 }} /> : <AutorenewIcon sx={{ fontSize: 16 }} />
                    }
                    onClick={() => {
                      setPassphrase(generatePassphrase());
                      setReveal(true); // a generated passphrase you cannot read is useless
                    }}
                    data-testid={`${testIdPrefix}-passphrase-generate`}
                  >
                    {hasLiveGate ? 'Replace' : 'Generate'}
                  </Button>
                </Tooltip>
              </Box>
              <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
                {hasLiveGate
                  ? 'A passphrase is set. It cannot be shown or recovered - to change it, enter or generate a new one, which stops the old one working.'
                  : 'Stored hashed - it cannot be shown again after you apply it, so copy it now if you need to share it.'}
              </Typography>
            </Box>
          )}

          {/* Show-once: the only moment the plaintext exists anywhere. After this render it is
              gone from the client too, and the server holds nothing but a bcrypt hash. */}
          {justSet && (
            <Sheet
              variant="soft"
              color="success"
              sx={{ borderRadius: 'md', p: 1, mb: 1 }}
              data-testid={`${testIdPrefix}-passphrase-justset`}
            >
              <Typography level="body-xs" sx={{ fontWeight: 600, mb: 0.5 }}>
                Passphrase set - copy it now
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                <Typography
                  level="body-sm"
                  sx={{ fontFamily: 'monospace', wordBreak: 'break-all', flex: 1, userSelect: 'all' }}
                  data-testid={`${testIdPrefix}-passphrase-justset-value`}
                >
                  {justSet}
                </Typography>
                <IconButton
                  size="sm"
                  variant="plain"
                  color="neutral"
                  onClick={() => void copyJustSet()}
                  aria-label="Copy passphrase"
                  data-testid={`${testIdPrefix}-passphrase-copy`}
                >
                  {copied ? <CheckIcon sx={{ fontSize: 16 }} /> : <ContentCopyIcon sx={{ fontSize: 16 }} />}
                </IconButton>
              </Box>
              <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
                This will not be shown again. To get a new one, set another passphrase.
              </Typography>
            </Sheet>
          )}
          {kind === 'domain' && (
            <Textarea
              value={domainsText}
              minRows={2}
              placeholder="example.com, example.org"
              onChange={e => setDomainsText(e.target.value)}
              slotProps={{ textarea: { 'data-testid': `${testIdPrefix}-domains-input` } }}
              sx={{ mb: 1, fontFamily: 'monospace', fontSize: '13px' }}
            />
          )}
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            {/* A draft of 'none' survives a public -> non-public switch with no card left to show
                it; there Apply would be an unconfirmed Remove gate, so only Clear gate removes. */}
            {(isPublic || kind !== 'none') && (
              <Button
                size="sm"
                variant="outlined"
                color="neutral"
                loading={busy}
                onClick={() => void apply()}
                data-testid={`${testIdPrefix}-apply`}
              >
                {kind === 'none' ? 'Remove gate' : 'Apply'}
              </Button>
            )}
            {hasPrivateLinkGate && (
              <Button
                size="sm"
                variant="outlined"
                color="danger"
                disabled={busy}
                onClick={() => setConfirmingClear(true)}
                data-testid={`${testIdPrefix}-clear`}
              >
                Clear gate
              </Button>
            )}
          </Box>
        </>
      )}
      <ClearGateConfirmModal
        open={confirmingClear}
        onClose={() => setConfirmingClear(false)}
        onConfirm={clearGate}
        loading={busy}
        kind={liveGateKind === 'passphrase' ? 'passphrase' : 'domain'}
      />
    </Box>
  );
}

export default AccessGateEditor;
