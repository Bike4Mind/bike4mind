import { useState } from 'react';
import { styled } from '@mui/system';
import { Autocomplete, Button, IconButton, Option, Select, Stack, Typography } from '@mui/joy';
import CloseIcon from '@mui/icons-material/Close';
import { STUDIO_COMPOSITION_LIMITS, type StudioBrandKit, type StudioCompositionResponse } from '@bike4mind/common';
import { useStudioCompositions } from '@client/app/hooks/data/studioCompositions';
import { StudioPanel, StudioSectionLabel } from '../design/StudioPanel';
import { studioColor, studioRadius } from '../design/studioTokens';
import FieldSaveStatus from './FieldSaveStatus';
import LibraryThumb from './LibraryThumb';
import { useFieldAutosave } from './useFieldAutosave';
import { useLibraryPicker } from './useLibraryPicker';

// Families both the browser preview and the render job can load; anything else falls back to sans-serif.
const FONT_SUGGESTIONS = ['Inter', 'Roboto', 'Montserrat', 'Playfair Display', 'Lora', 'Oswald', 'Poppins'];
const DEFAULT_NEW_COLOR = '#0B6BCB';

const Swatch = styled('span')({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  padding: '2px 4px 2px 2px',
  borderRadius: studioRadius('md'),
  border: `1px solid ${studioColor('hairline')}`,
  fontSize: '12px',
  fontVariantNumeric: 'tabular-nums',
  '& > i': { width: '20px', height: '20px', borderRadius: '4px', display: 'block' },
});

const ColorInput = styled('input')({
  width: '32px',
  height: '28px',
  padding: 0,
  border: `1px solid ${studioColor('border')}`,
  borderRadius: studioRadius('sm'),
  background: 'transparent',
  cursor: 'pointer',
});

const hasContent = (kit: StudioBrandKit) =>
  Boolean(kit.logoFileId || kit.fontFamily || kit.colors.length > 0 || kit.productFileIds.length > 0);

/**
 * The production's brand kit: logo, colors, font and product reference images, all Library files by id. A kit is
 * reused by copying it from another of the user's productions.
 */
