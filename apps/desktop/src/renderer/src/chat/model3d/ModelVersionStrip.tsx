import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import IconButton from '@mui/joy/IconButton';
import Stack from '@mui/joy/Stack';
import ToggleButtonGroup from '@mui/joy/ToggleButtonGroup';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { versionLabel, type ModelVersionEntry } from '@shared/model3d';
import { CloseIcon } from '../icons';
import { thinScrollbarSx } from '../layout';

export type CompareMode = 'side' | 'overlay';

/** A PNG's bytes as a data URL, so an <img> can show it without a blob URL to revoke. */
export function pngDataUrl(bytes: Uint8Array): string {
  let binary = '';
  // In chunks: spreading a large array into fromCharCode overflows the call stack.
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

/** "14:02" today, else "18 Nov 14:02", for a version's tooltip. */
export function versionTime(createdAt: number, now = Date.now()): string {
  const date = new Date(createdAt);
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (new Date(now).toDateString() === date.toDateString()) return time;
  return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}

export function versionTitle(version: ModelVersionEntry, current: boolean): string {
  const parts = [versionLabel(version.number), versionTime(version.createdAt)];
  if (version.note) parts.push(version.note);
  if (current) parts.push('current');
  return parts.join(' \u00b7 ');
}

type StripProps = {
  /** Oldest first. */
  versions: readonly ModelVersionEntry[];
  /** The version matching the file now; null after an edit that has not built yet. */
  current: number | null;
  /** The version shown in place of the current one, if any. */
  selected: number | null;
  onSelect: (number: number) => void;
  /** Back to the current build (Esc while a version is selected). */
  onClose: () => void;
};

/**
 * The kept builds of this conversation's model, newest on the right, under the 3D view. Clicking a
 * thumbnail previews it; clicking the current one, or Esc, goes back. Arrow keys move between them.
 */
export function ModelVersionStrip({ versions, current, selected, onSelect, onClose }: StripProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const newest = versions.at(-1)?.number ?? null;
  const thumbnails = useMemo(
    () => new Map(versions.map(version => [version.number, version.thumbnail && pngDataUrl(version.thumbnail)])),
    [versions]
  );

  // A new version lands on the right; keep it in view.
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollLeft = list.scrollWidth;
  }, [newest]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && selected !== null) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    event.preventDefault();
    buttons[Math.min(buttons.length - 1, Math.max(0, at + (event.key === 'ArrowRight' ? 1 : -1)))]?.focus();
  };

  if (!versions.length) return null;
  const shown = selected ?? current;
  return (
    <Stack direction="row" alignItems="center" spacing={1} sx={{ mx: 1.5, mt: 0.75 }} data-testid="model-versions">
      <Typography level="body-xs" sx={{ color: 'text.tertiary', flexShrink: 0 }}>
        Versions
      </Typography>
      <Box
        ref={listRef}
        role="toolbar"
        aria-label="Model versions"
        onKeyDown={onKeyDown}
        sx={{ display: 'flex', gap: 0.5, overflowX: 'auto', minWidth: 0, py: 0.25, ...thinScrollbarSx }}
      >
        {versions.map(version => {
          const isCurrent = version.number === current;
          const isShown = version.number === shown;
          const thumbnail = thumbnails.get(version.number);
          return (
            <Tooltip key={version.number} title={versionTitle(version, isCurrent)} size="sm" placement="top">
              <Box
                component="button"
                type="button"
                aria-pressed={isShown}
                aria-label={versionTitle(version, isCurrent)}
                data-testid={`model-version-${version.number}`}
                onClick={() => onSelect(version.number)}
                sx={{
                  position: 'relative',
                  flexShrink: 0,
                  width: 48,
                  height: 48,
                  p: 0,
                  border: '2px solid',
                  borderColor: isShown ? 'primary.solidBg' : 'neutral.outlinedBorder',
                  borderRadius: 'sm',
                  overflow: 'hidden',
                  cursor: 'pointer',
                  bgcolor: 'background.level1',
                  '&:focus-visible': { outline: '2px solid var(--joy-palette-focusVisible)', outlineOffset: 1 },
                }}
              >
                {thumbnail && (
                  <Box
                    component="img"
                    src={thumbnail}
                    alt=""
                    sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  />
                )}
                <Typography
                  component="span"
                  level="body-xs"
                  sx={{
                    position: 'absolute',
                    left: 2,
                    bottom: 1,
                    px: 0.375,
                    borderRadius: 'xs',
                    fontSize: 10,
                    lineHeight: 1.4,
                    fontWeight: isCurrent ? 'lg' : 'md',
                    color: 'text.primary',
                    bgcolor: 'color-mix(in srgb, var(--joy-palette-background-surface) 80%, transparent)',
                  }}
                >
                  {versionLabel(version.number)}
                </Typography>
              </Box>
            </Tooltip>
          );
        })}
      </Box>
    </Stack>
  );
}

