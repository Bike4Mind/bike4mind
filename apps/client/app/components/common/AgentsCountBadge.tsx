import CountBadge from './CountBadge';
import { green } from '../../utils/themes/colors';

interface AgentsCountBadgeProps {
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
  /** Custom margin (default: { ml: 1 }) */
  margin?: string | object;
  /** Prefix text before the count (default: '+') */
  prefix?: string;
  /** Custom styling override */
  sx?: object;
}

const AgentsCountBadge = ({
  count,
  color = green[800],
  backgroundOpacity = '1A',
  borderOpacity = 'BF',
  fontSize = '13px',
  fontWeight = '500',
  borderRadius = '2px',
  margin = { ml: 1 },
  prefix = '',
  sx = {},
}: AgentsCountBadgeProps) => {
  return (
    <CountBadge
      count={count}
      color={color}
      backgroundOpacity={backgroundOpacity}
      borderOpacity={borderOpacity}
      fontSize={fontSize}
      fontWeight={fontWeight}
      borderRadius={borderRadius}
      margin={margin}
      prefix={prefix}
      sx={sx}
    />
  );
};

export default AgentsCountBadge;
