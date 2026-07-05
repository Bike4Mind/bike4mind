import { Settings as SettingsIcon } from '@mui/icons-material';
import { IconButton, Tooltip, Typography } from '@mui/joy';
import { FC } from 'react';

interface InspectableSettingsButtonProps {
  onClick: () => void;
  modelName?: string;
  buttonSx?: any;
  hideModelName?: boolean;
}

const InspectableSettingsButton: FC<InspectableSettingsButtonProps> = ({
  onClick,
  modelName,
  buttonSx = {},
  hideModelName = false,
}) => {
  const showModelName = !hideModelName && !!modelName;

  return (
    <Tooltip title="AI Settings" placement="top">
      <IconButton
        data-testid="ai-settings-btn"
        variant="outlined"
        onClick={onClick}
        className="quick-model-preview-btn"
        sx={{
          display: 'flex',
          px: 1,
          border: '1px solid',
          borderColor: 'border.solid',
          borderRadius: '6px',
          width: 'auto',
          minWidth: '32px',
          maxWidth: { xs: '200px', md: 'none' },
          height: '32px',
          minHeight: 'auto',
          py: 0,
          ...buttonSx,

          '& svg': {
            m: 0,
          },
        }}
      >
        <SettingsIcon
          sx={{
            fontSize: '14px',
            color: 'text.primary',
            ml: { xs: 0, md: showModelName ? 0.5 : 0 },
          }}
        />

        {showModelName && (
          <Typography
            level="body-sm"
            sx={{
              // Keep the model label visible on mobile too. The button's
              // `maxWidth: 200px` on xs plus the ellipsis rules below truncate it
              // gracefully instead of dropping it entirely.
              display: 'block',
              fontWeight: '400',
              fontSize: '14px',
              color: 'text.primary',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
              textAlign: 'center',
              minWidth: 0,
              ml: 1,
            }}
          >
            {modelName}
          </Typography>
        )}
      </IconButton>
    </Tooltip>
  );
};

export default InspectableSettingsButton;
