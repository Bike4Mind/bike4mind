import { Box } from '@mui/joy';
import { green } from '../../utils/themes/colors';

interface CountBadgeProps {
  count: number;
  /** Custom color for the badge (default: green[800]) */
  color?: string;
  /** Custom background color opacity (default: '1A' for 10% opacity) */
  backgroundOpacity?: string;
  /** Custom border opacity (default: 'BF' for 75% opacity) */
  borderOpacity?: string;
  /** Font size for the count text (default: '13px') */
  fontSize?: string;
  /** Font weight for the count text (default: '500') */
  fontWeight?: string;
  /** Width of the badge (default: '30px') */
  width?: string;
  /** Minimum width of the badge (default: '30px') */
  minWidth?: string;
  /** Border radius (default: '2px') */
  borderRadius?: string;
  /** Custom margin (default: '0px 4px 0 0px') */
  margin?: string | object;
  /** Prefix text before the count (default: '+') */
  prefix?: string;
  /** Custom styling override */
  sx?: object;
}

const CountBadge = ({
  count,
  color = green[800],
  backgroundOpacity = '1A',
  borderOpacity = 'BF',
  fontSize = '13px',
  fontWeight = '500',
  width = '30px',
  minWidth = '30px',
  borderRadius = '2px',
  margin = '0px 4px 0 0px',
  prefix = '+',
  sx = {},
}: CountBadgeProps) => {
  if (count === 0) return null;

  return (
    <Box
      className="count-badge"
      sx={{
        backgroundColor: `${color}${backgroundOpacity}`,
        color: color,
        borderRadius: borderRadius,
        border: `1px solid ${color}${borderOpacity}`,
        fontSize: fontSize,
        fontWeight: fontWeight,
        width: width,
        minWidth: minWidth,
        height: '20px', // Fixed height for consistent alignment
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        ...(typeof margin === 'string' ? { m: margin } : margin),
        ...sx,
      }}
    >
      {prefix}
      {count}
    </Box>
  );
};

export default CountBadge;
