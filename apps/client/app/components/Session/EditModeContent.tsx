import { Box, Button, Textarea } from '@mui/joy';
import { FC, useState } from 'react';

export interface EditModeContentProps {
  content: string;
  onCancel: () => void;
  onEdit: (newContent: string) => void;
}

const EditModeContent: FC<EditModeContentProps> = ({ content, onCancel, onEdit }) => {
  const [newContent, setNewContent] = useState(content);

  const buttonConfigs = [
    {
      label: 'Cancel',
      onClick: onCancel,
      variant: 'outlined' as const,
      sx: {
        borderColor: 'neutral.outlinedBorder',
        color: 'neutral.plainColor',
        bgcolor: 'background.level1',
      },
    },
    {
      label: 'Copy',
      onClick: () => navigator.clipboard.writeText(newContent),
      variant: 'outlined' as const,
      sx: {
        borderColor: 'neutral.outlinedBorder',
        color: 'neutral.plainColor',
        bgcolor: 'background.level1',
      },
    },
    {
      label: 'Send',
      onClick: () => onEdit(newContent),
      variant: 'solid' as const,
    },
  ];

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        width: '100%',
        padding: 2,
        backgroundColor: 'background.panel',
        borderRadius: '8px',
      }}
    >
      <Box sx={{ display: 'flex', gap: 1, width: '100%' }}>
        <Textarea
          value={newContent}
          onChange={e => setNewContent(e.target.value)}
          autoFocus
          minRows={3}
          sx={{
            flex: 1,
            backgroundColor: 'background.body',
            borderRadius: '8px',
            padding: 1,
          }}
        />
      </Box>
      <Box
        sx={{
          display: 'flex',
          gap: 1,
          justifyContent: 'flex-end',
        }}
      >
        {buttonConfigs.map((btn, index) => (
          <Button key={index} onClick={btn.onClick} variant={btn.variant} size="md" sx={btn.sx}>
            {btn.label}
          </Button>
        ))}
      </Box>
    </Box>
  );
};

export default EditModeContent;
