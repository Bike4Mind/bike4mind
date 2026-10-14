/**
 * The composer's voice status pill: animated label + green mini equalizer, shared by dictation
 * (VoiceRecordButton, where the pill also cancels) and the Voice v2 call (ConversationalVoiceButton,
 * where it is display only). Keep the two looking the same.
 */

import { Box, useTheme } from '@mui/joy';
import { keyframes } from '@mui/system';
import { forwardRef, type ReactNode } from 'react';
import { grayAlpha, green } from '@client/app/utils/themes/colors';

export const fadeIn = keyframes`
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
`;

const letterWave = keyframes`
  0% { opacity: 1; }
  100% { opacity: 0.5; }
`;

/** Renders each character with a staggered opacity wave animation. */
export const AnimatedText: React.FC<{ text: string; color: string }> = ({ text, color }) => (
  <Box component="span" sx={{ display: 'inline-flex', flexShrink: 0, fontSize: 'var(--joy-fontSize-xs)', color }}>
    {text.split('').map((char, i) => (
      <Box
        key={i}
        component="span"
        sx={{
          animation: `${letterWave} 0.75s infinite alternate`,
          animationDelay: `${i * 0.1}s`,
        }}
      >
        {char}
      </Box>
    ))}
  </Box>
);

const BAR_COUNT = 16;
// The 7 of the 16 bands the mini equalizer draws.
const SHOWN_BARS = [0, 2, 5, 7, 10, 12, 14];

/** 0..1 levels for 16 equal bands of an analyser's byte frequency data (see useAudioAnalyzer). */
export const frequencyBars = (data: Uint8Array): number[] => {
  const width = Math.floor(data.length / BAR_COUNT);
  if (width === 0) return new Array(BAR_COUNT).fill(0);
  return Array.from({ length: BAR_COUNT }, (_, i) => {
    let sum = 0;
    for (let j = i * width; j < (i + 1) * width; j++) sum += data[j];
    return Math.min(sum / (width * 255), 1);
  });
};

/** `bars` are the 16 bands from frequencyBars / useAudioAnalyzer; flat and dimmed while silent. */
export const MiniEqualizer: React.FC<{ bars: number[]; isActive: boolean }> = ({ bars, isActive }) => (
  <Box
    sx={{
      display: 'flex',
      alignItems: 'flex-end',
      justifyContent: 'center',
      gap: '2px',
      width: '28px',
      height: '20px',
      flexShrink: 0,
    }}
    data-testid="voice-record-equalizer"
  >
    {SHOWN_BARS.map(i => (
      <Box
        key={i}
        sx={{
          width: '3px',
          borderRadius: '1.5px',
          backgroundColor: green[500],
          height: isActive ? `${Math.max(3, Math.round((bars[i] ?? 0) * 20))}px` : '6px',
          transition: 'height 0.06s ease-out',
          opacity: isActive ? 1 : 0.5,
        }}
      />
    ))}
  </Box>
);

interface VoiceStatusPillProps {
  label: string;
  bars: number[];
  isActive: boolean;
  /** Makes the pill clickable (dictation cancels through it). */
  onClick?: () => void;
  /** e.g. a cancel icon after the equalizer. */
  endDecorator?: ReactNode;
  /**
   * Fill the toolbar row's free space (SessionToolbar hides the model, Tools and Agents meanwhile),
   * so the row keeps its width; the end decorator moves to the far right.
   */
  stretch?: boolean;
  'data-testid'?: string;
}

// forwardRef: dictation wraps the pill in a Tooltip, which needs a ref on its child.
export const VoiceStatusPill = forwardRef<HTMLDivElement, VoiceStatusPillProps>(function VoiceStatusPill(
  { label, bars, isActive, onClick, endDecorator, stretch = false, 'data-testid': testId, ...rest },
  ref
) {
  const theme = useTheme();
  const background = theme.palette.mode === 'dark' ? theme.palette.border.solid : grayAlpha[150][20];
  return (
    <Box
      ref={ref}
      {...rest}
      onClick={onClick}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        padding: endDecorator ? '4px 8px 4px 10px' : '4px 10px',
        minHeight: '32px',
        borderRadius: '6px',
        backgroundColor: background,
        animation: `${fadeIn} 0.2s ease-out`,
        ...(stretch && { flex: '1 1 auto', minWidth: 0 }),
        ...(onClick && {
          cursor: 'pointer',
          '&:hover': {
            backgroundColor: theme.palette.mode === 'dark' ? '#363B40' : grayAlpha[150][30],
          },
        }),
      }}
      data-testid={testId}
    >
      <AnimatedText text={label} color={theme.palette.text.tertiary} />
      <MiniEqualizer bars={bars} isActive={isActive} />
      {endDecorator && (stretch ? <Box sx={{ ml: 'auto', display: 'flex' }}>{endDecorator}</Box> : endDecorator)}
    </Box>
  );
});
