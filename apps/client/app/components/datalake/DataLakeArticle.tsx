import { Box, Button, Chip, Skeleton, Typography, useTheme } from '@mui/joy';
import { alpha } from '@mui/system';
import AddIcon from '@mui/icons-material/Add';
import ChatIcon from '@mui/icons-material/Chat';
import MarkdownViewer from '@client/app/components/Knowledge/MarkdownViewer';
import { REDUCED_MOTION_OFF, driftFloat, inkFor, ringPing } from '@client/app/components/datalake/surfaceChrome';
import { useDataLakeSurface } from '@client/app/components/datalake/surfaceTokens';
import type { DataLakeSurfaceCopy, DataLakeSurfaceTheme } from '@client/app/components/datalake/surfaceTokens';
import { useGetFabFileContent } from '@client/app/hooks/data/fabFiles';
import type { IFabFileDocument } from '@bike4mind/common';

interface QuickDive {
  path: string[];
  segment: string;
  count: number;
}

interface DataLakeArticleProps {
  file: IFabFileDocument | null;
  onAskAbout: (prompt: string) => void;
  /** Richest categories, surfaced as one-click dives in the empty state. */
  quickDives?: QuickDive[];
  onDive?: (path: string[]) => void;
  /** When set, the empty state offers a create-first CTA (zero-lake bootstrap, #837).
   *  The caller only passes this in the true zero-state, so its presence is the signal. */
  onCreate?: () => void;
}

function cleanFileName(fileName: string): string {
  return fileName
    .replace(/\.[^/.]+$/, '') // strip extension
    .replace(/^\[.*?\]\s*/, ''); // strip leading [Category] prefix
}

function getMeaningfulTags(file: IFabFileDocument): string[] {
  if (!file.tags) return [];
  return file.tags.map(t => t.name).filter(name => !name.startsWith('datalake:'));
}

function humanizeDive(segment: string): string {
  return segment.charAt(0).toUpperCase() + segment.slice(1).replace(/-/g, ' ');
}

/* Drifting motes behind the empty state; `hue` picks which token ink each one takes. */
const MOTES: {
  left: string;
  top: string;
  size: number;
  hue: 'accent' | 'secondary';
  duration: number;
  delay: number;
}[] = [
  { left: '22%', top: '30%', size: 5, hue: 'accent', duration: 9, delay: 0 },
  { left: '70%', top: '24%', size: 4, hue: 'secondary', duration: 11, delay: 1.2 },
  { left: '34%', top: '68%', size: 6, hue: 'accent', duration: 10, delay: 0.6 },
  { left: '78%', top: '62%', size: 4, hue: 'accent', duration: 12, delay: 2 },
  { left: '14%', top: '52%', size: 3, hue: 'secondary', duration: 8, delay: 1.6 },
  { left: '58%', top: '78%', size: 5, hue: 'secondary', duration: 13, delay: 0.3 },
  { left: '48%', top: '18%', size: 3, hue: 'accent', duration: 9.5, delay: 2.4 },
];

function EmptyState({
  isDark,
  quickDives,
  onDive,
  onCreate,
  theme,
  copy,
}: {
  isDark: boolean;
  quickDives: QuickDive[];
  onDive?: (path: string[]) => void;
  onCreate?: () => void;
  theme: DataLakeSurfaceTheme;
  copy: DataLakeSurfaceCopy;
}) {
  const accent = inkFor(theme.accent, isDark);
  return (
    <Box
      data-testid="datalake-article-empty"
      sx={{
        flex: 1,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
        p: 4,
        overflow: 'hidden',
      }}
    >
      {/* Drifting motes */}
      {MOTES.map((mote, i) => {
        const glow = inkFor(theme[mote.hue], isDark);
        return (
          <Box
            key={i}
            aria-hidden
            sx={{
              position: 'absolute',
              left: mote.left,
              top: mote.top,
              width: mote.size,
              height: mote.size,
              borderRadius: '50%',
              bgcolor: alpha(glow, isDark ? 0.7 : 0.5),
              boxShadow: `0 0 ${mote.size * 2}px 1px ${alpha(glow, 0.5)}`,
              animation: `${driftFloat} ${mote.duration}s ease-in-out ${mote.delay}s infinite`,
              ...REDUCED_MOTION_OFF,
            }}
          />
        );
      })}

      {/* Pinging emitter */}
      <Box sx={{ position: 'relative', width: 120, height: 120, flexShrink: 0 }}>
        {[0, 1, 2].map(ring => (
          <Box
            key={ring}
            aria-hidden
            sx={{
              position: 'absolute',
              inset: 0,
              borderRadius: '50%',
              border: '1.5px solid',
              borderColor: alpha(accent, 0.6),
              animation: `${ringPing} 3.6s cubic-bezier(0.2, 0.6, 0.4, 1) ${ring * 1.2}s infinite`,
              ...REDUCED_MOTION_OFF,
            }}
          />
        ))}
        <Box
          sx={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: `radial-gradient(circle at 35% 35%, #FFFFFF, ${accent})`,
            boxShadow: `0 0 18px 4px ${alpha(accent, 0.55)}`,
          }}
        />
      </Box>

      <Box sx={{ textAlign: 'center', zIndex: 1 }}>
        <Typography
          level="title-lg"
          sx={{ fontWeight: 700, letterSpacing: '0.02em', color: 'text.secondary', mb: 0.5 }}
        >
          {onCreate ? copy.zeroTitle : copy.emptyTitle}
        </Typography>
        <Typography level="body-sm" sx={{ color: 'text.tertiary', maxWidth: 380 }}>
          {onCreate ? copy.zeroHint : copy.emptyHint}
        </Typography>
      </Box>

      {/* Create-first CTA: only shown in the true zero-lake state (caller passes onCreate). */}
      {onCreate && (
        <Button
          data-testid="datalake-empty-create-btn"
          variant="solid"
          color="primary"
          startDecorator={<AddIcon />}
          onClick={onCreate}
          sx={{ zIndex: 1 }}
        >
          {copy.createLabel}
        </Button>
      )}

      {/* Quick dives */}
      {quickDives.length > 0 && onDive && (
        <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', justifyContent: 'center', zIndex: 1, maxWidth: 520 }}>
          {quickDives.map(dive => (
            <Chip
              key={dive.path.join(':')}
              variant="outlined"
              data-testid={`datalake-dive-${dive.path.join('-')}`}
              onClick={() => onDive(dive.path)}
              endDecorator={
                <Typography level="body-xs" sx={{ fontFamily: 'monospace', color: 'text.tertiary' }}>
                  {dive.count}
                </Typography>
              }
              sx={{
                '--Chip-minHeight': '32px',
                px: 1.25,
                transition: 'transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease',
                '&:hover': {
                  transform: 'translateY(-2px)',
                  borderColor: accent,
                  boxShadow: `0 4px 14px -4px ${alpha(accent, 0.4)}`,
                },
              }}
            >
              {humanizeDive(dive.segment)}
            </Chip>
          ))}
        </Box>
      )}
    </Box>
  );
}

