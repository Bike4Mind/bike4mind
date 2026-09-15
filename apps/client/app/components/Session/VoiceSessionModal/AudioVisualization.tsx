import { useAudioAnalyzer } from '@client/app/hooks/useAudioAnalyzer';
import { Box, useTheme } from '@mui/joy';
import { motion } from 'framer-motion';

interface AudioVisualizationProps {
  isActive: boolean;
  isUser: boolean;
  audioStream?: MediaStream | null;
}

const AudioVisualization: React.FC<AudioVisualizationProps> = ({ isActive, isUser, audioStream }) => {
  const theme = useTheme();

  // Use real audio data for both user and assistant
  const audioData = useAudioAnalyzer(audioStream || null);

  const getBarData = () => {
    if (audioStream) {
      return audioData.frequencyBars.map(bar => Math.max(bar * 0.8, 0.1));
    }
    return Array.from({ length: 16 }, () => 0.1);
  };

  const barData = getBarData();
  const visuallyActive = audioStream ? audioData.isActive : false;

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'end',
        justifyContent: 'center',
        gap: '3px',
        height: '50px',
        opacity: visuallyActive ? 1 : 0.4,
        transition: 'opacity 0.3s ease',
      }}
    >
      {barData.map((intensity, index) => (
        <motion.div
          key={index}
          animate={{
            height: visuallyActive ? `${8 + intensity * 32}px` : '6px',
            backgroundColor: isUser
              ? theme.palette.voiceModal.audioVisualization.user
              : theme.palette.voiceModal.audioVisualization.assistant,
          }}
          transition={{
            duration: 0.1,
            ease: 'easeOut',
          }}
          style={{
            width: '4px',
            minHeight: '6px',
            borderRadius: '2px',
            backgroundColor: isUser
              ? theme.palette.voiceModal.audioVisualization.user
              : theme.palette.voiceModal.audioVisualization.assistant,
            opacity: visuallyActive ? 0.8 + intensity * 0.2 : 0.5,
          }}
        />
      ))}
    </Box>
  );
};

export default AudioVisualization;
