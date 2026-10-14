import type { ISearchFabFilesParams } from '@client/app/hooks/data/fabFiles';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { Button, IconButton, Tooltip } from '@mui/joy';
import { FC } from 'react';
import { useTranslation } from 'react-i18next';

type GeneratedFilterToggleProps = {
  active: boolean;
  onChange: (active: boolean) => void;
  /** Icon-only, for the mobile filter row. */
  compact?: boolean;
};

/** The search params with the Generated filter turned on or off; off drops the key instead of sending `false`. */
export const withGeneratedFilter = (
  params: ISearchFabFilesParams | undefined,
  generated: boolean
): ISearchFabFilesParams => ({ ...params, filters: { ...(params?.filters || {}), generated: generated || undefined } });

/**
 * Quick filter for files made by a generation tool. Sets `filters.generated`, which the server ANDs with the
 * selected tags (they match any of their names), so turning it on always narrows the list.
 */
export const GeneratedFilterToggle: FC<GeneratedFilterToggleProps> = ({ active, onChange, compact = false }) => {
  const { t } = useTranslation();
  const label = t('generated_filter.label');
  const shared = {
    onClick: () => onChange(!active),
    'aria-pressed': active,
    variant: active ? 'solid' : 'outlined',
    color: active ? 'primary' : 'neutral',
    'data-testid': 'file-browser-generated-filter-btn',
  } as const;

  if (compact) {
    return (
      <Tooltip title={label}>
        <IconButton {...shared} size="sm" aria-label={label}>
          <AutoAwesomeIcon />
        </IconButton>
      </Tooltip>
    );
  }
  return (
    <Button {...shared} size="sm" startDecorator={<AutoAwesomeIcon />} sx={{ height: 32, borderRadius: '6px' }}>
      {label}
    </Button>
  );
};

export default GeneratedFilterToggle;
