import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useCallback } from 'react';
import { ModelDetailPage } from '@client/app/components/admin/Models/Detail/ModelDetailPage';
import { DEFAULT_MODEL_DETAIL_TAB, type ModelDetailTab } from '@client/app/components/admin/Models/modelDetailSearch';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';

const ROUTE_ID = '/admin-layout/admin/models/$';

const AdminModelDetail = () => {
  useDocumentTitle('Model', ' | Admin');
  // A splat, so a model id keeps its `/` (local-image/<checkpoint>) with no encoding.
  const { _splat: modelId = '' } = useParams({ from: ROUTE_ID });
  const { tab = DEFAULT_MODEL_DETAIL_TAB } = useSearch({ from: ROUTE_ID });
  const navigate = useNavigate({ from: '/admin/models/$' });

  // Replace, so flipping tabs does not stack history entries for Back to walk through.
  const setTab = useCallback(
    (next: ModelDetailTab) =>
      navigate({ search: { tab: next === DEFAULT_MODEL_DETAIL_TAB ? undefined : next }, replace: true }),
    [navigate]
  );

  return <ModelDetailPage modelId={modelId} tab={tab} onTabChange={setTab} />;
};

export default AdminModelDetail;
