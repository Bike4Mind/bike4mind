import { useParams } from '@tanstack/react-router';
import { NotebookFilepondProvider } from '@client/app/components/Session/NotebookFilepondProvider';
import SessionContainer from '@client/app/components/Session/SessionContainer';
import DataLakeChatSurface from '@client/app/components/datalake/DataLakeChatSurface';
import { useGetSession } from '@client/app/hooks/data/sessions';
import NewNotebookPage from './new';
import NotebookPage from './$id';

/**
 * The one chat surface shared by /new and /notebooks/$id (the pathless notebook-shell route).
 * Keeping SessionContainer - and with it the ChatCompletionProvider - mounted across
 * /new -> /notebooks/<optimistic id> -> /notebooks/<real id> is what lets a first send's
 * placeholder, Stop button and error rollback live in the provider that receives its frames.
 *
 * The route-specific effects are rendered here rather than through an Outlet so they mount in
 * the same commit as SessionContainer: NewNotebookPage records the quest launch intent in a
 * layout effect that useSendMessage's mount effect must see. The shell has only these two
 * children, so "no id" means /new. Each one mounts on entering its route, which is when
 * NewNotebookPage resets the notebook state.
 */
const NotebookShell = () => {
  const { id } = useParams({ strict: false });
  const session = useGetSession(id ?? null);

  return (
    <NotebookFilepondProvider>
      {id ? <NotebookPage /> : <NewNotebookPage />}
      <DataLakeChatSurface chat={<SessionContainer currentSessionId={id} isLoading={!!id && session.isPending} />} />
    </NotebookFilepondProvider>
  );
};

export default NotebookShell;
