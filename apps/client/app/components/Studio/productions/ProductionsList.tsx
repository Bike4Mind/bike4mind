import { useState, type FormEvent } from 'react';
import { styled } from '@mui/system';
import { Button, CircularProgress, Input, Stack, Typography } from '@mui/joy';
import { Link, useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import {
  STUDIO_COMPOSITION_LIMITS,
  STUDIO_COMPOSITION_TEMPLATE_DEFINITIONS,
  STUDIO_COMPOSITION_TEMPLATES,
  type StudioCompositionSummaryResponse,
  type StudioCompositionTemplate,
} from '@bike4mind/common';
import ConfirmationModal from '@client/app/components/common/ConfirmationModal';
import {
  compositionErrorMessage,
  useCreateStudioComposition,
  useDeleteStudioComposition,
  useStudioCompositions,
  useUpdateStudioComposition,
} from '@client/app/hooks/data/studioCompositions';
import { StudioPanel, StudioSectionLabel } from '../design/StudioPanel';
import { studioColor, studioRadius } from '../design/studioTokens';
import ShortFilmBriefFields, { initialShortFilmBrief, shortFilmCreateFields } from './ShortFilmBriefFields';

const formatLength = (durationMs: number) =>
  durationMs >= 60_000 ? `${durationMs / 60_000} min` : `${durationMs / 1000}s`;

/** "15s, 16:9 + 9:16 + 1:1": what a template starts with, from the shared template data. */
export const templateSummary = (template: StudioCompositionTemplate) => {
  const { durationMs, aspects } = STUDIO_COMPOSITION_TEMPLATE_DEFINITIONS[template];
  return `${formatLength(durationMs)}, ${aspects.join(' + ')}`;
};

const TemplateGrid = styled('div')({
  display: 'grid',
  gap: '8px',
  gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
});

const TemplateCard = styled('button')({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: '4px',
  padding: '12px',
  textAlign: 'left',
  font: 'inherit',
  color: studioColor('text'),
  cursor: 'pointer',
  borderRadius: studioRadius('md'),
  border: `1px solid ${studioColor('border')}`,
  background: studioColor('raised'),
  '&:hover': { background: studioColor('hover') },
  '&[aria-checked="true"]': {
    borderColor: studioColor('accent-border'),
    background: studioColor('accent-soft'),
    color: studioColor('accent-on-soft'),
  },
  '& > strong': { fontWeight: 600, color: 'inherit' },
  '& > span': { fontSize: '12px', color: studioColor('text-secondary') },
});

const Row = styled('li')({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '8px 16px',
  padding: '12px 16px',
  borderRadius: studioRadius('md'),
  border: `1px solid ${studioColor('hairline')}`,
  background: studioColor('surface'),
});

const RowList = styled('ul')({ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '8px' });

// Styles the router Link through a wrapper: styled(Link) drops Link's typed `params`.
const RowTitle = styled('div')({
  flex: '1 1 240px',
  minWidth: 0,
  display: 'flex',
  '& > a': {
    fontWeight: 600,
    color: studioColor('text-strong'),
    textDecoration: 'none',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    '&:hover': { textDecoration: 'underline' },
  },
});

const updatedFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Productions' home: start a production from a template (Ad campaign by default), then open, rename or delete one. */
const ProductionsList = () => {
  const compositions = useStudioCompositions();
  return (
    <Stack spacing={2.5} data-testid="productions-list">
      <CreateProductionForm />
      {compositions.isPending ? (
        <CircularProgress size="sm" data-testid="productions-list-loading" />
      ) : compositions.isError ? (
        <Typography level="body-sm" color="danger" data-testid="productions-list-error">
          {compositionErrorMessage(compositions.error)}
        </Typography>
      ) : compositions.data.length === 0 ? (
        <Typography level="body-sm" data-testid="productions-list-empty">
          No productions yet. Start one above, then add clips from your Library.
        </Typography>
      ) : (
        <RowList>
          {compositions.data.map(composition => (
            <ProductionRow key={composition.id} composition={composition} />
          ))}
        </RowList>
      )}
    </Stack>
  );
};

const CreateProductionForm = () => {
  const [title, setTitle] = useState('');
  const [template, setTemplate] = useState<StudioCompositionTemplate>('ad_campaign');
  const [shortFilm, setShortFilm] = useState(initialShortFilmBrief);
  const create = useCreateStudioComposition();
  const navigate = useNavigate();

  const isShortFilm = template === 'short_film';
  const canCreate = Boolean(title.trim()) && (!isShortFilm || shortFilm.aspects.length > 0);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!canCreate) return;
    create.mutate(
      { title: title.trim(), template, ...(isShortFilm && shortFilmCreateFields(shortFilm)) },
      {
        onSuccess: composition =>
          void navigate({ to: '/studio/productions/$compositionId', params: { compositionId: composition.id } }),
      }
    );
  };

  return (
    <StudioPanel testId="productions-create">
      <form onSubmit={onSubmit}>
        <Stack spacing={1.5}>
          <StudioSectionLabel>Start from a template</StudioSectionLabel>
          <TemplateGrid role="radiogroup" aria-label="Template" data-testid="productions-create-templates">
            {STUDIO_COMPOSITION_TEMPLATES.map(option => {
              const definition = STUDIO_COMPOSITION_TEMPLATE_DEFINITIONS[option];
              return (
                <TemplateCard
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={option === template}
                  onClick={() => setTemplate(option)}
                  data-testid={`productions-template-${option}`}
                >
                  <strong>{definition.label}</strong>
                  <span>{definition.description}</span>
                  <span>{templateSummary(option)}</span>
                </TemplateCard>
              );
            })}
          </TemplateGrid>
          {isShortFilm && <ShortFilmBriefFields value={shortFilm} onChange={setShortFilm} />}
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'flex-end' }}>
            <Stack spacing={0.5} sx={{ flex: 1 }}>
              <StudioSectionLabel htmlFor="productions-create-title">Name</StudioSectionLabel>
              <Input
                size="sm"
                id="productions-create-title"
                placeholder="Spring launch ad"
                value={title}
                onChange={event => setTitle(event.target.value)}
                slotProps={{
                  input: {
                    maxLength: STUDIO_COMPOSITION_LIMITS.titleMaxLength,
                    'data-testid': 'productions-create-title-input',
                  },
                }}
              />
            </Stack>
            <Button
              size="sm"
              type="submit"
              loading={create.isPending}
              disabled={!canCreate}
              data-testid="productions-create-btn"
            >
              Create {STUDIO_COMPOSITION_TEMPLATE_DEFINITIONS[template].label.toLowerCase()}
            </Button>
          </Stack>
        </Stack>
      </form>
    </StudioPanel>
  );
};

