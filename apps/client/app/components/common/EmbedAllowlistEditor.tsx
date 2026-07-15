import React, { useEffect, useState } from 'react';
import { Box, Button, Chip, ChipDelete, FormLabel, IconButton, Input, Textarea, Tooltip, Typography } from '@mui/joy';
import CodeIcon from '@mui/icons-material/Code';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import { parseEmbedOrigin, EMBED_ORIGINS_MAX } from '@bike4mind/common';
import { updatePublishedEmbedOrigins, getPublishedEmbedState } from '@client/app/utils/publishApi';

export interface EmbedAllowlistEditorProps {
  publicId: string;
  /** Canonical /p URL used to build the iframe snippet. */
  shareUrl: string;
  /** Title for the snippet's title attribute. */
  title: string;
  /** Parent-controlled: the editor only renders for an open-public artifact
   *  (a gated page is no-store and never framed). */
  isOpenPublic: boolean;
  /** When provided, seed from this instead of fetching (the parent already has it). */
  initialOrigins?: string[];
  /** Notified after every successful add/remove with the new list. */
  onOriginsChange?: (origins: string[]) => void;
  /** Overrides the data-testid prefix (defaults to the share-dialog ids). */
  testIdPrefix?: string;
}

function errMessage(err: unknown): string {
  if (isAxiosError(err)) return (err.response?.data as { error?: string })?.error || err.message;
  return err instanceof Error ? err.message : 'Something went wrong';
}

/**
 * Casual input sugar: turn what a user actually types (`example.com`,
 * `example.com/blog`) into a candidate https origin, then let the strict
 * parseEmbedOrigin validate it. Prepends `https://` when no scheme is given and
 * reduces a full URL to its origin (frame-ancestors is origin-level anyway). An
 * explicit `http://` is left as-is so parseEmbedOrigin rejects it loudly.
 */
export function coerceToOrigin(raw: string): string {
  const s = raw.trim();
  if (!s) return s;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    return u.port ? `${u.protocol}//${u.hostname}:${u.port}` : `${u.protocol}//${u.hostname}`;
  } catch {
    return s;
  }
}

/**
 * Embed allowlist editor: add or remove the external https origins allowed to
 * frame this artifact, and copy a ready-made `?embed=1` iframe snippet. Used by
 * both the publish/share dialog and the Live Artifacts manage panel. The server
 * re-validates every origin and enforces the open-public rule.
 */
export function EmbedAllowlistEditor({
  publicId,
  shareUrl,
  title,
  isOpenPublic,
  initialOrigins,
  onOriginsChange,
  testIdPrefix = 'publish-share-embed',
}: EmbedAllowlistEditorProps) {
  const [origins, setOrigins] = useState<string[]>(initialOrigins ?? []);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  // Seed from the live record only when the parent didn't supply the list.
  useEffect(() => {
    if (initialOrigins !== undefined || !publicId) return;
    let active = true;
    void getPublishedEmbedState(publicId)
      .then(state => {
        if (active) setOrigins(state.embedOrigins);
      })
      .catch(() => {
        /* best-effort seed; the server re-validates on write */
      });
    return () => {
      active = false;
    };
  }, [publicId, initialOrigins]);

  if (!isOpenPublic) return null;

  const persist = async (next: string[], successMsg: string) => {
    if (busy) return;
    const prev = origins;
    setOrigins(next);
    setBusy(true);
    try {
      await updatePublishedEmbedOrigins(publicId, next);
      onOriginsChange?.(next);
      toast.success(successMsg);
    } catch (err) {
      setOrigins(prev);
      toast.error(errMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const onAdd = () => {
    const parsed = parseEmbedOrigin(coerceToOrigin(input));
    if (!parsed) {
      toast.error('Enter a site like example.com (it becomes https://example.com)');
      return;
    }
    if (origins.includes(parsed)) {
      setInput('');
      return;
    }
    if (origins.length >= EMBED_ORIGINS_MAX) {
      toast.error(`Up to ${EMBED_ORIGINS_MAX} sites can embed one artifact`);
      return;
    }
    setInput('');
    void persist([...origins, parsed], `${parsed} can now embed this`);
  };

  const onRemove = (origin: string) =>
    void persist(
      origins.filter(o => o !== origin),
      'Embed permission removed'
    );

  const snippet = `<iframe src="${shareUrl}?embed=1" width="100%" height="600" style="border:0" loading="lazy" title="${title
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')}"></iframe>`;

  const copySnippet = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      toast.success('Embed code copied to clipboard!');
    } catch {
      toast.error("Couldn't copy - select the code manually");
    }
  };

  return (
    <Box data-testid={`${testIdPrefix}-section`}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
        <CodeIcon fontSize="small" />
        <FormLabel sx={{ mb: 0 }}>Embed on your site</FormLabel>
      </Box>
      <Typography level="body-xs" sx={{ opacity: 0.75, mb: 1 }}>
        Allow specific sites to frame this artifact. Add the exact origin (up to {EMBED_ORIGINS_MAX}) where you&apos;ll
        paste the embed code.
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
        <Input
          value={input}
          placeholder="example.com"
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onAdd();
            }
          }}
          disabled={busy || origins.length >= EMBED_ORIGINS_MAX}
          slotProps={{ input: { 'data-testid': `${testIdPrefix}-input`, autoComplete: 'off' } }}
          sx={{ flex: 1, fontFamily: 'monospace', fontSize: '13px' }}
        />
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          loading={busy}
          disabled={origins.length >= EMBED_ORIGINS_MAX}
          onClick={onAdd}
          data-testid={`${testIdPrefix}-add`}
        >
          Allow
        </Button>
      </Box>
      {origins.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mb: 1 }}>
          {origins.map(origin => (
            <Chip
              key={origin}
              variant="soft"
              color="neutral"
              data-testid={`${testIdPrefix}-chip-${origin}`}
              endDecorator={
                <ChipDelete
                  disabled={busy}
                  onClick={() => onRemove(origin)}
                  data-testid={`${testIdPrefix}-remove-${origin}`}
                />
              }
            >
              {origin}
            </Chip>
          ))}
        </Box>
      )}
      {origins.length > 0 && (
        <>
          <Typography level="body-xs" sx={{ opacity: 0.75, mb: 0.5 }}>
            Paste this where you want the artifact to appear:
          </Typography>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Textarea
              value={snippet}
              readOnly
              minRows={2}
              slotProps={{ textarea: { 'data-testid': `${testIdPrefix}-snippet` } }}
              sx={{ flex: 1, fontFamily: 'monospace', fontSize: '12px' }}
            />
            <Tooltip title="Copy embed code">
              <IconButton
                variant="outlined"
                color="neutral"
                onClick={() => void copySnippet()}
                data-testid={`${testIdPrefix}-copy`}
              >
                <CodeIcon />
              </IconButton>
            </Tooltip>
          </Box>
        </>
      )}
    </Box>
  );
}

export default EmbedAllowlistEditor;
