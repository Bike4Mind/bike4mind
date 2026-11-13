import { useState } from 'react';
import {
  Box,
  Button,
  Chip,
  DialogContent,
  DialogTitle,
  Drawer,
  Input,
  ModalClose,
  Option,
  Radio,
  RadioGroup,
  Select,
  Sheet,
  Stack,
  Typography,
} from '@mui/joy';
import SearchIcon from '@mui/icons-material/Search';
import { RANKED_SHORTLIST_SIZE } from '@bike4mind/common';
import { formatCredits } from '@client/app/utils/formatUsd';
import type { StudioModelCard } from './studioModelCard';

type StudioModelPickerProps = {
  // Test ids: `<prefix>-model-row` (`-name`, `-picked-for`), `<prefix>-model-change-btn`, `<prefix>-model-panel`,
  // `<prefix>-model-show-all-btn`, `<prefix>-model-search-input`, `<prefix>-model-provider-select`, and per model
  // `<prefix>-model-option-<id>` with `-radio`, `-cost`, `-picked-for` and `-reason`.
  testIdPrefix: string;
  // Best first, as the medium's ranker ordered them.
  cards: readonly StudioModelCard[];
  selectedId: string;
  onSelect: (modelId: string) => void;
};

const ALL_PROVIDERS = '';

const costLine = ({ creditsPerOutput, outputNoun }: StudioModelCard): string =>
  creditsPerOutput === null
    ? 'Price unavailable'
    : `About ${formatCredits(creditsPerOutput)} credits per ${outputNoun}`;

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

type ModelOptionProps = { card: StudioModelCard; selected: boolean; testIdPrefix: string };

const ModelOption = ({ card, selected, testIdPrefix }: ModelOptionProps) => {
  const reason = reasonOf(card);
  const testId = `${testIdPrefix}-model-option-${card.id}`;
  return (
    <Sheet
      variant={selected ? 'soft' : 'outlined'}
      color={selected ? 'primary' : 'neutral'}
      data-testid={testId}
      data-selected={selected}
      data-why-not-code={card.whyNotCode ?? undefined}
      sx={{ p: 1.25, borderRadius: 'md', position: 'relative', opacity: reason && !selected ? 0.65 : 1 }}
    >
      <Stack gap={0.5}>
        <Stack direction="row" gap={1} alignItems="center" justifyContent="space-between">
          <Radio
            overlay
            value={card.id}
            disabled={card.unavailableReason !== null}
            label={card.name}
            slotProps={{
              label: { sx: { fontWeight: 'lg' } },
              input: { 'data-testid': `${testId}-radio` },
            }}
          />
          <Chip size="sm" variant="outlined">
            {card.provider}
          </Chip>
        </Stack>
        {card.strength && <Typography level="body-xs">{card.strength}</Typography>}
        <Typography level="body-xs" fontWeight="md" data-testid={`${testId}-cost`}>
          {costLine(card)}
        </Typography>
        {card.pickedFor && (
          <Typography level="body-xs" textColor="text.tertiary" data-testid={`${testId}-picked-for`}>
            Picked for: {card.pickedFor}
          </Typography>
        )}
        {reason && (
          <Typography
            level="body-xs"
            color={card.unavailableReason ? 'neutral' : 'warning'}
            data-testid={`${testId}-reason`}
          >
            {reason}
          </Typography>
        )}
      </Stack>
    </Sheet>
  );
};

type ModelPanelProps = StudioModelPickerProps;

