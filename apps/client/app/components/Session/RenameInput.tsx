import { useUpdateSession } from '@client/app/hooks/data/sessions';
import { ISessionDocument } from '@bike4mind/common';
import { Input, InputProps } from '@mui/joy';
import { FC, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { updateAllQueryData } from '@client/app/utils/react-query';
import { useSessions } from '@client/app/contexts/SessionsContext';

interface SessionRenameInputProps extends InputProps {
  session: ISessionDocument;
  /**
   * Initial value for the input. Defaults to `session.name` for back-compat,
   * but callers should pass a cleaned title (e.g. via `formatSessionTitle`) so
   * the user edits a readable string rather than a raw JSON literal.
   */
  initialValue?: string;
  onSuccess: () => void;
}

const SessionRenameInput: FC<SessionRenameInputProps> = ({ session, initialValue, onSuccess, ...rest }) => {
  const [name, setName] = useState(initialValue ?? session.name);
  const inputRef = useRef<HTMLInputElement>(null);
  // Ignore the spurious blur that fires while the parent Dropdown/Menu is
  // still unmounting around us. Without this, the header rename appears to no-op
  // because the just-mounted input blurs before the user can interact, hitting
  // the `name === session.name` branch of handleInputBlur and exiting edit mode.
  const hasFocusSettledRef = useRef(false);

  const updateSession = useUpdateSession();
  const queryClient = useQueryClient();
  const { setCurrentSession } = useSessions();

  useEffect(() => {
    // Defer focus past the current task so any unmounting popper/menu finishes
    // its focus-restoration cleanup before we claim focus. Matches the prior
    // production behavior that wrapped focus in a setTimeout.
    const timer = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
      hasFocusSettledRef.current = true;
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      handleInputBlur();
    }
  }

  async function handleInputBlur() {
    if (!hasFocusSettledRef.current) return;
    // When a session has a raw-JSON `name`, the input is seeded with the cleaned
    // `initialValue`, so `name !== session.name` is already true on a bare
    // Enter/blur. This intentionally lets a user passively upgrade a broken stored
    // title to the clean one without retyping - and since the sidebar already
    // displays the cleaned title, there's no visible change, only a better stored value.
    if (name && name !== session.name) {
      const updatedSession: ISessionDocument = { ...session, name };

      updateSession.mutate(updatedSession, {
        onSuccess: result => {
          // Use canonical server result to update UI and caches
          setCurrentSession(result);
          queryClient.invalidateQueries({ queryKey: ['sessions', 'projects'] });
          updateAllQueryData(queryClient, 'sessions', 'write', result, {
            keysAllowedToCreate: [['sessions', 'own']],
          });
          onSuccess();
        },
      });
    } else if (name === session.name) {
      // No change, still trigger onSuccess to exit editing mode
      onSuccess();
    }
  }

  return (
    <Input
      {...rest}
      slotProps={{ input: { ref: inputRef } }}
      value={name}
      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
      onKeyDown={handleInputKeyDown}
      onBlur={handleInputBlur}
    />
  );
};

export default SessionRenameInput;
