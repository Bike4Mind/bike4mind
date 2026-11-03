import type { SyntheticEvent } from 'react';

/** Joy closes a Dropdown on any MenuItem click unless the click says otherwise. */
export const keepMenuOpen = (event: SyntheticEvent) => {
  (event as SyntheticEvent & { defaultMuiPrevented?: boolean }).defaultMuiPrevented = true;
};
