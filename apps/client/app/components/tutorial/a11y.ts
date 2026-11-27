import type { AriaAttributes } from 'react';

/** Accessibility attributes written by camel-cased names (`ariaLabel`) and rendered as the hyphenated attributes. */
export interface A11yProps {
  ariaLabel?: string;
  ariaLabelledby?: string;
  ariaHidden?: boolean | 'true' | 'false';
  ariaPressed?: boolean | 'true' | 'false';
  ariaExpanded?: boolean | 'true' | 'false';
  ariaSelected?: boolean | 'true' | 'false';
  ariaDisabled?: boolean | 'true' | 'false';
  ariaHaspopup?: boolean | 'menu' | 'listbox' | 'dialog' | 'true' | 'false';
  ariaModal?: boolean | 'true' | 'false';
}

/** The hyphenated attribute name for one camel-cased key: `ariaLabel` -> its `-label` attribute. */
export function a11yAttr(name: keyof A11yProps): string {
  return name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
}

/** Spreadable JSX props for `props`; keys left undefined are omitted. */
export function a11y(props: A11yProps): AriaAttributes {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) out[a11yAttr(key as keyof A11yProps)] = value;
  }
  return out as AriaAttributes;
}