const ProductionRow = ({ composition }: { composition: StudioCompositionSummaryResponse }) => {
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(composition.title);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const update = useUpdateStudioComposition(composition.id);
  const remove = useDeleteStudioComposition();
  const testId = `productions-row-${composition.id}`;

  const saveRename = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = draftTitle.trim();
    if (!trimmed || trimmed === composition.title) {
      setIsRenaming(false);
      return;
    }
    update.mutate(
      { title: trimmed },
      {
        onSuccess: () => setIsRenaming(false),
        onError: error => toast.error(compositionErrorMessage(error)),
      }
    );
  };

  return (
    <Row data-testid={testId}>
      {isRenaming ? (
        <form onSubmit={saveRename} style={{ display: 'flex', gap: '8px', flex: '1 1 240px' }}>
          <Input
            size="sm"
            autoFocus
            value={draftTitle}
            onChange={event => setDraftTitle(event.target.value)}
            sx={{ flex: 1 }}
            slotProps={{
              input: {
                maxLength: STUDIO_COMPOSITION_LIMITS.titleMaxLength,
                'aria-label': 'New title',
                'data-testid': `${testId}-rename-input`,
              },
            }}
          />
          <Button size="sm" type="submit" loading={update.isPending} data-testid={`${testId}-rename-save-btn`}>
            Save
          </Button>
          <Button
            size="sm"
            variant="plain"
            onClick={() => setIsRenaming(false)}
            data-testid={`${testId}-rename-cancel-btn`}
          >
            Cancel
          </Button>
        </form>
      ) : (
        <RowTitle>
          <Link
            to="/studio/productions/$compositionId"
            params={{ compositionId: composition.id }}
            data-testid={`${testId}-open-link`}
          >
            {composition.title}
          </Link>
        </RowTitle>
      )}
      <Typography level="body-xs">{STUDIO_COMPOSITION_TEMPLATE_DEFINITIONS[composition.template].label}</Typography>
      <Typography level="body-xs">Updated {updatedFormat.format(composition.updatedAt)}</Typography>
      {!isRenaming && (
        <Stack direction="row" spacing={0.5}>
          <Button
            size="sm"
            variant="plain"
            onClick={() => {
              setDraftTitle(composition.title);
              setIsRenaming(true);
            }}
            data-testid={`${testId}-rename-btn`}
          >
            Rename
          </Button>
          <Button
            size="sm"
            variant="plain"
            color="danger"
            onClick={() => setIsConfirmingDelete(true)}
            data-testid={`${testId}-delete-btn`}
          >
            Delete
          </Button>
        </Stack>
      )}
      <ConfirmationModal
        open={isConfirmingDelete}
        onClose={() => setIsConfirmingDelete(false)}
        onConfirm={async () => {
          await remove.mutateAsync(composition.id);
          setIsConfirmingDelete(false);
        }}
        loading={remove.isPending}
        title="Delete production?"
        description={`"${composition.title}" will be deleted. The Library files it uses are kept.`}
        confirmText="Delete"
        confirmColor="danger"
      />
    </Row>
  );
};

export default ProductionsList;
