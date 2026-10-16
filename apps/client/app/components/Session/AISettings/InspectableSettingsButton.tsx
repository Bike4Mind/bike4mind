import SettingsIcon from '@mui/icons-material/SettingsOutlined';
import { IconButton, Tooltip, Typography } from '@mui/joy';
import { FC } from 'react';
import { toolbarIconSx } from '@client/app/components/Session/toolbarIconSx';

interface InspectableSettingsButtonProps {
  onClick: () => void;
  modelName?: string;
  buttonSx?: any;
  hideModelName?: boolean;
  /** Phones: the model is the only control in the row, so the button takes the free width and
   *  the name ellipsizes instead of the row scrolling sideways. */
  fluid?: boolean;
}

const InspectableSettingsButton: FC<InspectableSettingsButtonProps> = ({
  onClick,
  modelName,
  buttonSx = {},
  hideModelName = false,
  fluid = false,
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
          // Elsewhere the row collapses to icons when it runs out of room (useOverflowCompact), so
          // the button holds its width rather than letting flex squeeze the label to one character.
          flexShrink: fluid ? 1 : 0,
          ...(fluid && { minWidth: 0, maxWidth: '100%' }),
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
              display: 'block',
              fontWeight: '400',
              fontSize: '13px',
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
