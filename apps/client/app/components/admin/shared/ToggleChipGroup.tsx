import { Box } from '@mui/joy';
import { adminFocusScope } from './adminStyles';
import type { SegmentedOption } from './SegmentedControl';

type ToggleChipGroupProps<T extends string> = {
  options: readonly SegmentedOption<T>[];
  /** The selected values; every option selected reads as "All". */
  value: readonly T[];
  onChange: (value: T[]) => void;
  allLabel?: string;
  'aria-label': string;
  /** Each button gets `<id>-<value>`, and the All button `<id>-all`. */
  'data-testid': string;
};

/**
 * A multi-select filter on the SegmentedControl track. From "All", picking an option narrows to it;
 * after that options toggle, and clearing the last one returns to All, so the set is never empty.
 */
export function toggleChipSelection<T extends string>(all: readonly T[], selected: readonly T[], option: T): T[] {
  if (selected.length === all.length) return [option];
  const next = selected.includes(option) ? selected.filter(value => value !== option) : [...selected, option];
  return next.length === 0 ? [...all] : all.filter(value => next.includes(value));
}

export function ToggleChipGroup<T extends string>({
  options,
  value,
  onChange,
  allLabel = 'All',
  'aria-label': ariaLabel,
  'data-testid': testId,
}: ToggleChipGroupProps<T>) {
  const all = options.map(option => option.value);
  const isAll = all.every(option => value.includes(option));
  const buttons = [
    { key: 'all', label: allLabel, pressed: isAll, onClick: () => onChange([...all]) },
    ...options.map(option => ({
      key: option.value,
      label: option.label,
      pressed: !isAll && value.includes(option.value),
      onClick: () => onChange(toggleChipSelection(all, isAll ? all : value, option.value)),
    })),
  ];
  return (
    <Box
      role="group"
      aria-label={ariaLabel}
      data-testid={testId}
      sx={{
        ...adminFocusScope,
        display: 'inline-flex',
        flexWrap: 'wrap',
        alignSelf: 'flex-start',
        gap: '2px',
        p: '3px',
        borderRadius: '10px',
        bgcolor: 'admin.hover',
      }}
    >
      {buttons.map(button => (
        <Box
          key={button.key}
          component="button"
          type="button"
          aria-pressed={button.pressed}
          onClick={button.onClick}
          data-testid={`${testId}-${button.key}`}
          sx={{
            height: { xs: 44, md: 36 },
            px: 1.75,
            border: 0,
            borderRadius: '8px',
            font: 'inherit',
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
            bgcolor: button.pressed ? 'admin.surface' : 'transparent',
            color: button.pressed ? 'admin.ink' : 'admin.inkSecondary',
            boxShadow: button.pressed ? '0 1px 2px rgba(0, 0, 0, 0.08)' : 'none',
            '&:hover': { color: 'admin.ink' },
          }}
        >
          {button.label}
        </Box>
      ))}
    </Box>
  );
}
