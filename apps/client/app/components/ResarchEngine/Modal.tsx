import { Button, Tooltip } from '@mui/joy';
import { FC, useState } from 'react';
import ResearchAgentModal from '../ResearchAgent/Modal';
import EditNoteIcon from '@mui/icons-material/EditNote';
import { useTranslation } from 'react-i18next';

interface ResearchEngineModalButtonProps {
  disabled?: boolean;
  variant?: 'solid' | 'outlined' | 'plain';
  color?: 'primary' | 'neutral' | 'danger' | 'success' | 'warning';
  size?: 'sm' | 'md' | 'lg';
  sx?: any;
}

const ResearchEngineModal: FC<ResearchEngineModalButtonProps> = ({
  disabled = false,
  variant = 'outlined',
  color = 'neutral',
  size = 'md',
  sx = {},
}) => {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation();

  return (
    <>
      <Tooltip title={t('file_browser.open_research')} placement="top">
        <span>
          <Button
            variant={variant}
            color={color}
            size={size}
            onClick={() => setOpen(true)}
            disabled={disabled}
            startDecorator={<EditNoteIcon sx={{ fontSize: 16 }} />}
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '6px 30px',
              '@media (max-width: 600px)': {
                width: '100%',
              },
              borderRadius: '6px',
              border: '1px solid',
              borderColor: 'fileBrowser.selectAll.borderColor',
              bgcolor: theme => (theme.palette.mode === 'light' ? 'white' : 'transparent'),
              minHeight: '32px',
              height: '32px',

              // text style
              color: 'text.primary',
              fontSize: '14px',
              fontWeight: '400',
              lineHeight: '150%',
              letterSpacing: '1px',
              ...sx,
            }}
          >
            {t('file_browser.research')}
          </Button>
        </span>
      </Tooltip>

      <ResearchAgentModal open={open} onClose={() => setOpen(false)} />
    </>
  );
};

export default ResearchEngineModal;
