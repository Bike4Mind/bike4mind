import { useId, useRef, type ReactNode } from 'react';
import { styled } from '@mui/system';
import { formatCredits } from '@client/app/utils/formatUsd';
import type { AspectField, CapabilityControl, ChipsField, SegmentedField, TextField } from './capabilityFields';
import StudioChip from './design/StudioChip';
import { StudioPanel, StudioSectionLabel } from './design/StudioPanel';
import StudioPrimaryAction from './design/StudioPrimaryAction';
import StudioSegmentedControl from './design/StudioSegmentedControl';
import StudioThemeScope from './design/StudioThemeScope';
import { STUDIO_FOCUS_VISIBLE, STUDIO_MICRO_LABEL, studioColor, studioFont, studioRadius } from './design/studioTokens';
import { insertSnippet } from './insertSnippet';

/*
 * Create v2's take on CapabilityForm: the prompt box, scene chips, shape and choice tracks drawn with the Studio
 * primitives, and a side panel holding the model row, the cost and the primary action. Test ids match the legacy
 * controls in CapabilityForm.tsx, so a field's tests do not care which layout rendered it.
 */

// The side panel sits beside the fields once both fit; narrower, it follows them.
const TWO_COLUMNS = '@media (min-width: 1100px)';

const Layout = styled('div')({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr)',
  gap: '16px',
  alignItems: 'start',
  [TWO_COLUMNS]: { gridTemplateColumns: 'minmax(0, 1fr) 320px' },
});

const SidePanel = styled('div')({
  display: 'flex',
  flexDirection: 'column',
  gap: '16px',
  [TWO_COLUMNS]: { position: 'sticky', top: '16px' },
});

const FieldStack = styled('div')({ display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 });

const GroupRow = styled('div')({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '16px',
  '& > *': { flex: '1 1 200px' },
});

const PromptBox = styled('textarea')({
  width: '100%',
  boxSizing: 'border-box',
  padding: '12px 14px',
  borderRadius: studioRadius('md'),
  border: `1px solid ${studioColor('border')}`,
  backgroundColor: studioColor('raised'),
  color: studioColor('text-strong'),
  font: `400 15px/1.5 ${studioFont('ui')}`,
  resize: 'vertical',
  transition: 'border-color 120ms ease',
  '&::placeholder': { color: studioColor('text-muted') },
  '&:hover:not(:disabled)': { borderColor: studioColor('border-strong') },
  '&:focus-visible': { ...STUDIO_FOCUS_VISIBLE, outlineOffset: '0', borderColor: studioColor('accent-border') },
  '&:disabled': { opacity: 0.5, cursor: 'not-allowed' },
  '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
});

const Counter = styled('span')({
  alignSelf: 'flex-end',
  fontFamily: studioFont('mono'),
  fontSize: '11px',
  fontVariantNumeric: 'tabular-nums',
  color: studioColor('text-muted'),
});

const ChipRow = styled('div')({ display: 'flex', flexWrap: 'wrap', gap: '8px' });

const snippetSlug = (snippet: string): string =>
  snippet
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const StudioTextControl = ({ field, testId }: { field: TextField; testId: string }) => {
  const inputId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const insert = (snippet: string) => {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? field.value.length;
    const end = textarea?.selectionEnd ?? field.value.length;
    const next = insertSnippet(field.value, snippet, start, end);
    if (next.value.length > field.maxLength) return;
    field.onChange(next.value);
    // After React writes the new value, put the caret right after the inserted tag so typing continues there.
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(next.caret, next.caret);
    });
  };

  return (
    <FieldStack>
      <StudioSectionLabel htmlFor={inputId} testId={`${testId}-label`}>
        {field.label}
      </StudioSectionLabel>
      {field.snippets && field.snippets.length > 0 && (
        <ChipRow>
          {field.snippets.map(snippet => (
            <StudioChip
              key={snippet}
              disabled={field.disabled}
              onClick={() => insert(snippet)}
              testId={`${testId}-${snippetSlug(snippet)}-snippet-btn`}
            >
              {snippet}
            </StudioChip>
          ))}
        </ChipRow>
      )}
      <PromptBox
        id={inputId}
        ref={textareaRef}
        rows={field.minRows ?? 4}
        value={field.value}
        placeholder={field.placeholder}
        maxLength={field.maxLength}
        disabled={field.disabled}
        onChange={event => field.onChange(event.target.value)}
        data-testid={`${testId}-input`}
      />
      <Counter aria-hidden="true">
        {field.value.trim().length}/{field.maxLength}
      </Counter>
    </FieldStack>
  );
};