// Mounted only while the drawer is open, so search, filter and "show all" start fresh each time it opens.
const ModelPanel = ({ testIdPrefix, cards, selectedId, onSelect }: ModelPanelProps) => {
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState(ALL_PROVIDERS);
  const providers = [...new Set(cards.map(card => card.provider))];
  const listed = showAll
    ? cards.filter(card => matchesQuery(card, query) && (provider === ALL_PROVIDERS || card.provider === provider))
    : shortlistOf(cards, selectedId);
  const hiddenCount = cards.length - shortlistOf(cards, selectedId).length;

  return (
    <Stack gap={1.5} data-testid={`${testIdPrefix}-model-panel`}>
      <Typography level="title-sm">{showAll ? 'All models' : 'Models for this request'}</Typography>
      {showAll && (
        <Stack direction={{ xs: 'column', sm: 'row' }} gap={1}>
          <Input
            size="sm"
            placeholder="Search models"
            startDecorator={<SearchIcon />}
            value={query}
            onChange={event => setQuery(event.target.value)}
            slotProps={{
              input: { 'aria-label': 'Search models', 'data-testid': `${testIdPrefix}-model-search-input` },
            }}
            sx={{ flex: 1, minWidth: 0 }}
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
        </Stack>
      )}
      <RadioGroup
        aria-label="Model"
        value={selectedId}
        onChange={event => onSelect(event.target.value)}
        sx={{ gap: 1, '& > *': { m: 0 } }}
      >
        {listed.map(card => (
          <ModelOption key={card.id} card={card} selected={card.id === selectedId} testIdPrefix={testIdPrefix} />
        ))}
      </RadioGroup>
      {showAll && listed.length === 0 && (
        <Typography level="body-sm" textColor="text.tertiary" data-testid={`${testIdPrefix}-model-no-match`}>
          No models match.
        </Typography>
      )}
      {(hiddenCount > 0 || showAll) && (
        <Button
          variant="plain"
          size="sm"
          onClick={() => setShowAll(current => !current)}
          data-testid={`${testIdPrefix}-model-show-all-btn`}
          sx={{ alignSelf: 'flex-start' }}
        >
          {showAll ? 'Show models for this request' : `Show all models (${cards.length})`}
        </Button>
      )}
    </Stack>
  );
};

/**
 * The model choice as one compact row: the picked model, why it suits the request (or why it does not), and Change.
 * Change opens a "Model and cost" panel that lists the ranked shortlist, with every model one click away. One model
 * is always selected, so the default is a visible, swappable choice rather than a hidden auto-pick.
 */
const StudioModelPicker = ({ testIdPrefix, cards, selectedId, onSelect }: StudioModelPickerProps) => {
  const [open, setOpen] = useState(false);
  const selected = cards.find(card => card.id === selectedId);
  const reason = selected ? reasonOf(selected) : null;

  return (
    <>
      <Sheet
        variant="outlined"
        data-testid={`${testIdPrefix}-model-row`}
        sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 0.75, minHeight: 48, borderRadius: 'md' }}
      >
        {selected && (
          <Chip size="sm" variant="soft" sx={{ flexShrink: 0 }}>
            {selected.provider}
          </Chip>
        )}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="title-sm" noWrap data-testid={`${testIdPrefix}-model-row-name`}>
            {selected?.name ?? selectedId}
          </Typography>
          {reason ? (
            <Typography level="body-xs" color="warning" noWrap data-testid={`${testIdPrefix}-model-row-reason`}>
              {reason}
            </Typography>
          ) : (
            selected?.pickedFor && (
              <Typography
                level="body-xs"
                textColor="text.tertiary"
                noWrap
                data-testid={`${testIdPrefix}-model-row-picked-for`}
              >
                Picked for: {selected.pickedFor}
              </Typography>
            )
          )}
        </Box>
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          onClick={() => setOpen(true)}
          data-testid={`${testIdPrefix}-model-change-btn`}
          sx={{ flexShrink: 0 }}
        >
          Change
        </Button>
      </Sheet>
      <Drawer
        anchor="right"
        open={open}
        onClose={() => setOpen(false)}
        slotProps={{ content: { sx: { width: { xs: '100%', sm: 360 }, p: 2 } } }}
      >
        <ModalClose data-testid={`${testIdPrefix}-model-panel-close-btn`} />
        <DialogTitle>Model and cost</DialogTitle>
        <DialogContent sx={{ pt: 1 }}>
          {open && (
            <ModelPanel
              testIdPrefix={testIdPrefix}
              cards={cards}
              selectedId={selectedId}
              onSelect={modelId => {
                onSelect(modelId);
                setOpen(false);
              }}
            />
          )}
        </DialogContent>
      </Drawer>
    </>
  );
};

export default StudioModelPicker;
