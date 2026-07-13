import React, { useState } from 'react';
import { Box, Button, FormLabel, Input, Radio, Sheet, Textarea, Typography } from '@mui/joy';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import KeyIcon from '@mui/icons-material/Key';
import DomainIcon from '@mui/icons-material/Domain';
import PublicIcon from '@mui/icons-material/Public';
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
  /** A gate only applies on the public tier; otherwise the editor shows a hint. */
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

  const isPublic = visibility === 'public';

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

  const apply = async () => {
    if (busy) return;
    const gate = buildInput();
    if (gate === 'invalid') return;
    setBusy(true);
    try {
      await updatePublishedAccessGate(publicId, gate);
      setPassphrase('');
      const applied: PublishAccessGateRead =
        gate === null
          ? null
          : gate.kind === 'passphrase'
            ? { kind: 'passphrase' }
            : { kind: 'domain', allowedDomains: gate.allowedDomains };
      onGateChange?.(applied);
      toast.success(
        gate === null
          ? 'Gate removed - open to anyone with the link'
          : gate.kind === 'passphrase'
            ? 'Passphrase set - share it with your viewers'
            : 'Domain restriction applied'
      );
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box data-testid={`${testIdPrefix}-section`}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
        <LockOpenIcon fontSize="small" />
        <FormLabel sx={{ mb: 0 }}>Who can view</FormLabel>
      </Box>
      {!isPublic ? (
        <Typography level="body-xs" sx={{ opacity: 0.75 }} data-testid={`${testIdPrefix}-needs-public`}>
          Access gates apply to public artifacts. Set visibility to Public to add a passphrase or domain restriction.
        </Typography>
      ) : (
        <>
          {/* The whole card is the click target (the Sheet owns onClick); the Radio
              is a read-only visual indicator with pointer-events disabled so it never
              eats the tap. role/aria + keyboard make it an accessible radio group. */}
          <Box
            role="radiogroup"
            aria-label="Who can view"
            sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, gap: 1, mb: 1 }}
          >
            {GATE_OPTIONS.map(o => {
              const selected = kind === o.value;
              return (
                <Sheet
                  key={o.value}
                  variant="outlined"
                  role="radio"
                  aria-checked={selected}
                  tabIndex={0}
                  onClick={() => setKind(o.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setKind(o.value);
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
            <Input
              type="password"
              value={passphrase}
              placeholder={
                initialGate?.kind === 'passphrase' ? 'Enter a NEW passphrase to change it' : 'At least 8 characters'
              }
              onChange={e => setPassphrase(e.target.value)}
              slotProps={{ input: { 'data-testid': `${testIdPrefix}-passphrase-input`, autoComplete: 'new-password' } }}
              sx={{ mb: 1 }}
            />
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
        </>
      )}
    </Box>
  );
}

export default AccessGateEditor;
