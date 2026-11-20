import { Box } from '@mui/joy';
import { adminFocusScope } from './adminStyles';

export type SegmentedOption<T extends string> = { value: T; label: string };

type SegmentedControlProps<T extends string> = {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  'aria-label': string;
  /** Each button gets `<id>-<value>`. */
  'data-testid': string;
};

/** A small set of mutually exclusive modes or filters: a group of toggle buttons on a `hover` track. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  'aria-label': ariaLabel,
  'data-testid': testId,
}: SegmentedControlProps<T>) {
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
      {options.map(option => {
        const selected = option.value === value;
        return (
          <Box
            key={option.value}
            component="button"
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            data-testid={`${testId}-${option.value}`}
            sx={{
              height: 32,
              px: 1.75,
              border: 0,
              borderRadius: '8px',
              font: 'inherit',
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
              bgcolor: selected ? 'admin.surface' : 'transparent',
              color: selected ? 'admin.ink' : 'admin.inkSecondary',
              boxShadow: selected ? '0 1px 2px rgba(0, 0, 0, 0.08)' : 'none',
              '&:hover': { color: 'admin.ink' },
            }}
          >
            {option.label}
          </Box>
        );
      })}
    </Box>
  );
}
