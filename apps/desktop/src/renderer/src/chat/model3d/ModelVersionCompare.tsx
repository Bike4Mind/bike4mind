import Box from '@mui/joy/Box';
import Typography from '@mui/joy/Typography';
import { useEffect, useRef } from 'react';
import type { CompareMode } from './ModelVersionStrip';
import { type CompareSubject, VersionCompareView } from './versionCompare';

type Props = {
  mode: CompareMode;
  first: CompareSubject & { label: string };
  second: CompareSubject & { label: string };
  dark: boolean;
};

const captionSx = {
  position: 'absolute',
  bottom: 8,
  px: 0.75,
  borderRadius: 'sm',
  bgcolor: 'color-mix(in srgb, var(--joy-palette-background-surface) 85%, transparent)',
  pointerEvents: 'none',
} as const;

/** Two versions over the 3D view, side by side or overlaid (versionCompare.ts), each named. */
export function ModelVersionCompare({ mode, first, second, dark }: Props) {
  const host = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const view = new VersionCompareView(element, first, second, mode, dark);
    return () => view.dispose();
  }, [mode, first, second, dark]);

  return (
    <Box
      data-testid={`model-version-compare-view-${mode}`}
      sx={{ position: 'absolute', inset: 0, zIndex: 1, bgcolor: 'background.surface' }}
    >
      <Box ref={host} sx={{ position: 'absolute', inset: 0, '& canvas': { display: 'block' } }} />
      {mode === 'side' ? (
        <>
          <Box sx={{ position: 'absolute', top: 0, bottom: 0, left: '50%', width: '1px', bgcolor: 'divider' }} />
          <Typography level="body-xs" sx={{ ...captionSx, left: 8 }}>
            {first.label}
          </Typography>
          <Typography level="body-xs" sx={{ ...captionSx, left: 'calc(50% + 8px)' }}>
            {second.label}
          </Typography>
        </>
      ) : (
        <Typography level="body-xs" sx={{ ...captionSx, left: 8 }}>
          {`${first.label} solid \u00b7 ${second.label} ghost (blue)`}
        </Typography>
      )}
    </Box>
  );
}
