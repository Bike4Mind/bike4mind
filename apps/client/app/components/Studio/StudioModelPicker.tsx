import { useId, useState } from 'react';
import { Drawer, Input, ModalClose, Option, Select } from '@mui/joy';
import { styled } from '@mui/system';
import SearchIcon from '@mui/icons-material/Search';
import { RANKED_SHORTLIST_SIZE } from '@bike4mind/common';
import { visuallyHidden } from '@client/app/utils/a11yStyles';
import { formatCredits } from '@client/app/utils/formatUsd';
import StudioThemeScope from './design/StudioThemeScope';
import { STUDIO_FOCUS_VISIBLE, studioColor, studioFont, studioRadius } from './design/studioTokens';
import type { StudioModelCard } from './studioModelCard';

type StudioModelPickerProps = {
  // Test ids: `<prefix>-model-row` (`-name`, `-picked-for`, `-reason`), `<prefix>-model-change-btn`,
  // `<prefix>-model-panel` (`-close-btn`), `<prefix>-model-show-all-btn`, `<prefix>-model-search-input`,
  // `<prefix>-model-provider-select`, `<prefix>-model-no-match`, and per model `<prefix>-model-option-<id>` with
  // `-radio`, `-cost`, `-picked-for` and `-reason`.
  testIdPrefix: string;
  // Best first, as the medium's ranker ordered them.
  cards: readonly StudioModelCard[];
  selectedId: string;
  onSelect: (modelId: string) => void;
};

const ALL_PROVIDERS = '';

const reasonOf = (card: StudioModelCard): string | null => card.unavailableReason ?? card.mismatchReason;

// The ranked top of the list, plus the current pick when it ranks lower, so it never vanishes from the shortlist.
const shortlistOf = (cards: readonly StudioModelCard[], selectedId: string): readonly StudioModelCard[] => {
  const top = cards.slice(0, RANKED_SHORTLIST_SIZE);
  const selected = cards.find(card => card.id === selectedId);
  return selected && !top.includes(selected) ? [...top, selected] : top;
};

const matchesQuery = (card: StudioModelCard, query: string): boolean => {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return [card.name, card.provider, card.strength].some(text => text.toLowerCase().includes(needle));
};

// "Black Forest Labs" -> "BF", "OpenAI" -> "OP".
const monogramOf = (provider: string): string => {
  const words = provider.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
};

const ROW_HOVER = { backgroundColor: studioColor('hover') };

const RowButton = styled('button')({
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  width: '100%',
  minHeight: '48px',
  padding: '6px 14px 6px 8px',
  borderRadius: studioRadius('md'),
  border: `1px solid ${studioColor('border')}`,
  backgroundColor: studioColor('raised'),
  color: studioColor('text'),
  font: `400 13px/1.3 ${studioFont('ui')}`,
  textAlign: 'left',
  cursor: 'pointer',
  transition: 'background-color 120ms ease',
  '&:hover': ROW_HOVER,
  '&:focus-visible': STUDIO_FOCUS_VISIBLE,
  '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
});

const Monogram = styled('span')({
  flex: '0 0 auto',
  display: 'grid',
  placeItems: 'center',
  width: '32px',
  height: '32px',
  borderRadius: studioRadius('sm'),
  backgroundColor: studioColor('accent-soft'),
  color: studioColor('accent-on-soft'),
  fontSize: '11px',
  fontWeight: 700,
  letterSpacing: '0.02em',
});

