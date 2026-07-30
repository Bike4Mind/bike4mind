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
}

const MetadataChip: React.FC<MetadataChipProps> = ({
  label,
  mode,
  startDecorator,
  tooltip,
  variant = 'default',
  isMaximum,
}) => {
  const chipContent = (
    <Chip
      size="sm"
      startDecorator={
        isMaximum ? (
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
      sx={getChipStyles(variant, isMaximum ?? false, mode, label)}
    >
      {label}
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
