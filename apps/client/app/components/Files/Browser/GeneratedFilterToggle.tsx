import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { Button, IconButton, Tooltip } from '@mui/joy';
import { FC } from 'react';

// Must stay in sync with the tag saveGeneratedAsset (b4m-core/services/src/generatedAssets) puts on every
// generated file. The tag filter matches names case-insensitively, so this does too.
export const GENERATED_TAG = 'generated';

const isGeneratedTag = (tag: string): boolean => tag.toLowerCase() === GENERATED_TAG;

export const toggleGeneratedTag = (tags: readonly string[]): string[] =>
  tags.some(isGeneratedTag) ? tags.filter(tag => !isGeneratedTag(tag)) : [...tags, GENERATED_TAG];

type GeneratedFilterToggleProps = {
  tags: readonly string[] | undefined;
  onTagsChange: (tags: string[]) => void;
  /** Icon-only, for the mobile filter row. */
  compact?: boolean;
};

/** Quick filter for files made by a generation tool: a shortcut for selecting the `generated` tag. */
export const GeneratedFilterToggle: FC<GeneratedFilterToggleProps> = ({ tags = [], onTagsChange, compact = false }) => {
  const active = tags.some(isGeneratedTag);
  const toggle = () => onTagsChange(toggleGeneratedTag(tags));
  const shared = {
    onClick: toggle,
    'aria-pressed': active,
    variant: active ? 'solid' : 'outlined',
    color: active ? 'primary' : 'neutral',
    'data-testid': 'file-browser-generated-filter-btn',
  } as const;

  if (compact) {
    return (
      <Tooltip title="Generated">
        <IconButton {...shared} size="sm" aria-label="Generated">
          <AutoAwesomeIcon />
        </IconButton>
      </Tooltip>
    );
  }
  return (
    <Button {...shared} size="sm" startDecorator={<AutoAwesomeIcon />} sx={{ height: 32, borderRadius: '6px' }}>
      Generated
    </Button>
  );
};

export default GeneratedFilterToggle;
