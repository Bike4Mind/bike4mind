import { useState, type FormEvent } from 'react';
import { styled } from '@mui/system';
import { Button, CircularProgress, Input, Option, Select, Stack, Typography } from '@mui/joy';
import { Link, useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import {
  STUDIO_COMPOSITION_LIMITS,
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

export const TEMPLATE_LABELS: Record<StudioCompositionTemplate, string> = {
  ad_campaign: 'Ad campaign (15s, 16:9 + 9:16 + 1:1)',
  social_pack: 'Social pack (15s, 9:16 + 1:1 + 4:5)',
  product_video: 'Product video (30s, 16:9)',
  explainer: 'Explainer (60s, 16:9)',
  short_film: 'Short film (2 min, 16:9)',
  blank: 'Blank (15s, 16:9)',
};

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

/** Productions' landing: start a production from a template, then open, rename or delete the user's own. */
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
  const create = useCreateStudioComposition();
  const navigate = useNavigate();

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    create.mutate(
      { title: trimmed, template },
      {
        onSuccess: composition =>
          void navigate({ to: '/studio/productions/$compositionId', params: { compositionId: composition.id } }),
      }
    );
  };

  return (
    <StudioPanel testId="productions-create">
      <form onSubmit={onSubmit}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'flex-end' }}>
          <Stack spacing={0.5} sx={{ flex: 1 }}>
            <StudioSectionLabel>New production</StudioSectionLabel>
            <Input
              size="sm"
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
          <Select
            size="sm"
            value={template}
            onChange={(_, value) => value && setTemplate(value)}
            aria-label="Template"
            data-testid="productions-create-template-select"
            sx={{ minWidth: '280px' }}
          >
            {STUDIO_COMPOSITION_TEMPLATES.map(option => (
              <Option key={option} value={option}>
                {TEMPLATE_LABELS[option]}
              </Option>
            ))}
          </Select>
          <Button
            size="sm"
            type="submit"
            loading={create.isPending}
            disabled={!title.trim()}
            data-testid="productions-create-btn"
          >
            Create
          </Button>
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
              input: { maxLength: STUDIO_COMPOSITION_LIMITS.titleMaxLength, 'data-testid': `${testId}-rename-input` },
            }}
          />
          <Button size="sm" type="submit" loading={update.isPending} data-testid={`${testId}-rename-save-btn`}>
            Save
          </Button>
          <Button size="sm" variant="plain" onClick={() => setIsRenaming(false)}>
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
      <Typography level="body-xs">{TEMPLATE_LABELS[composition.template].split(' (')[0]}</Typography>
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