// Longest side of a shape glyph, in px; small enough to sit inside a segment beside its ratio.
const SHAPE_GLYPH_SIZE = 14;

const ShapeGlyph = styled('span')({
  display: 'inline-block',
  flexShrink: 0,
  border: '1.5px solid currentColor',
  borderRadius: '2px',
});

const shapeOf = (value: string): { width: number; height: number } => {
  const [width, height] = value.split(':').map(Number);
  if (!width || !height) return { width: SHAPE_GLYPH_SIZE, height: SHAPE_GLYPH_SIZE };
  const scale = SHAPE_GLYPH_SIZE / Math.max(width, height);
  return { width: Math.max(4, Math.round(width * scale)), height: Math.max(4, Math.round(height * scale)) };
};

// A track hugs its options rather than stretching across the panel.
const ChoiceStack = styled(FieldStack)({ alignItems: 'flex-start' });

const RatioText = styled('span')({ fontFamily: studioFont('mono'), fontSize: '12px' });

/** A segmented field, or the shape (aspect) field with each ratio drawn beside its label. */
const StudioChoiceControl = ({ field, testId }: { field: SegmentedField | AspectField; testId: string }) => (
  <ChoiceStack>
    <StudioSectionLabel testId={`${testId}-label`}>{field.label}</StudioSectionLabel>
    <StudioSegmentedControl
      aria-label={field.label}
      value={field.value}
      disabled={field.disabled}
      onChange={field.onChange}
      testId={`${testId}-toggle`}
      options={field.options.map(option => ({
        value: option.value,
        invalid: option.invalid,
        testId: `${testId}-${option.value}-btn`,
        label:
          field.kind === 'aspect' ? (
            <>
              <ShapeGlyph aria-hidden="true" style={shapeOf(option.value)} />
              <RatioText>{option.label}</RatioText>
            </>
          ) : (
            option.label
          ),
      }))}
    />
  </ChoiceStack>
);

const StudioChipsControl = ({ field, testId }: { field: ChipsField; testId: string }) => {
  const labelId = useId();
  return (
    <FieldStack role="group" aria-labelledby={labelId}>
      <StudioSectionLabel id={labelId} testId={`${testId}-label`}>
        {field.label}
      </StudioSectionLabel>
      <ChipRow data-testid={`${testId}-chips`}>
        {field.options.map(option => {
          const selected = option.value === field.value;
          return (
            <StudioChip
              key={option.value}
              selected={selected}
              disabled={field.disabled || option.disabled}
              swatch={option.swatch && `linear-gradient(135deg, ${option.swatch.from}, ${option.swatch.to})`}
              onClick={() => field.onChange(selected ? null : option.value)}
              testId={`${testId}-${option.value}-chip`}
            >
              {option.label}
            </StudioChip>
          );
        })}
      </ChipRow>
    </FieldStack>
  );
};

/** The Studio-drawn control for a field, or null to fall back to CapabilityForm's Joy control for its kind. */
export const studioControlFor = (field: CapabilityControl, testId: string): ReactNode => {
  switch (field.kind) {
    case 'text':
      return <StudioTextControl field={field} testId={testId} />;
    case 'segmented':
    case 'aspect':
      return <StudioChoiceControl field={field} testId={testId} />;
    case 'chips':
      return <StudioChipsControl field={field} testId={testId} />;
    default:
      return null;
  }
};

// The fields still drawn with Joy (select, slider, switch, image, references) take the Studio micro-label, so every
// section head in the panel reads the same. Joy's global class names are stable, unlike its generated ones.
export const StudioJoyField = styled('div')({
  '& .MuiFormLabel-root, & .MuiTypography-title-sm': { ...STUDIO_MICRO_LABEL, marginBottom: '8px' },
});

const ReasonRow = styled('div')({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '8px',
  marginTop: '6px',
  font: `400 12px/1.4 ${studioFont('ui')}`,
  color: studioColor('danger'),
});

