import ConfirmActionModal from '@client/app/components/ConfirmActionModal';
import { useGetFabFiles } from '@client/app/hooks/data/fabFiles';
import { useOwnSessionCount } from '@client/app/hooks/data/sessions';

interface DeleteAllConfirmProps {
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
}

const countLabel = (count: number | undefined, singular: string, plural: string) =>
  count === undefined ? `all your ${plural}` : `${count} ${count === 1 ? singular : plural}`;

// The scope copy below describes what DELETE /api/sessions and DELETE /api/files actually do
// (apps/client/pages/api/sessions/index.ts, apps/client/pages/api/files/index.ts) - keep in sync.
// Neither handler touches published pages: those are snapshots and stay online.

export function DeleteAllNotebooksConfirm({ onCancel, onConfirm, pending }: DeleteAllConfirmProps) {
  const { data: count } = useOwnSessionCount();
  const what = countLabel(count, 'notebook', 'notebooks');

  return (
    <ConfirmActionModal
      data-testid="delete-all-notebooks-confirm"
      title="Delete all notebooks"
      description={
        `This deletes ${what} you own, including notebooks inside projects and notebooks you have shared ` +
        '(the people you shared them with lose access too). Notebooks others shared with you, your projects ' +
        'and your knowledge files are kept. Pages you published from a notebook stay online. ' +
        'This cannot be undone.'
      }
      forwardButtonText="Delete all notebooks"
      // The request cannot be aborted, so Cancel is inert while it runs rather than implying it stops it.
      onGoBackward={() => !pending && onCancel()}
      onGoForward={onConfirm}
      disabledConfirm={pending}
    />
  );
}

export function DeleteAllKnowledgeFilesConfirm({ onCancel, onConfirm, pending }: DeleteAllConfirmProps) {
  // The list total excludes notebook summaries and files in archived data lakes, which the
  // delete also removes, so the count is stated as the list's and those are named separately.
  const { data } = useGetFabFiles();
  const total = data?.pages[0]?.total;
  const what = countLabel(total, 'knowledge file', 'knowledge files');

  return (
    <ConfirmActionModal
      data-testid="delete-all-files-confirm"
      title="Delete all knowledge files"
      description={
        `This deletes ${total === undefined ? what : `the ${what} in your list`}, plus notebook summaries ` +
        'and files in archived data lakes that you own. Files attached to projects or notebooks and files ' +
        'you have shared are deleted for everyone. Files others shared with you are only removed from your ' +
        'list. Pages you published from a file stay online. This cannot be undone.'
      }
      forwardButtonText="Delete all knowledge files"
      onGoBackward={() => !pending && onCancel()}
      onGoForward={onConfirm}
      disabledConfirm={pending}
    />
  );
}
