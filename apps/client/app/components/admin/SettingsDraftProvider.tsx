import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type SetStateAction } from 'react';
import { SaveBar } from './shared/SaveBar';
import { SettingsWarningDialog, UnsavedChangesGuard } from './shared/UnsavedChangesGuard';
import { getErrorMessage } from '@client/app/utils/error';

type Draft = { value: unknown; save(value: unknown): Promise<unknown>; blocked?: string; warning?: string };
type DraftContext = {
  drafts: Record<string, Draft>;
  pending: boolean;
  set(id: string, draft: Draft | undefined): void;
};
const Context = createContext<DraftContext | null>(null);

export function SettingsDraftProvider({ children }: { children: ReactNode }) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const entries = Object.entries(drafts);
  const blockedReason = entries.find(([, draft]) => draft.blocked)?.[1].blocked;
  const warnings = entries.flatMap(([, draft]) => (draft.warning ? [draft.warning] : []));
  const save = async () => {
    if (saving.current || blockedReason) return;
    saving.current = true;
    setPending(true);
    setError(undefined);
    setConfirming(false);
    try {
      for (const [id, draft] of entries) {
        await draft.save(draft.value);
        setDrafts(previous => {
          const next = { ...previous };
          delete next[id];
          return next;
        });
      }
    } catch (failure) {
      setError(getErrorMessage(failure));
    } finally {
      saving.current = false;
      setPending(false);
    }
  };
  return (
    <Context.Provider
      value={{
        drafts,
        pending,
        set: (id, draft) => {
          if (saving.current) return;
          setDrafts(previous => {
            const next = { ...previous };
            if (draft) next[id] = draft;
            else delete next[id];
            return next;
          });
        },
      }}
    >
      {children}
      <SaveBar
        count={entries.length}
        pending={pending}
        blockedReason={blockedReason}
        error={error}
        onDiscard={() => {
          setDrafts({});
          setError(undefined);
        }}
        onSave={() => (warnings.length ? setConfirming(true) : void save())}
      />
      <UnsavedChangesGuard
        dirty={entries.length > 0 || pending}
        pending={pending}
        isLeaving={(current, next) =>
          current.pathname !== next.pathname ||
          ('tab' in current.search ? current.search.tab : undefined) !==
            ('tab' in next.search ? next.search.tab : undefined)
        }
      />
      <SettingsWarningDialog
        open={confirming}
        warnings={warnings}
        onClose={() => setConfirming(false)}
        onSave={() => void save()}
      />
    </Context.Provider>
  );
}

export function useSettingsDraft<T>(
  id: string,
  baseline: T,
  options: {
    save(value: T): Promise<unknown>;
    blocked?(value: T): string | undefined;
    equals?(left: T, right: T): boolean;
    warning?: string;
  }
) {
  const context = useContext(Context);
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });
  const [local, setLocal] = useState(baseline);
  const draft = context?.drafts[id];
  const value = context ? (draft ? (draft.value as T) : baseline) : local;
  const setValue = (update: SetStateAction<T>) => {
    const next = typeof update === 'function' ? (update as (previous: T) => T)(value) : update;
    if (!context) {
      setLocal(next);
      return;
    }
    const equal = options.equals?.(next, baseline) ?? JSON.stringify(next) === JSON.stringify(baseline);
    context.set(
      id,
      equal
        ? undefined
        : {
            value: next,
            save: value => optionsRef.current.save(value as T),
            blocked: options.blocked?.(next),
            warning: options.warning,
          }
    );
  };
  return { value, setValue, staged: context !== null, pending: context?.pending ?? false, dirty: Boolean(draft) };
}
