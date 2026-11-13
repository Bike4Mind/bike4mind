import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { styled } from '@mui/system';
import { STUDIO_FOCUS_VISIBLE, studioColor, studioFont, studioRadius } from './studioTokens';

const Track = styled('div')({
  display: 'inline-flex',
  gap: '4px',
  padding: '4px',
  maxWidth: '100%',
  overflowX: 'auto',
  scrollbarWidth: 'none',
  borderRadius: studioRadius('md'),
  border: `1px solid ${studioColor('hairline')}`,
  backgroundColor: studioColor('raised'),
});

const Segment = styled('button')({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '8px',
  height: '30px',
  padding: '0 14px',
  borderRadius: studioRadius('sm'),
  border: '1px solid transparent',
  backgroundColor: 'transparent',
  color: studioColor('text-secondary'),
  font: `500 13px/1 ${studioFont('ui')}`,
  whiteSpace: 'nowrap',
  cursor: 'pointer',
  transition: 'background-color 120ms ease, color 120ms ease',
  '&:hover': { color: studioColor('text') },
  '&:focus-visible': STUDIO_FOCUS_VISIBLE,
  '&[data-selected="true"]': {
    backgroundColor: studioColor('selected'),
    borderColor: studioColor('border-strong'),
    color: studioColor('text'),
  },
  '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
});

export type StudioSegmentOption<Value extends string> = {
  value: Value;
  label: ReactNode;
  testId?: string;
};

type StudioSegmentedControlProps<Value extends string> = {
  options: readonly StudioSegmentOption<Value>[];
  value: Value;
  onChange: (value: Value) => void;
  'aria-label': string;
  /** `tabs` for switching views (role=tab, aria-selected); `radio` for picking a value (role=radio, aria-checked). */
  semantics?: 'tabs' | 'radio';
  testId?: string;
};

const NEXT_KEYS: Record<string, 1 | -1> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

const focusedIndex = (segments: (HTMLButtonElement | null)[], fallback: number): number => {
  const index = segments.findIndex(segment => segment !== null && segment === document.activeElement);
  return index === -1 ? fallback : index;
};

/**
 * A pill track of mutually exclusive options with a roving tabindex. As radios, arrows select (the
 * radio-group pattern); as tabs, arrows and Home/End only move focus and Enter/Space activates,
 * because activating a tab here navigates.
 */
const StudioSegmentedControl = <Value extends string>({
  options,
  value,
  onChange,
  'aria-label': ariaLabel,
  semantics = 'radio',
  testId = 'studio-segmented-control',
}: StudioSegmentedControlProps<Value>) => {
  const segmentRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const isTabs = semantics === 'tabs';

  const targetIndex = (key: string): number | null => {
    const count = options.length;
    if (count === 0) return null;
    if (isTabs && key === 'Home') return 0;
    if (isTabs && key === 'End') return count - 1;
    const step = NEXT_KEYS[key];
    if (!step) return null;
    const selected = Math.max(
      0,
      options.findIndex(option => option.value === value)
    );
    const from = isTabs ? focusedIndex(segmentRefs.current, selected) : selected;
    return (from + step + count) % count;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = targetIndex(event.key);
    if (next === null) return;
    event.preventDefault();
    if (!isTabs) onChange(options[next].value);
    segmentRefs.current[next]?.focus();
  };

  return (
    <Track role={isTabs ? 'tablist' : 'radiogroup'} aria-label={ariaLabel} onKeyDown={onKeyDown} data-testid={testId}>
      {options.map((option, index) => {
        const isSelected = option.value === value;
        return (
          <Segment
            key={option.value}
            ref={element => {
              segmentRefs.current[index] = element;
            }}
            type="button"
            role={isTabs ? 'tab' : 'radio'}
            aria-selected={isTabs ? isSelected : undefined}
            aria-checked={isTabs ? undefined : isSelected}
            tabIndex={isSelected ? 0 : -1}
            data-selected={isSelected}
            onClick={() => {
              if (!isSelected) onChange(option.value);
            }}
            data-testid={option.testId ?? `${testId}-${option.value}`}
          >
            {option.label}
          </Segment>
        );
      })}
    </Track>
  );
};

export default StudioSegmentedControl;
