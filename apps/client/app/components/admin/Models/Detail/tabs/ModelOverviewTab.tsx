import { Box } from '@mui/joy';
import type { AdminModelRowWire } from '@client/app/hooks/data/adminModels';
import { Fact, RelativeTime, SectionCard } from '../../../shared';
import { MODEL_SOURCE_LABEL, modelTypeLabel, priceSummary } from '../../modelPresentation';

const formatDate = (value: string | undefined | null) => {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 10);
};

/** What the server knows about the model, read-only in this phase (docs/admin-models-spec.md 5.2). */
export function ModelOverviewTab({ model }: { model: AdminModelRowWire }) {
  const { lifecycle, lifecycleSuggestion: suggestion } = model;
  return (
    <Box
      sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2, alignItems: 'start' }}
      data-testid="model-overview-tab"
    >
      <SectionCard title="Identity" data-testid="model-overview-identity">
        <Fact label="Name">{model.name}</Fact>
        <Fact label="Type">{modelTypeLabel(model.type)}</Fact>
        <Fact label="Provider">{model.backend}</Fact>
        <Fact label="Vendor">{model.vendor}</Fact>
        <Fact label="Source" data-testid="model-overview-source">
          {MODEL_SOURCE_LABEL[model.origin]}
          {model.adminEdited && model.origin !== 'admin' ? ', changed by admin' : ''}
        </Fact>
        <Fact label="Private">{model.private ? 'Yes' : 'No'}</Fact>
      </SectionCard>

      <SectionCard title="Presentation" data-testid="model-overview-presentation">
        <Fact label="Description">{model.description}</Fact>
        <Fact label="Released" data-testid="model-overview-released">
          {formatDate(model.releaseDate)}
        </Fact>
        <Fact label="First seen" data-testid="model-overview-first-seen">
          {model.firstSeenAt ? <RelativeTime at={model.firstSeenAt} /> : 'Never seen by discovery'}
        </Fact>
        <Fact label="Rank">
          {model.rank === null ? 'Unranked' : `${model.rank}${model.rankProvisional ? ' (provisional)' : ''}`}
        </Fact>
      </SectionCard>

      <SectionCard title="Limits and price" data-testid="model-overview-limits">
        <Fact label="Context window">
          {model.contextWindow ? `${model.contextWindow.toLocaleString()} tokens` : undefined}
        </Fact>
        <Fact label="Provider cost">{priceSummary(model.price, model.type)}</Fact>
        <Fact label="Price source">
          {model.price ? (model.price.source === 'build' ? 'Build table' : 'Price row') : 'None'}
        </Fact>
        <Fact label="Free to run">{model.freeToRun ? 'Yes' : 'No'}</Fact>
        <Fact label="Key in this environment">{model.keyPresent ? 'Yes' : 'No'}</Fact>
      </SectionCard>

      <SectionCard title="Lifecycle" data-testid="model-overview-lifecycle">
        <Fact label="Status">{lifecycle.status}</Fact>
        <Fact label="Deprecated on">{formatDate(lifecycle.deprecationDate)}</Fact>
        <Fact label="Retires on">{formatDate(lifecycle.retirementDate)}</Fact>
        <Fact label="Replaced by">{lifecycle.replacedBy}</Fact>
        {suggestion && (
          <Fact label="Pending suggestion" data-testid="model-overview-suggestion">
            {`${suggestion.status ?? 'Change'} from ${suggestion.source}`}
            {suggestion.detail ? `: ${suggestion.detail}` : ''}
          </Fact>
        )}
      </SectionCard>
    </Box>
  );
}