const FixButton = styled('button')({
  padding: '2px 8px',
  borderRadius: studioRadius('xs'),
  border: `1px solid ${studioColor('danger-border')}`,
  backgroundColor: studioColor('danger-soft'),
  color: studioColor('danger'),
  font: `600 12px/1.4 ${studioFont('ui')}`,
  cursor: 'pointer',
  '&:focus-visible': STUDIO_FOCUS_VISIBLE,
});

/** The reason a kept value does not fit the model, with its one-click fix. */
export const StudioInvalidReason = ({ field, testId }: { field: CapabilityControl; testId: string }) => {
  if (field.invalidReason === undefined) return null;
  return (
    <ReasonRow>
      <span data-testid={`${testId}-invalid`}>{field.invalidReason}</span>
      {field.fix && (
        <FixButton type="button" onClick={field.fix.apply} data-testid={`${testId}-fix-btn`}>
          {field.fix.label}
        </FixButton>
      )}
    </ReasonRow>
  );
};

export const StudioFieldGroup = ({ children }: { children: ReactNode }) => <GroupRow>{children}</GroupRow>;

const Notices = styled('div')({
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  padding: '10px 12px',
  borderRadius: studioRadius('md'),
  border: `1px solid ${studioColor('warning-border')}`,
  backgroundColor: studioColor('warning-soft'),
  color: studioColor('warning'),
  font: `400 13px/1.45 ${studioFont('ui')}`,
});

const CostRow = styled('div')({
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '12px',
  paddingTop: '12px',
  borderTop: `1px solid ${studioColor('hairline')}`,
});

const CostValue = styled('span')({
  fontFamily: studioFont('mono'),
  fontSize: '14px',
  fontVariantNumeric: 'tabular-nums',
  color: studioColor('text-strong'),
  '&[data-unavailable="true"]': { fontSize: '12px', color: studioColor('text-muted') },
});

const ActionSlot = styled('div')({ display: 'flex', '& > button': { flex: 1 } });

type StudioCapabilityLayoutProps = {
  testIdPrefix: string;
  modelPicker: ReactNode;
  changes: readonly string[];
  fieldControls: ReactNode;
  estimateCredits: number | null;
  submitLabel: string;
  submitDisabled: boolean;
  isSubmitting: boolean;
  onSubmit: () => void;
  children?: ReactNode;
};

/**
 * Fields on the left in one panel; the model row, what a model switch moved, the cost and the primary action in a
 * quiet side panel that stays in view while the fields scroll. Brings its own token scope, like StudioModelPicker.
 */
export const StudioCapabilityLayout = ({
  testIdPrefix,
  modelPicker,
  changes,
  fieldControls,
  estimateCredits,
  submitLabel,
  submitDisabled,
  isSubmitting,
  onSubmit,
  children,
}: StudioCapabilityLayoutProps) => (
  <StudioThemeScope inline testId={`${testIdPrefix}-scope`}>
    <Layout data-testid={testIdPrefix}>
      <StudioPanel aria-label="Settings" testId={`${testIdPrefix}-fields-panel`}>
        {fieldControls}
      </StudioPanel>
      <SidePanel>
        <StudioPanel aria-label="Model and cost" tone="sunken" testId={`${testIdPrefix}-side-panel`}>
          <FieldStack>
            <StudioSectionLabel testId={`${testIdPrefix}-model-label`}>Model</StudioSectionLabel>
            {modelPicker}
          </FieldStack>
          {changes.length > 0 && (
            <Notices role="status" data-testid={`${testIdPrefix}-changes`}>
              {changes.map(change => (
                <span key={change}>{change}</span>
              ))}
            </Notices>
          )}
          <CostRow>
            <StudioSectionLabel testId={`${testIdPrefix}-estimate-label`}>Estimated cost</StudioSectionLabel>
            <CostValue data-unavailable={estimateCredits === null} data-testid={`${testIdPrefix}-estimate`}>
              {estimateCredits === null ? 'Unavailable' : `${formatCredits(estimateCredits)} credits`}
            </CostValue>
          </CostRow>
          <ActionSlot>
            <StudioPrimaryAction
              loading={isSubmitting}
              disabled={submitDisabled}
              onClick={onSubmit}
              testId={`${testIdPrefix}-submit-btn`}
            >
              {submitLabel}
            </StudioPrimaryAction>
          </ActionSlot>
          {children}
        </StudioPanel>
      </SidePanel>
    </Layout>
  </StudioThemeScope>
);
