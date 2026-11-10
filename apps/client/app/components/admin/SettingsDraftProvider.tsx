import {
  createContext,
  type ComponentProps,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { SaveBar } from './shared/SaveBar';
import { SettingsWarningDialog, UnsavedChangesGuard } from './shared/UnsavedChangesGuard';
import { getErrorMessage } from '@client/app/utils/error';
import { leavesAdminSettingsPage, useRouteAdminTabSwitches } from './shared/adminTabSwitches';

type Draft = {
  dirty: boolean;
  baseline: unknown;
  name: string;
  value: unknown;
  save(value: unknown): Promise<unknown>;
  blocked?: string;
  warnings?(value: unknown): string[];
};
type DraftContext = {
  drafts: Record<string, Draft>;
  pending: boolean;
  set(id: string, draft: Draft | undefined): void;
};
const Context = createContext<DraftContext | null>(null);

export function SettingsDraftProvider({
  children,
  isLeaving = leavesAdminSettingsPage,
}: {
  children: ReactNode;
  /** Which navigations discard staged drafts; a page whose sections share one tab widens it. */
  isLeaving?: ComponentProps<typeof UnsavedChangesGuard>['isLeaving'];
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const entries = Object.entries(drafts).filter(([, draft]) => draft.dirty);
  const blockedDraft = entries.find(([, draft]) => draft.blocked)?.[1];
  const blockedReason = blockedDraft ? `${blockedDraft.name}: ${blockedDraft.blocked}` : undefined;
  const dirty = entries.length > 0 || pending;
  useRouteAdminTabSwitches(dirty);
  const [confirmWarnings, setConfirmWarnings] = useState<string[]>([]);
  const save = async () => {
    if (saving.current || blockedReason) return;
    saving.current = true;
    setPending(true);
    setError(undefined);
    setConfirming(false);
    const savedNames: string[] = [];
    try {
      for (const [id, draft] of entries) {
        try {
          await draft.save(draft.value);
        } catch (failure) {
          const savedSummary = savedNames.length ? ` Saved: ${savedNames.join(', ')}.` : '';
          setError(`${draft.name} was not saved: ${getErrorMessage(failure)}.${savedSummary}`);
          return;
        }
        savedNames.push(draft.name);
        setDrafts(previous => {
          const next = { ...previous };
          delete next[id];
          return next;
        });
      }
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
        onSave={() => {
          const current = entries.flatMap(([, draft]) => draft.warnings?.(draft.value) ?? []);
          if (current.length) {
            setConfirmWarnings(current);
            setConfirming(true);
          } else void save();
        }}
      />
      <UnsavedChangesGuard dirty={dirty} pending={pending} isLeaving={isLeaving} />
      <SettingsWarningDialog
        open={confirming}
        warnings={confirmWarnings}
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
    name?: string;
    save(value: T): Promise<unknown>;
    blocked?(value: T): string | undefined;
    equals?(left: T, right: T): boolean;
    /** Shown in the confirm dialog before the SaveBar saves this draft; a function reads the draft value. */
    warning?: string | ((value: T) => string[]);
  }
) {
  const context = useContext(Context);
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });
  const [local, setLocal] = useState(baseline);
  const retainedDraft = context?.drafts[id];
  const draft =
    retainedDraft && (retainedDraft.dirty || JSON.stringify(retainedDraft.baseline) === JSON.stringify(baseline))
      ? retainedDraft
      : undefined;
  const value = context ? (draft ? (draft.value as T) : baseline) : local;
  const setValue = (update: SetStateAction<T>) => {
    const next = typeof update === 'function' ? (update as (previous: T) => T)(value) : update;
    if (!context) {
      setLocal(next);
      return;
    }
    const equal = options.equals?.(next, baseline) ?? JSON.stringify(next) === JSON.stringify(baseline);
    // Keep raw formatting (including a trailing newline) without staging a redundant write.
    context.set(
      id,
      JSON.stringify(next) === JSON.stringify(baseline)
        ? undefined
        : {
            dirty: !equal,
            baseline,
            name: options.name ?? id,
            value: next,
            save: value => optionsRef.current.save(value as T),
            blocked: options.blocked?.(next),
            warnings: draftValue => {
              const warning = optionsRef.current.warning;
              return typeof warning === 'function' ? warning(draftValue as T) : warning ? [warning] : [];
            },
          }
    );
  };
  return {
    value,
    setValue,
    staged: context !== null,
    pending: context?.pending ?? false,
    dirty: draft?.dirty ?? false,
  };
}
