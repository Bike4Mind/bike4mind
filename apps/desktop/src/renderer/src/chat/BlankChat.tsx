import { memo, useMemo, type ReactNode } from 'react';
import Box from '@mui/joy/Box';
import Typography from '@mui/joy/Typography';
import { keyframes } from '@mui/system';
import type { CreationTool } from '@shared/chat';
import { blankChatSubline, blankChatSuggestions, type SuggestionCategory } from './blankChatSuggestions';
import { AskIcon, ImageIcon, MusicIcon, PenIcon, SoundIcon, VideoIcon, VoiceIcon } from './icons';
import { contentColumnSx, scrollingColumnHostSx } from './layout';

const ICONS: Record<SuggestionCategory, () => ReactNode> = {
  image: ImageIcon,
  video: VideoIcon,
  voice: VoiceIcon,
  sound: SoundIcon,
  music: MusicIcon,
  write: PenIcon,
  ask: AskIcon,
};

const arrive = keyframes({ from: { opacity: 0, transform: 'translateY(6px)' }, to: { opacity: 1, transform: 'none' } });

/**
 * The pane's stand-in for a transcript, in either mode. Scrolls like the thread does and sits on the
 * same column, so whatever replaces it on the first message lands where this was; `my: auto` rather
 * than centering on the scroller, which would clip the top of a block taller than a short window.
 */
export function EmptyThread({ children }: { children: ReactNode }) {
  return (
    <Box
      sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', ...scrollingColumnHostSx }}
      data-testid="chat-thread-blank"
    >
      <Box sx={{ ...contentColumnSx, my: 'auto', py: 4 }}>{children}</Box>
    </Box>
  );
}

export function BlankChatGreeting({ line, children }: { line: string; children?: ReactNode }) {
  return (
    <Box
      sx={{
        animation: `${arrive} 220ms ease-out both`,
        '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
      }}
    >
      <Typography level="h3" component="h2" sx={{ letterSpacing: '-0.01em' }} data-testid="chat-empty-greeting">
        What do you want to make?
      </Typography>
      <Typography level="body-md" textColor="text.tertiary" sx={{ mt: 0.5 }} data-testid="chat-empty-subline">
        {line}
      </Typography>
      {children}
    </Box>
  );
}

/**
 * A new Chat conversation with nothing said in it yet: a greeting and a card per thing it can make.
 *
 * `tools` null means main has not answered yet, and only the greeting is drawn: guessing would
 * either show a card that then vanishes or hold one back that then pops in. Memoized and static -
 * the cards are derived from the session id and the tool list alone, so a streaming reply elsewhere
 * in the window never re-renders them.
 */
export const BlankChat = memo(function BlankChat({
  sessionId,
  tools,
  onPick,
}: {
  sessionId: string;
  tools: readonly CreationTool[] | null;
  /** Fills the composer with the prompt. Never sends. */
  onPick: (prompt: string) => void;
}) {
  const suggestions = useMemo(() => (tools ? blankChatSuggestions(tools, sessionId) : []), [tools, sessionId]);
  const line = useMemo(() => blankChatSubline(tools ?? []), [tools]);

  return (
    <BlankChatGreeting line={line}>
      <Box
        role="list"
        aria-label="Suggestions"
        sx={{
          mt: 3,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 1.25,
        }}
        data-testid="chat-empty-suggestions"
      >
        {suggestions.map(suggestion => {
          const Icon = ICONS[suggestion.category];
          const media = suggestion.category !== 'write' && suggestion.category !== 'ask';
          return (
            <Box role="listitem" key={suggestion.category} sx={{ display: 'flex' }}>
              <Box
                component="button"
                type="button"
                onClick={() => onPick(suggestion.prompt)}
                aria-label={`${suggestion.label}: ${suggestion.prompt}${suggestion.spendsCredits ? ' (uses credits)' : ''}`}
                data-testid="chat-empty-suggestion-btn"
                data-category={suggestion.category}
                sx={theme => ({
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 1,
                  p: 1.5,
                  m: 0,
                  textAlign: 'left',
                  font: 'inherit',
                  color: 'inherit',
                  cursor: 'pointer',
                  borderRadius: 'md',
                  border: '1px solid',
                  borderColor: 'neutral.outlinedBorder',
                  bgcolor: 'background.surface',
                  transition: 'border-color 120ms, background-color 120ms',
                  '&:hover': { borderColor: 'neutral.outlinedHoverBorder', bgcolor: 'background.level1' },
                  '&:active': { bgcolor: 'background.level2' },
                  [theme.focus.selector]: theme.focus.default,
                })}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
                  <Box
                    aria-hidden
                    sx={{
                      display: 'grid',
                      placeItems: 'center',
                      width: 26,
                      height: 26,
                      flexShrink: 0,
                      borderRadius: 'sm',
                      bgcolor: media ? 'primary.softBg' : 'neutral.softBg',
                      color: media ? 'primary.softColor' : 'neutral.softColor',
                    }}
                  >
                    <Icon />
                  </Box>
                  <Typography level="title-sm" sx={{ flex: 1, minWidth: 0 }} noWrap>
                    {suggestion.label}
                  </Typography>
                </Box>
                <Typography level="body-sm" textColor="text.secondary">
                  {suggestion.prompt}
                </Typography>
                {/* At the foot rather than beside the label, which it squeezed into an ellipsis. */}
                {suggestion.spendsCredits && (
                  <Typography
                    level="body-xs"
                    textColor="text.tertiary"
                    sx={{ mt: 'auto' }}
                    data-testid="chat-empty-credits-hint"
                  >
                    Uses credits
                  </Typography>
                )}
              </Box>
            </Box>
          );
        })}
      </Box>
    </BlankChatGreeting>
  );
});
