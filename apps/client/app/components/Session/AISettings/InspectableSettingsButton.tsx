import SettingsIcon from '@mui/icons-material/SettingsOutlined';
import { IconButton, Tooltip, Typography } from '@mui/joy';
import { FC } from 'react';
import { toolbarIconSx } from '@client/app/components/Session/toolbarIconSx';

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
    // A hidden name moves into the tooltip, so the model stays one hover away.
    <Tooltip title={!showModelName && modelName ? `AI Settings - ${modelName}` : 'AI Settings'} placement="top">
      <IconButton
        data-testid="ai-settings-btn"
        variant="outlined"
        onClick={onClick}
        aria-label={modelName ? `AI Settings, model: ${modelName}` : 'AI Settings'}
        className="quick-model-preview-btn"
        sx={{
          display: 'flex',
          px: 1,
          border: '1px solid',
          borderColor: 'border.solid',
          borderRadius: '6px',
          width: 'auto',
          minWidth: '32px',
          // The composer row scrolls sideways, so the button holds its width rather than letting
          // flex squeeze the label down to a single character.
          flexShrink: 0,
          maxWidth: { xs: '200px', md: 'none' },
          height: '32px',
          minHeight: 'auto',
          py: 0,
          // Without the name it is a 32px square like the other icon buttons in the row.
          ...(!showModelName && { px: 0, width: '32px' }),
          ...buttonSx,

          '& svg': {
            m: 0,
          },
        }}
      >
        <SettingsIcon
          sx={[
            { fontSize: '16px', ml: { xs: 0, md: showModelName ? 0.5 : 0 } },
            toolbarIconSx('var(--joy-palette-text-primary)'),
          ]}
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
              // Wide enough to tell models apart, short enough to leave room for the other controls.
              maxWidth: { xs: '120px', md: 'none' },
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
