import { useParams } from '@tanstack/react-router';
import { DiscoveryRunPage } from '@client/app/components/admin/Models/Discovery/DiscoveryRunPage';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';

const AdminModelDiscoveryRun = () => {
  useDocumentTitle('Discovery run', ' | Admin');
  const { runId } = useParams({ from: '/admin-layout/admin/models/runs/$runId' });
  return <DiscoveryRunPage runId={runId} />;
};

export default AdminModelDiscoveryRun;
