import Box from '@mui/joy/Box';
import Typography from '@mui/joy/Typography';
import type { ChatModelOption } from '@shared/chat';
import { WORKER_ROLES, type RootPolicy } from '@shared/orchestration';

interface PolicyProps {
  root: RootPolicy;
  planner: string;
  models: readonly ChatModelOption[];
}

function describeModel(id: string, models: readonly ChatModelOption[]): { name: string; unavailable: boolean } {
  if (id === 'inherit') return { name: 'inherit parent', unavailable: false };
  const model = models.find(option => option.id === id);
  if (!model) return { name: id, unavailable: true };
  return {
    name: model.name,
    unavailable: Boolean(model.unavailable || model.disabled || model.supportsTools === false),
  };
}

/** False while the catalog is empty: it has not loaded yet, so nothing is known to be unavailable. */
export function hasUnavailableModel({ root, planner, models }: PolicyProps): boolean {
  if (models.length === 0) return false;
  return [planner, ...WORKER_ROLES.map(role => root.policy.roles[role])].some(
    id => describeModel(id, models).unavailable
  );
}

function ModelLine({ label, id, models }: { label: string; id: string; models: readonly ChatModelOption[] }) {
  const { name, unavailable } = describeModel(id, models);
  return (
    <Box>
      {label}: {name}
      {unavailable && (
        <Box component="span" sx={{ color: 'warning.plainColor' }}>
          {' (unavailable; choose a replacement)'}
        </Box>
      )}
    </Box>
  );
}

/** The run policy a delegating session started with; shown in the composer's Orchestrate tooltip. */
export function OrchestrationSummary({ root, planner, models }: PolicyProps) {
  return (
    <Box data-testid="orchestration-policy-summary">
      <Typography level="body-xs" component="div" sx={{ color: 'text.primary' }}>
        <ModelLine label="Planner" id={planner} models={models} />
        <Box sx={{ mt: 0.5, color: 'text.secondary' }}>Workers</Box>
        <Box sx={{ pl: 1 }}>
          {WORKER_ROLES.map(role => (
            <ModelLine key={role} label={role} id={root.policy.roles[role]} models={models} />
          ))}
        </Box>
      </Typography>
      <Typography level="body-xs" component="div" sx={{ mt: 0.75, color: 'text.tertiary', fontSize: '11px' }}>
        <Box>Worker defaults are in Settings.</Box>
        <Box>Active tasks retain this run policy.</Box>
      </Typography>
    </Box>
  );
}
