import { useNavigate, useParams } from '@tanstack/react-router';
import { NotebookFilepondProvider } from '@client/app/components/Session/NotebookFilepondProvider';
import SessionContainer from '@client/app/components/Session/SessionContainer';
import { useGetSession } from '@client/app/hooks/data/sessions';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import { useEffect, useRef } from 'react';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import { useMarkSessionViewed } from '@client/app/hooks/useUnreadProactiveMessages';
import useSessionLayout from '@client/app/hooks/useSessionLayout';
import { isOptimisticId } from '@client/app/utils/llm';

const NotebookPage = () => {
  const { id } = useParams({ strict: false });
  const session = useGetSession(id ?? null);
  const navigate = useNavigate();
  const pendingOptimisticId = useSessionLayout(s => s.pendingOptimisticId);

  // Redirect at most once per mount. The effect fires a toast, and it can run on
  // the error-commit render (twice under dev StrictMode); without this guard the
  // user could see a duplicate "not found" toast before the route unmounts.
  const hasRedirectedRef = useRef(false);

  // Depend on the primitive query fields we actually read rather than the whole
  // `session` object - React Query's result identity isn't a hard guarantee
  // across versions/structural-sharing edge cases, and we don't want a new
  // reference to re-run a toast-firing effect.
  const { isLoading, isError, data, error } = session;

  useEffect(() => {
    // Skip the not-found redirect during the optimistic->real session transition.
    // SessionContainer's session.created handler removes ['sessions', tmpId] from the
    // cache as part of the tmpId->realId migration; until its `await navigate(...)`
    // commits the realId URL, this effect would see `session.data === undefined` and
    // race the migration with a redirect to /new, stranding the assistant response.
    if (pendingOptimisticId || (id && isOptimisticId(id))) return;
    if (hasRedirectedRef.current) return;

    // The backend returns 404 both when a session doesn't exist and when the
    // current user lacks read access (it can't reveal which, by design). Either
    // way the session isn't openable, so bounce to a new notebook instead of
    // stranding the user on a dead page - which also stops SessionContainer from
    // re-attempting (and re-fetching) the inaccessible session on every render.
    const isNotFound = isAxiosError(error) && error.response?.status === 404;
    if (isNotFound) {
      hasRedirectedRef.current = true;
      toast.error('Notebook not found, or you do not have access to it.');
      navigate({ to: '/new' });
      return;
    }

    // If the session loaded but is not found, navigate to the new notebook page
    if (!isLoading && !isError && !data) {
      hasRedirectedRef.current = true;
      navigate({ to: '/new' });
    }
  }, [isLoading, isError, data, error, navigate, pendingOptimisticId, id]);

  useDocumentTitle(session?.data?.name, ' | Notebook');

  // Mark session as viewed when user opens it (clears unread proactive message badge)
  useMarkSessionViewed(id);

  return (
    <NotebookFilepondProvider>
      <SessionContainer currentSessionId={id} isLoading={!id || session.isPending} />
    </NotebookFilepondProvider>
  );
};

export default NotebookPage;