export default function DataLakeArticle({
  file,
  onAskAbout,
  quickDives = [],
  onDive,
  onCreate,
}: DataLakeArticleProps) {
  const muiTheme = useTheme();
  const isDark = muiTheme.palette.mode === 'dark';
  const { theme, copy, icons } = useDataLakeSurface();
  const { secondaryActionLabel, secondaryActionPrompt } = copy;
  const SecondaryActionIcon = icons.secondaryAction;
  const { data: content, isLoading } = useGetFabFileContent(file);

  if (!file) {
    return (
      <EmptyState
        isDark={isDark}
        quickDives={quickDives}
        onDive={onDive}
        onCreate={onCreate}
        theme={theme}
        copy={copy}
      />
    );
  }

  const title = cleanFileName(file.fileName);
  const tags = getMeaningfulTags(file);
  const accent = inkFor(theme.accent, isDark);
  const secondary = inkFor(theme.secondary, isDark);

  return (
    <Box
      data-testid="datalake-article"
      sx={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        minWidth: 0,
      }}
    >
      {/* Header */}
      <Box
        sx={{
          px: 3,
          pt: 2.5,
          pb: 1.5,
          borderBottom: '1px solid',
          borderColor: 'divider',
          background: `linear-gradient(180deg, ${alpha(accent, isDark ? 0.05 : 0.035)}, transparent)`,
        }}
      >
        <Box
          sx={{
            width: 44,
            height: 3,
            borderRadius: 2,
            mb: 1,
            background: `linear-gradient(90deg, ${accent}, ${secondary})`,
          }}
        />
        <Typography level="h4" sx={{ mb: 1 }}>
          {title}
        </Typography>
        {tags.length > 0 && (
          <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
            {tags.map(tag => (
              <Chip
                key={tag}
                size="sm"
                variant="outlined"
                sx={{
                  fontSize: '11px',
                  fontFamily: 'monospace',
                  color: alpha(accent, 0.9),
                  borderColor: alpha(accent, 0.35),
                }}
              >
                {tag}
              </Chip>
            ))}
          </Box>
        )}
      </Box>

      {/* Content */}
      <Box sx={{ flex: 1, overflow: 'auto', px: 3, py: 2 }}>
        {isLoading ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            <Skeleton variant="text" level="h4" sx={{ width: '60%' }} />
            <Skeleton variant="text" level="body-md" sx={{ width: '100%' }} />
            <Skeleton variant="text" level="body-md" sx={{ width: '90%' }} />
            <Skeleton variant="text" level="body-md" sx={{ width: '95%' }} />
            <Skeleton variant="text" level="body-md" sx={{ width: '70%' }} />
          </Box>
        ) : content ? (
          <MarkdownViewer content={content} />
        ) : (
          <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
            Unable to load article content.
          </Typography>
        )}
      </Box>

      {/* Action bar */}
      <Box sx={{ px: 3, py: 1.5, borderTop: '1px solid', borderColor: 'divider', display: 'flex', gap: 1 }}>
        <Button
          size="sm"
          variant="soft"
          color="primary"
          startDecorator={<ChatIcon sx={{ fontSize: 16 }} />}
          onClick={() => onAskAbout(copy.askAboutPrompt(title))}
          data-testid="datalake-ask-about"
          sx={{ fontSize: '13px' }}
        >
          {copy.askAboutLabel}
        </Button>
        {secondaryActionLabel && secondaryActionPrompt && (
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            startDecorator={<SecondaryActionIcon sx={{ fontSize: 16 }} />}
            onClick={() => onAskAbout(secondaryActionPrompt(title))}
            data-testid="datalake-secondary-action"
            sx={{
              fontSize: '13px',
              '&:hover': { borderColor: secondary, color: secondary },
            }}
          >
            {secondaryActionLabel}
          </Button>
        )}
      </Box>
    </Box>
  );
}
