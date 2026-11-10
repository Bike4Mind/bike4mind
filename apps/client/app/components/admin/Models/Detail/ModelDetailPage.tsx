import { EmptyState } from '../../shared';
import type { ModelDetailTab } from '../modelDetailSearch';

export function ModelDetailPage({
  modelId,
}: {
  modelId: string;
  tab: ModelDetailTab;
  onTabChange: (tab: ModelDetailTab) => void;
}) {
  return <EmptyState title={modelId} action={null} />;
}
