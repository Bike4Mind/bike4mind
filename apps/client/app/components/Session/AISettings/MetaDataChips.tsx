import { ChipVariant, getChipStyles } from '@client/app/utils/aiSettingsUtils';
import { green } from '@client/app/utils/themes/colors';
import { Chip, Tooltip, Box } from '@mui/joy';
import { Star as StarIcon } from '@mui/icons-material';

interface MetadataChipProps {
  label: string;
  mode: 'dark' | 'light';
  startDecorator?: React.ReactNode;
  tooltip?: string;
  variant?: ChipVariant;
  isMaximum?: boolean;
  /**
   * Renders a square icon-only chip: `icon` replaces the visible text and `label`
   * becomes the accessible name. Passed as a child rather than a decorator, since
   * Joy gives decorators a negative `--Icon-margin` that would knock it off-centre.
   */
  icon?: React.ReactNode;
}

const MetadataChip: React.FC<MetadataChipProps> = ({
  label,
  mode,
  startDecorator,
  tooltip,
  variant = 'default',
  isMaximum,
  icon,
}) => {
  const chipContent = (
    <Chip
      size="sm"
      aria-label={icon ? label : undefined}
      startDecorator={
        icon ? undefined : isMaximum ? (
          <Box style={{ display: 'flex', alignItems: 'center' }}>
            <Box
              style={{
                position: 'absolute',
                top: -4,
                left: -4,
                zIndex: 1,
                backgroundColor: green[850],
                borderRadius: '50%',
                width: '16px',
                height: '16px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                pointerEvents: 'none',
              }}
            >
              <StarIcon style={{ fontSize: 12, color: 'white', marginLeft: '0.5px' }} />
            </Box>
            {startDecorator}
          </Box>
        ) : (
          startDecorator
        )
      }
      sx={{
        ...getChipStyles(variant, isMaximum ?? false, mode, label),
        // Square out the chip: getChipStyles' 12px inline padding is sized for a text label.
        ...(icon && {
          padding: 0,
          width: '32px',
          minWidth: '32px',
          height: '32px',
          minHeight: '32px',
          // Joy's label slot is `inline-block; flex-grow: 1`, so it fills the chip and lays
          // the glyph out inline - left-aligned and on the text baseline. Centring has to
          // happen inside the label; the root's justify-content can't reach it.
          '& .MuiChip-label': {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          },
        }),
      }}
    >
      {icon ?? label}
    </Chip>
  );

  return tooltip ? (
    <Tooltip title={tooltip} placement="top">
      <Box>{chipContent}</Box>
    </Tooltip>
  ) : (
    chipContent
  );
};

export default MetadataChip;
