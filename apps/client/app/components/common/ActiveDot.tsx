import { Box } from '@mui/joy';
import { green } from '../../utils/themes/colors';

/**
 * Corner dot on a square toolbar button: something inside is switched on. Stands in for the
 * indicators and count badges a labelled button shows. The button needs `position: relative`.
 */
const ActiveDot = () => (
  <Box
    aria-hidden
    data-testid="active-dot"
    sx={{
      position: 'absolute',
      top: '4px',
      right: '4px',
      width: '6px',
      height: '6px',
      borderRadius: '50%',
      // Same green as the tool indicators and count badges.
      backgroundColor: green[800],
      pointerEvents: 'none',
    }}
  />
);

export default ActiveDot;