type BannerProps = {
  version: ModelVersionEntry;
  /** The version it is compared with (the current one); null when there is no current version. */
  current: number | null;
  /** The compare mode on, or null while only previewing. */
  compare: CompareMode | null;
  status: 'building' | 'ready' | { error: string };
  restoring: boolean;
  onCompareChange: (mode: CompareMode | null) => void;
  onRestore: () => void;
  onClose: () => void;
};

/** Over the top of the 3D view while a version is previewed or compared: what it is, and what to do with it. */
export function ModelVersionBanner({
  version,
  current,
  compare,
  status,
  restoring,
  onCompareChange,
  onRestore,
  onClose,
}: BannerProps) {
  const label = versionLabel(version.number);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };
  const what = compare
    ? `Comparing ${label} with ${current === null ? 'the file now' : versionLabel(current)}`
    : `Previewing ${label}`;
  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={1}
      role="group"
      aria-label={`Version ${label}`}
      onKeyDown={onKeyDown}
      data-testid="model-version-banner"
      sx={{
        position: 'absolute',
        top: 8,
        left: 8,
        maxWidth: 'calc(100% - 16px)',
        flexWrap: 'wrap',
        rowGap: 0.5,
        pl: 1.25,
        pr: 0.375,
        py: 0.375,
        borderRadius: 'md',
        bgcolor: 'color-mix(in srgb, var(--joy-palette-background-surface) 88%, transparent)',
        backdropFilter: 'blur(10px) saturate(1.4)',
        boxShadow: 'sm',
        zIndex: 2,
      }}
    >
      <Typography level="body-sm" sx={{ fontWeight: 'md' }} data-testid="model-version-banner-title">
        {what}
        {version.note ? (
          <Typography component="span" sx={{ color: 'text.tertiary', fontWeight: 'normal' }}>
            {` \u00b7 ${version.note}`}
          </Typography>
        ) : null}
      </Typography>
      {typeof status === 'object' && (
        <Typography level="body-xs" color="danger" data-testid="model-version-error">
          {status.error}
        </Typography>
      )}
      <ToggleButtonGroup
        size="sm"
        variant="plain"
        value={compare}
        onChange={(_event, value) => onCompareChange(value === 'side' || value === 'overlay' ? value : null)}
        aria-label="Compare with the current version"
      >
        <Button value="side" disabled={status !== 'ready'} data-testid="model-version-compare-side">
          Side by side
        </Button>
        <Button value="overlay" disabled={status !== 'ready'} data-testid="model-version-compare-overlay">
          Overlay
        </Button>
      </ToggleButtonGroup>
      <Button size="sm" variant="solid" loading={restoring} onClick={onRestore} data-testid="model-version-restore">
        Restore
      </Button>
      <Tooltip title="Back to current (Esc)" size="sm">
        <IconButton
          size="sm"
          variant="plain"
          aria-label="Back to current"
          onClick={onClose}
          data-testid="model-version-close"
        >
          <CloseIcon />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}
