import Box from '@mui/joy/Box';
import type { StudioMediaKind } from '@shared/studio';

// Same paths as web's MEDIUM_GLYPHS (apps/client Studio/v2/StudioMediumRail.tsx): a 24px grid, 1.6 stroke.
const MEDIUM_GLYPHS: Record<StudioMediaKind, string> = {
  image: 'M3 4h18v16H3zM9 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM21 16l-5-5-9 9',
  video: 'M3 6h13v12H3zM16 10l5-3v10l-5-3',
  music: 'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  speech: 'M9 3h6v11H9zM5 11a7 7 0 0 0 14 0M12 18v3',
  'sound-effect': 'M2 12h3l2-6 4 12 3-9 2 3h6',
};

export function MediumGlyph({ kind, size = 18 }: { kind: StudioMediaKind; size?: number }) {
  return (
    <Box component="svg" viewBox="0 0 24 24" aria-hidden="true" sx={{ width: size, height: size, flexShrink: 0 }}>
      <path
        d={MEDIUM_GLYPHS[kind]}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Box>
  );
}
