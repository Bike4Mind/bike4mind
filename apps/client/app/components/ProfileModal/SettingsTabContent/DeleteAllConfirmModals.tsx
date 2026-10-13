import { useState } from 'react';
import { FormControl, FormLabel, Input } from '@mui/joy';
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
// Both handlers also take down the pages the caller published from the deleted items.

// Case-sensitive on purpose: typing the exact word is the deliberate act this gate asks for.
const CONFIRM_WORD = 'DELETE';

function TypedConfirmField({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <FormControl>
      <FormLabel>Type {CONFIRM_WORD} to confirm</FormLabel>
      <Input
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        autoComplete="off"
        autoFocus
        slotProps={{ input: { 'data-testid': 'delete-all-confirm-input', spellCheck: false } }}
      />
    </FormControl>
  );
}

export function DeleteAllNotebooksConfirm({ onCancel, onConfirm, pending }: DeleteAllConfirmProps) {
  const [typed, setTyped] = useState('');
  const { data: count } = useOwnSessionCount();
  const what = countLabel(count, 'notebook', 'notebooks');

  return (
    <ConfirmActionModal
      data-testid="delete-all-notebooks-confirm"
      title="Delete all notebooks"
      description={
        `This deletes ${what} you own, including notebooks inside projects and notebooks you have shared ` +
        '(the people you shared them with lose access too). Notebooks others shared with you, your projects ' +
        'and your knowledge files are kept. Pages you published from these notebooks are taken down too. ' +
        'This cannot be undone.'
      }
      forwardButtonText="Delete all notebooks"
      // The request cannot be aborted, so Cancel is inert while it runs rather than implying it stops it.
      onGoBackward={() => !pending && onCancel()}
      onGoForward={onConfirm}
      disabledConfirm={pending || typed !== CONFIRM_WORD}
    >
      <TypedConfirmField value={typed} onChange={setTyped} disabled={pending} />
    </ConfirmActionModal>
  );
}

export function DeleteAllKnowledgeFilesConfirm({ onCancel, onConfirm, pending }: DeleteAllConfirmProps) {
  const [typed, setTyped] = useState('');
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
        'list. Pages you published from these files are taken down too. This cannot be undone.'
      }
      forwardButtonText="Delete all knowledge files"
      onGoBackward={() => !pending && onCancel()}
      onGoForward={onConfirm}
      disabledConfirm={pending || typed !== CONFIRM_WORD}
    >
      <TypedConfirmField value={typed} onChange={setTyped} disabled={pending} />
    </ConfirmActionModal>
  );
}
