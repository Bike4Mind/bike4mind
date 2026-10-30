import { Box, Dropdown, IconButton, Menu, MenuButton, MenuItem } from '@mui/joy';
import CloseIcon from '@mui/icons-material/Close';
import { adminFocus } from './adminStyles';

export type FilterChipOption = { value: string; label: string };
type FilterChipValue =
  | { multiple?: false; value: string | undefined; onChange: (value: string | undefined) => void }
  /** Each pick toggles one value; the chip reads "Label: First +N". */
  | { multiple: true; value: readonly string[]; onChange: (value: string[]) => void };

/**
 * One list filter as a 30 px chip: dashed with just the label while unset, a solid selection-tinted
 * chip reading "Label: Value" with a remove button once set. Picking a value opens a menu.
 */
export function FilterChip(
  choice: {
    id: string;
    label: string;
    options: readonly FilterChipOption[];
  } & FilterChipValue
) {
  const { id, label, options } = choice;
  const values: readonly string[] = choice.multiple ? choice.value : choice.value === undefined ? [] : [choice.value];
  const labelOf = (value: string) => options.find(option => option.value === value)?.label ?? value;
  const isSet = values.length > 0;
  const summary = isSet ? labelOf(values[0]) + (values.length > 1 ? ` +${values.length - 1}` : '') : '';
  const pick = (value: string) => {
    if (!choice.multiple) return choice.onChange(value);
    choice.onChange(values.includes(value) ? values.filter(item => item !== value) : [...values, value]);
  };
  const clear = () => (choice.multiple ? choice.onChange([]) : choice.onChange(undefined));
  return (
    <Box
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 30,
        borderRadius: '999px',
        border: '1px',
        borderStyle: isSet ? 'solid' : 'dashed',
        borderColor: isSet ? 'admin.selection.border' : 'admin.borderStrong',
        bgcolor: isSet ? 'admin.selection.background' : 'transparent',
        color: isSet ? 'admin.selection.foreground' : 'admin.inkSecondary',
        flexShrink: 0,
      }}
    >
      <Dropdown>
        <MenuButton
          variant="plain"
          size="sm"
          data-testid={`admin-filter-${id}`}
          aria-label={isSet ? `${label}: ${summary}. Change filter` : `Filter by ${label}`}
          sx={{
            ...adminFocus,
            minHeight: 28,
            height: 28,
            px: 1.25,
            pr: isSet ? 0.5 : 1.25,
            borderRadius: '999px',
            fontSize: 13,
            fontWeight: 500,
            color: 'inherit',
            '&:hover': { bgcolor: isSet ? 'transparent' : 'admin.hover' },
          }}
        >
          {isSet ? (
            <>
              {label}:&nbsp;
              <Box component="span" sx={{ fontWeight: 600 }}>
                {summary}
              </Box>
            </>
          ) : (
            label
          )}
        </MenuButton>
        <Menu size="sm" placement="bottom-start" data-testid={`admin-filter-${id}-menu`} sx={{ zIndex: 1300 }}>
          {options.map(option => (
            <MenuItem
              key={option.value}
              selected={values.includes(option.value)}
              data-testid={`admin-filter-${id}-${option.value}`}
              onClick={() => pick(option.value)}
            >
              {option.label}
            </MenuItem>
          ))}
        </Menu>
      </Dropdown>
      {isSet && (
        <IconButton
          size="sm"
          variant="plain"
          aria-label={`Clear ${label}`}
          data-testid={`admin-filter-clear-${id}-btn`}
          onClick={clear}
          sx={{
            ...adminFocus,
            '--IconButton-size': '22px',
            minHeight: 22,
            minWidth: 22,
            mr: 0.5,
            borderRadius: '50%',
            color: 'inherit',
            '& svg': { fontSize: 14 },
          }}
        >
          <CloseIcon />
        </IconButton>
      )}
    </Box>
  );
}
