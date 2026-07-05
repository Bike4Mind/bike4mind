import { brandAlpha } from '../colors';

// Custom values with unique opacity not in theme defaults
export const profileTheme = {
  dark: {
    border: `1px solid ${brandAlpha[100][12]}`, // Unified: was used in activityFeed, friendRow, collection
  },
  light: {
    border: `1px solid ${brandAlpha[100][50]}`, // Unified: was used in activityFeed, friendRow, collection
  },
};
