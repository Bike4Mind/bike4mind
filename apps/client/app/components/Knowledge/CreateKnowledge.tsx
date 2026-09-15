import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import { Button, Tooltip } from '@mui/joy';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useKnowledgeModal } from './KnowledgeModal';
import { useShallow } from 'zustand/react/shallow';

interface CreateKnowledgeProps {
  disabled?: boolean;
  variant?: 'solid' | 'outlined' | 'plain';
  color?: 'primary' | 'neutral' | 'danger' | 'success' | 'warning';
  size?: 'sm' | 'md' | 'lg';
  sx?: any;
  className?: string;
}

const CreateKnowledge: React.FC<CreateKnowledgeProps> = ({
  disabled = false,
  variant = 'outlined',
  color = 'neutral',
  size = 'md',
  sx = {},
}) => {
  const { t } = useTranslation();
  const [setOpen, setSelectedFabFileId, setViewOnly] = useKnowledgeModal(
    useShallow(state => [state.setOpen, state.setSelectedFabFileId, state.setViewOnly] as const)
  );

  const handleCreateNewKnowledge = () => {
    setSelectedFabFileId(null);
    setViewOnly(false);
    setOpen(true);
  };

  return (
    <Tooltip title={t('file_browser.create_new_knowledge')} placement="top">
      <Button
        variant={variant}
        color={color}
        size={size}
        onClick={handleCreateNewKnowledge}
        disabled={disabled}
        startDecorator={<AutoFixHighIcon sx={{ width: '20px', height: '20px' }} />}
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '6px 30px',
          border: '1px solid',
          borderColor: 'fileBrowser.selectAll.borderColor',
          bgcolor: 'transparent',
          '@media (max-width: 600px)': {
            width: '100%',
          },
          borderRadius: '6px',
          minHeight: '32px',
          height: '32px',

          // text style
          fontSize: '14px',
          fontWeight: '400',
          lineHeight: '150%',
          color: 'text.primary',
          letterSpacing: '1px',
          ...sx,
        }}
      >
        {t('file_browser.create_new_knowledge')}
      </Button>
    </Tooltip>
  );
};

export default CreateKnowledge;
