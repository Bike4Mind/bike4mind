import Typography from '@mui/joy/Typography';
import type { ChatModelOption } from '@shared/chat';
import { WORKER_ROLES, type RootPolicy } from '@shared/orchestration';

export function OrchestrationSummary({
  root,
  planner,
  models,
}: {
  root: RootPolicy;
  planner: string;
  models: readonly ChatModelOption[];
}) {
  const display = (id: string) => {
    if (id === 'inherit') return 'inherit parent';
    const model = models.find(option => option.id === id);
    if (!model) return `${id} (unavailable; choose a replacement)`;
    return `${model.name}${model.unavailable || model.disabled || model.supportsTools === false ? ' (unavailable; choose a replacement)' : ''}`;
  };
  return (
    <Typography level="body-xs" data-testid="orchestration-policy-summary">
      Planner: {display(planner)}. Workers:{' '}
      {WORKER_ROLES.map(role => `${role}: ${display(root.policy.roles[role])}`).join('; ')}. Worker defaults are in
      Settings. Active tasks retain this run policy.
    </Typography>
  );
}