const BrandKitPanel = ({ composition }: { composition: StudioCompositionResponse }) => {
  const { value: kit, set, status } = useFieldAutosave(composition.id, 'brandKit', composition.brandKit);
  const { pick, picker } = useLibraryPicker();
  const [newColor, setNewColor] = useState(DEFAULT_NEW_COLOR);

  const patch = (changes: Partial<StudioBrandKit>) => set(current => ({ ...current, ...changes }));

  const pickLogo = () =>
    pick({
      filter: { mode: 'locked', type: 'image' },
      onPicked: ([file]) => file && patch({ logoFileId: file.id }),
    });

  const pickProducts = () =>
    pick({
      filter: { mode: 'initial', type: 'image' },
      onPicked: files =>
        set(current => {
          const added = files.map(file => file.id).filter(id => !current.productFileIds.includes(id));
          return {
            ...current,
            productFileIds: [...current.productFileIds, ...added].slice(
              0,
              STUDIO_COMPOSITION_LIMITS.brandProductFilesMax
            ),
          };
        }),
    });

  const addColor = () => {
    const color = newColor.toUpperCase();
    set(current =>
      current.colors.some(existing => existing.toUpperCase() === color) ||
      current.colors.length >= STUDIO_COMPOSITION_LIMITS.brandColorsMax
        ? current
        : { ...current, colors: [...current.colors, color] }
    );
  };

  return (
    <StudioPanel testId="production-brand-kit-panel" aria-label="Brand kit">
      <Stack direction="row" alignItems="center" spacing={1}>
        <StudioSectionLabel>Brand kit</StudioSectionLabel>
        <FieldSaveStatus status={status} testId="production-brand-kit-save-status" />
      </Stack>
      <CopyKitFrom compositionId={composition.id} onCopy={source => set(source)} />

      <Stack spacing={0.5}>
        <StudioSectionLabel>Logo</StudioSectionLabel>
        <Stack direction="row" spacing={1} alignItems="center">
          {kit.logoFileId && (
            <LibraryThumb
              fileId={kit.logoFileId}
              testId="production-brand-kit-logo"
              onRemove={() => set(({ logoFileId: _removed, ...rest }) => rest)}
            />
          )}
          <Button size="sm" variant="outlined" onClick={pickLogo} data-testid="production-brand-kit-logo-btn">
            {kit.logoFileId ? 'Replace' : 'Choose from Library'}
          </Button>
        </Stack>
      </Stack>

      <Stack spacing={0.5}>
        <StudioSectionLabel>Colors</StudioSectionLabel>
        <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
          {kit.colors.map(color => (
            <Swatch key={color} data-testid={`production-brand-kit-color-${color.slice(1)}`}>
              <i style={{ background: color }} />
              {color}
              <IconButton
                size="sm"
                variant="plain"
                aria-label={`Remove ${color}`}
                data-testid={`production-brand-kit-color-${color.slice(1)}-remove-btn`}
                onClick={() =>
                  set(current => ({ ...current, colors: current.colors.filter(candidate => candidate !== color) }))
                }
                sx={{ '--IconButton-size': '20px' }}
              >
                <CloseIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Swatch>
          ))}
          {kit.colors.length < STUDIO_COMPOSITION_LIMITS.brandColorsMax && (
            <>
              <ColorInput
                type="color"
                aria-label="New brand color"
                value={newColor}
                onChange={event => setNewColor(event.target.value)}
                data-testid="production-brand-kit-color-input"
              />
              <Button size="sm" variant="plain" onClick={addColor} data-testid="production-brand-kit-color-add-btn">
                Add color
              </Button>
            </>
          )}
        </Stack>
      </Stack>

      <Stack spacing={0.5}>
        <StudioSectionLabel htmlFor="production-brand-kit-font">Font</StudioSectionLabel>
        <Autocomplete
          size="sm"
          freeSolo
          id="production-brand-kit-font"
          placeholder="Inter"
          options={FONT_SUGGESTIONS}
          value={kit.fontFamily ?? null}
          onChange={(_, value) => patch({ fontFamily: value?.trim() || undefined })}
          onInputChange={(_, value, reason) => reason === 'input' && patch({ fontFamily: value.trim() || undefined })}
          slotProps={{ input: { maxLength: 100, 'data-testid': 'production-brand-kit-font-input' } }}
        />
      </Stack>

      <Stack spacing={0.5}>
        <StudioSectionLabel>Product references</StudioSectionLabel>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          {kit.productFileIds.map(fileId => (
            <LibraryThumb
              key={fileId}
              fileId={fileId}
              size={56}
              testId={`production-brand-kit-product-${fileId}`}
              onRemove={() =>
                set(current => ({ ...current, productFileIds: current.productFileIds.filter(id => id !== fileId) }))
              }
            />
          ))}
          {kit.productFileIds.length < STUDIO_COMPOSITION_LIMITS.brandProductFilesMax && (
            <Button size="sm" variant="outlined" onClick={pickProducts} data-testid="production-brand-kit-products-btn">
              Add from Library
            </Button>
          )}
        </Stack>
      </Stack>
      {picker}
    </StudioPanel>
  );
};

/** Copies the kit of another of the user's productions over this one. Hidden until there is one to copy. */
const CopyKitFrom = ({ compositionId, onCopy }: { compositionId: string; onCopy: (kit: StudioBrandKit) => void }) => {
  const compositions = useStudioCompositions();
  const sources = (compositions.data ?? []).filter(row => row.id !== compositionId && hasContent(row.brandKit));
  if (sources.length === 0) return null;
  return (
    <Stack direction="row" spacing={1} alignItems="center">
      <Typography level="body-xs">Reuse a kit:</Typography>
      <Select
        size="sm"
        placeholder="Copy from a production"
        value={null}
        onChange={(_, sourceId) => {
          const source = sources.find(row => row.id === sourceId);
          if (source) onCopy(source.brandKit);
        }}
        data-testid="production-brand-kit-copy-select"
        sx={{ minWidth: '200px' }}
      >
        {sources.map(row => (
          <Option key={row.id} value={row.id}>
            {row.title}
          </Option>
        ))}
      </Select>
    </Stack>
  );
};

export default BrandKitPanel;
