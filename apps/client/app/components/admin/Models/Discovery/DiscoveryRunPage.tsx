import { EmptyState } from '../../shared';

/** One discovery run at /admin/models/runs/$runId (docs/admin-models-spec.md section 5.3). Placeholder. */
export function DiscoveryRunPage({ runId }: { runId: string }) {
  return <EmptyState title={`Run ${runId}`} action={null} />;
}