const RowText = styled('span')({ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' });

const Truncate = styled('span')({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });

const RowName = styled(Truncate)({ fontWeight: 600, color: studioColor('text-strong') });

const RowNote = styled(Truncate)({
  fontSize: '11px',
  color: studioColor('text-muted'),
  '&[data-tone="warning"]': { color: studioColor('warning') },
});

const ChangeLabel = styled('span')({ flex: '0 0 auto', fontSize: '12px', fontWeight: 500, color: studioColor('link') });

// The drawer portals out of the page, so it carries its own token scope.
const PanelScope = styled(StudioThemeScope)({
  minHeight: '100%',
  display: 'flex',
  flexDirection: 'column',
  gap: '16px',
  padding: '24px 20px',
});

const PanelHeading = styled('h2')({
  margin: 0,
  paddingRight: '40px',
  fontSize: '15px',
  fontWeight: 600,
  lineHeight: 1.3,
  color: studioColor('text-strong'),
});

const PanelLede = styled('p')({
  margin: '4px 0 0',
  fontSize: '12px',
  lineHeight: 1.5,
  color: studioColor('text-muted'),
});

const OptionList = styled('div')({ display: 'flex', flexDirection: 'column', gap: '8px' });

const OptionRow = styled('label')({
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  padding: '10px 12px',
  borderRadius: studioRadius('md'),
  border: `1px solid ${studioColor('hairline')}`,
  backgroundColor: studioColor('surface'),
  cursor: 'pointer',
  transition: 'background-color 120ms ease, border-color 120ms ease',
  '&:hover': ROW_HOVER,
  '&:focus-within': STUDIO_FOCUS_VISIBLE,
  '&[data-selected="true"]': {
    borderColor: studioColor('accent-border'),
    backgroundColor: studioColor('accent-soft'),
  },
  '&[data-unavailable="true"]': { opacity: 0.62, cursor: 'not-allowed' },
  '&[data-unavailable="true"]:hover': { backgroundColor: studioColor('surface') },
  '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
});

const OptionHead = styled('span')({ display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: 0 });

const OptionName = styled('span')({ fontSize: '13px', fontWeight: 600, color: studioColor('text-strong') });

const OptionVendor = styled(Truncate)({ fontSize: '11px', color: studioColor('text-muted') });

const OptionCost = styled('span')({
  marginLeft: 'auto',
  flex: '0 0 auto',
  fontFamily: studioFont('mono'),
  fontSize: '11px',
  fontVariantNumeric: 'tabular-nums',
  color: studioColor('text-secondary'),
});

const OptionNote = styled('span')({
  fontSize: '12px',
  lineHeight: 1.45,
  color: studioColor('text-secondary'),
  '&[data-tone="warning"]': { color: studioColor('warning') },
  '&[data-tone="muted"]': { color: studioColor('text-muted') },
});

// Groups the note lines for aria-describedby without adding a layout box.
const NoteGroup = styled('span')({ display: 'contents' });

const TextButton = styled('button')({
  alignSelf: 'flex-start',
  padding: '4px 0',
  border: 0,
  background: 'none',
  borderRadius: studioRadius('xs'),
  color: studioColor('link'),
  font: `500 12px/1.3 ${studioFont('ui')}`,
  cursor: 'pointer',
  '&:focus-visible': STUDIO_FOCUS_VISIBLE,
});

const EmptyNote = styled('p')({ margin: 0, fontSize: '13px', color: studioColor('text-muted') });

const Filters = styled('div')({ display: 'flex', flexWrap: 'wrap', gap: '8px' });

const HiddenRadio = styled('input')(visuallyHidden);

const HiddenText = styled('span')(visuallyHidden);

const OptionCostText = ({ card, testId }: { card: StudioModelCard; testId: string }) => {
  if (card.creditsPerOutput === null) return <OptionCost data-testid={testId}>Price unavailable</OptionCost>;
  const credits = formatCredits(card.creditsPerOutput);
  return (
    <OptionCost data-testid={testId}>
      <span aria-hidden="true">{credits} cr</span>
      <HiddenText>
        About {credits} credits per {card.outputNoun}
      </HiddenText>
    </OptionCost>
  );
};

type ModelOptionProps = {
  card: StudioModelCard;
  selected: boolean;
  testIdPrefix: string;
  radioName: string;
  onSelect: (modelId: string) => void;
};

const ModelOption = ({ card, selected, testIdPrefix, radioName, onSelect }: ModelOptionProps) => {
  const testId = `${testIdPrefix}-model-option-${card.id}`;
  const nameId = useId();
  const noteId = useId();
  const isUnavailable = card.unavailableReason !== null;
  const reason = reasonOf(card);
  return (
    <OptionRow
      data-testid={testId}
      data-selected={selected}
      data-unavailable={isUnavailable}
      data-why-not-code={card.whyNotCode ?? undefined}
    >
      <HiddenRadio
        type="radio"
        name={radioName}
        value={card.id}
        checked={selected}
        disabled={isUnavailable}
        onChange={() => onSelect(card.id)}
        aria-labelledby={nameId}
        aria-describedby={noteId}
        data-testid={`${testId}-radio`}
      />
      <OptionHead>
        <OptionName id={nameId}>{card.name}</OptionName>
        <OptionVendor>{card.provider}</OptionVendor>
        <OptionCostText card={card} testId={`${testId}-cost`} />
      </OptionHead>
      <NoteGroup id={noteId}>
        {card.strength && <OptionNote>{card.strength}</OptionNote>}
        {reason ? (
          <OptionNote data-tone={isUnavailable ? 'muted' : 'warning'} data-testid={`${testId}-reason`}>
            {reason}
          </OptionNote>
        ) : (
          card.pickedFor && <OptionNote data-testid={`${testId}-picked-for`}>Picked for: {card.pickedFor}</OptionNote>
        )}
      </NoteGroup>
    </OptionRow>
  );
};

type ModelPanelProps = StudioModelPickerProps & { headingId: string };

// Mounted only while the drawer is open, so search, filter and "show all" start fresh each time it opens.
const ModelPanel = ({ testIdPrefix, cards, selectedId, onSelect, headingId }: ModelPanelProps) => {
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState(ALL_PROVIDERS);
  const radioName = useId();
  const providers = [...new Set(cards.map(card => card.provider))];
  const shortlist = shortlistOf(cards, selectedId);
  const listed = showAll
    ? cards.filter(card => matchesQuery(card, query) && (provider === ALL_PROVIDERS || card.provider === provider))
    : shortlist;
  const hiddenCount = cards.length - shortlist.length;

  return (
    <>
      <div>
        <PanelHeading id={headingId}>{showAll ? 'All models' : 'Models for this request'}</PanelHeading>
        <PanelLede>
          {showAll
            ? 'Every model for this medium, best fit first.'
            : 'Ranked for what you have set up, best fit first.'}
        </PanelLede>
      </div>
      {showAll && (
        <Filters>
          <Input
            size="sm"
            placeholder="Search models"
            startDecorator={<SearchIcon />}
            value={query}
            onChange={event => setQuery(event.target.value)}
            slotProps={{
              input: { 'aria-label': 'Search models', 'data-testid': `${testIdPrefix}-model-search-input` },
            }}
            sx={{ flex: '1 1 160px', minWidth: 0 }}
          />
          <Select
            size="sm"
            value={provider}
            onChange={(_event, value) => setProvider(value ?? ALL_PROVIDERS)}
            aria-label="Provider"
            slotProps={{ button: { 'data-testid': `${testIdPrefix}-model-provider-select` } }}
            sx={{ minWidth: 140 }}
          >
            <Option value={ALL_PROVIDERS}>All providers</Option>
            {providers.map(name => (
              <Option key={name} value={name}>
                {name}
              </Option>
            ))}
          </Select>
        </Filters>
      )}
      <OptionList role="radiogroup" aria-labelledby={headingId} data-testid={`${testIdPrefix}-model-panel`}>
        {listed.map(card => (
          <ModelOption
            key={card.id}
            card={card}
            selected={card.id === selectedId}
            testIdPrefix={testIdPrefix}
            radioName={radioName}
            onSelect={onSelect}
          />
        ))}
      </OptionList>
      {showAll && listed.length === 0 && (
        <EmptyNote data-testid={`${testIdPrefix}-model-no-match`}>No models match.</EmptyNote>
      )}
      {(hiddenCount > 0 || showAll) && (
        <TextButton
          type="button"
          onClick={() => setShowAll(current => !current)}
          data-testid={`${testIdPrefix}-model-show-all-btn`}
        >
          {showAll ? 'Show models for this request' : `Show all models (${cards.length})`}
        </TextButton>
      )}
    </>
  );
};

/**
 * The model choice as one compact row: the picked model, why it suits the request (or why it does not), and Change.
 * Change opens a drawer listing the ranked shortlist with cost and why-not reasons, with every model one click away.
 * One model is always selected, so the default is a visible, swappable choice rather than a hidden auto-pick.
 * Brings its own token scope, since the legacy Studio page renders it outside the v2 stage.
 */
const StudioModelPicker = ({ testIdPrefix, cards, selectedId, onSelect }: StudioModelPickerProps) => {
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const nameId = useId();
  const noteId = useId();
  const selected = cards.find(card => card.id === selectedId);
  const reason = selected ? reasonOf(selected) : null;

  return (
    <StudioThemeScope inline testId={`${testIdPrefix}-model-scope`}>
      <div data-testid={`${testIdPrefix}-model-row`}>
        <RowButton
          type="button"
          aria-label="Change model"
          aria-describedby={`${nameId} ${noteId}`}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
          data-testid={`${testIdPrefix}-model-change-btn`}
        >
          <Monogram aria-hidden="true">{monogramOf(selected?.provider ?? selectedId)}</Monogram>
          <RowText>
            <RowName id={nameId} data-testid={`${testIdPrefix}-model-row-name`}>
              {selected?.name ?? selectedId}
            </RowName>
            {reason ? (
              <RowNote id={noteId} data-tone="warning" data-testid={`${testIdPrefix}-model-row-reason`}>
                {reason}
              </RowNote>
            ) : (
              selected?.pickedFor && (
                <RowNote id={noteId} data-testid={`${testIdPrefix}-model-row-picked-for`}>
                  Picked for: {selected.pickedFor}
                </RowNote>
              )
            )}
          </RowText>
          <ChangeLabel aria-hidden="true">Change</ChangeLabel>
        </RowButton>
      </div>
      <Drawer
        anchor="right"
        open={open}
        onClose={() => setOpen(false)}
        slotProps={{
          content: {
            'aria-labelledby': headingId,
            sx: { width: { xs: '100%', sm: 380 }, p: 0, bgcolor: 'transparent', overflowY: 'auto' },
          },
        }}
      >
        <PanelScope testId={`${testIdPrefix}-model-drawer`}>
          <ModalClose data-testid={`${testIdPrefix}-model-panel-close-btn`} />
          {open && (
            <ModelPanel
              testIdPrefix={testIdPrefix}
              cards={cards}
              selectedId={selectedId}
              headingId={headingId}
              onSelect={modelId => {
                onSelect(modelId);
                setOpen(false);
              }}
            />
          )}
        </PanelScope>
      </Drawer>
    </StudioThemeScope>
  );
};

export default StudioModelPicker;
