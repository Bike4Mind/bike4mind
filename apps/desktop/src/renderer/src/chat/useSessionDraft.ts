import { useCallback, useEffect, useRef, useState } from 'react';
import { newSessionDefaultsSchema, type NewSessionDefaults } from '@shared/sessionDefaults';
import type { ChatAttachment, ChatSession, ChatSessionMode, CreateCodeSessionRequest } from '@shared/chat';
import type { ConversationController, SessionPlacement } from './useChat';
import { canHoldWorktree, worktreeByDefault } from './worktreeDefault';

export const isSessionDraft = (id: string | null): boolean => !!id?.startsWith('draft-');

const DEFAULT_FIELDS = ['model', 'approvalMode', 'reasoningEffort', 'promptCacheTtl'] as const;

async function retireDraftAttachments(id: string): Promise<void> {
  try {
    await window.b4m.chat.discardDraftAttachments(id);
  } catch (cause) {
    console.warn('Could not discard draft attachments', cause);
  }
}

export function useSessionDraft(onCreated: (id: string) => void, onListChanged: () => Promise<void>) {
  const [session, setSession] = useState<ChatSession | null>(null);
  const current = useRef(session);
  current.current = session;
  const placement = useRef<SessionPlacement | undefined>(undefined);
  const sending = useRef(false);
  const defaultsVersion = useRef(0);
  const explicitDefaults = useRef(new Set<keyof NewSessionDefaults>());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);

  const discard = useCallback(() => {
    const previous = current.current;
    current.current = null;
    setSession(null);
    setError(null);
    setProjectError(null);
    if (previous && !sending.current) void retireDraftAttachments(previous.id);
  }, []);

  useEffect(
    () => () => {
      const previous = current.current;
      current.current = null;
      if (previous && !sending.current) void retireDraftAttachments(previous.id);
    },
    []
  );

  const loadDefaults = useCallback(async (draftId: string): Promise<{ ok: true } | { ok: false; error: string }> => {
    const version = ++defaultsVersion.current;
    try {
      const defaults = newSessionDefaultsSchema.parse(await window.b4m.chat.defaultsForNewSession());
      const before = current.current;
      if (before?.id !== draftId || defaultsVersion.current !== version) return { ok: true };
      const next = { ...before };
      if (!explicitDefaults.current.has('model')) next.model = defaults.model;
      if (!explicitDefaults.current.has('approvalMode')) next.approvalMode = defaults.approvalMode;
      if (!explicitDefaults.current.has('reasoningEffort')) next.reasoningEffort = defaults.reasoningEffort;
      if (!explicitDefaults.current.has('promptCacheTtl')) next.promptCacheTtl = defaults.promptCacheTtl;
      current.current = next;
      setSession(next);
      return { ok: true };
    } catch (cause) {
      const message = 'Could not load new conversation preferences. Try again.';
      if (current.current?.id === draftId && defaultsVersion.current === version) {
        console.warn('Could not load new conversation preferences', cause);
        setError(message);
      }
      return { ok: false, error: message };
    }
  }, []);

  const start = useCallback(
    (mode: ChatSessionMode, request: CreateCodeSessionRequest = {}, place?: SessionPlacement) => {
      if (current.current?.mode === mode && !request.directory && placement.current?.sectionId === place?.sectionId)
        return current.current.id;
      discard();
      explicitDefaults.current = new Set();
      const now = new Date().toISOString();
      const next: ChatSession = {
        id: `draft-${crypto.randomUUID()}`,
        title: mode === 'code' ? 'New Code session' : 'New chat',
        mode,
        model: '',
        approvalMode: 'ask',
        reasoningEffort: 'default',
        createdAt: now,
        updatedAt: now,
        messages: [],
        ...(request.directory
          ? {
              project: {
                directory: request.directory,
                name: request.directory.split(/[\\/]/).pop() || request.directory,
                branch: request.branch ?? '',
                workspace: request.workspace ?? false,
                workingDirectory: request.directory,
                contextDirectories: [],
              },
            }
          : {}),
      };
      placement.current = place;
      current.current = next;
      setSession(next);
      void loadDefaults(next.id);
      return next.id;
    },
    [discard, loadDefaults]
  );

  const patch = useCallback(async (change: Partial<ChatSession>) => {
    if (!current.current || sending.current) return;
    for (const field of DEFAULT_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(change, field)) explicitDefaults.current.add(field);
    }
    const next = { ...current.current, ...change };
    current.current = next;
    setSession(next);
  }, []);

  const chooseDirectory = useCallback(
    async (directory: string) => {
      const before = current.current;
      const inspected = await window.b4m.chat.inspectProject(directory);
      if (!before || current.current?.id !== before.id) return;
      if (inspected.refusal) {
        setProjectError(inspected.refusal);
        return;
      }
      await patch({
        project: {
          directory,
          name: inspected.name,
          branch: inspected.currentBranch ?? '',
          workspace: worktreeByDefault() && canHoldWorktree(inspected),
          workingDirectory: directory,
          contextDirectories: [],
        },
      });
      setProjectError(inspected.error ?? null);
    },
    [patch]
  );

  const share = useCallback(
    async (path?: string) => {
      const before = current.current;
      let directory: string | null;
      try {
        directory = path ?? (await window.b4m.chat.pickProjectDirectory());
      } catch (cause) {
        if (before && current.current?.id === before.id)
          setError(cause instanceof Error ? cause.message : String(cause));
        return;
      }
      if (!before || !directory || current.current?.id !== before.id) return;
      const latest = current.current;
      if (latest.project)
        await patch({
          project: {
            ...latest.project,
            contextDirectories: [...new Set([...latest.project.contextDirectories, directory])],
          },
        });
      else await patch({ grantedDirectories: [...new Set([...(latest.grantedDirectories ?? []), directory])] });
    },
    [patch]
  );

  const send = useCallback(
    async (text: string, attachments: readonly ChatAttachment[] = []) => {
      const initial = current.current;
      if (!initial || sending.current) return false;
      const draftId = initial.id;
      sending.current = true;
      setBusy(true);
      setError(null);
      let id: string | null = null;
      let accepted = false;
      try {
        const loaded = await loadDefaults(draftId);
        if (!loaded.ok) throw new Error(loaded.error);
        const draft = current.current;
        if (!draft || draft.id !== draftId) return false;
        const deliberate = new Set(explicitDefaults.current);
        const place = placement.current;
        const section = place ? { sectionId: place.sectionId } : undefined;
        const created =
          draft.mode === 'code'
            ? await window.b4m.chat.createCodeSession({
                ...section,
                ...(draft.project
                  ? {
                      directory: draft.project.directory,
                      branch: draft.project.branch,
                      workspace: draft.project.workspace,
                    }
                  : {}),
              })
            : await window.b4m.chat.createSession(section);
        if (!('session' in created)) throw new Error(created.error);
        id = created.session.id;
        const requireSaved = (value: unknown) => {
          if (!value) throw new Error('Could not apply the draft settings.');
        };
        if (deliberate.has('model') && draft.model)
          requireSaved(await window.b4m.chat.setSessionModel(id, draft.model));
        if (deliberate.has('approvalMode')) requireSaved(await window.b4m.chat.setApprovalMode(id, draft.approvalMode));
        if (deliberate.has('reasoningEffort'))
          requireSaved(await window.b4m.chat.setSessionReasoningEffort(id, draft.reasoningEffort));
        if (deliberate.has('promptCacheTtl') && draft.promptCacheTtl)
          requireSaved(await window.b4m.chat.setSessionPromptCacheTtl(id, draft.promptCacheTtl));
        if (draft.generation) requireSaved(await window.b4m.chat.setSessionGeneration(id, draft.generation));
        if (draft.historyEnabled !== undefined)
          requireSaved(await window.b4m.chat.setSessionHistory(id, draft.historyEnabled));
        if (draft.orchestrate) requireSaved(await window.b4m.chat.setSessionOrchestrate(id, true));
        for (const path of draft.project?.contextDirectories ?? draft.grantedDirectories ?? []) {
          const result = await window.b4m.chat.addContextDirectory(id, path);
          if (result.status === 'refused') throw new Error(result.error);
        }
        await window.b4m.chat.copyDraftAttachments(
          draft.id,
          id,
          attachments.map(attachment => attachment.id)
        );
        const result = await window.b4m.chat.sendMessage({ sessionId: id, text, attachments: [...attachments] });
        if (!result.ok) throw new Error(result.error);
        accepted = true;
        if (created.sidebarSections) place?.placed(created.sidebarSections);
        else if (created.placementFailed) place?.failed();
        try {
          await onListChanged();
        } finally {
          // Once accepted, a failed sidebar refresh must not leave a resendable draft.
          if (current.current?.id === draft.id) {
            current.current = null;
            setSession(null);
            onCreated(id);
          }
        }
        await window.b4m.chat.discardDraftAttachments(draft.id);
        return true;
      } catch (cause) {
        if (id && !accepted) {
          try {
            await window.b4m.chat.deleteSession(id);
          } catch {
            if (current.current?.id === draftId)
              setError('Could not remove the unsent conversation. Delete it from the sidebar before retrying.');
            return false;
          }
        }
        if (current.current?.id === draftId) setError(cause instanceof Error ? cause.message : String(cause));
        return accepted;
      } finally {
        if (current.current?.id !== draftId) void retireDraftAttachments(draftId);
        sending.current = false;
        setBusy(false);
      }
    },
    [onCreated, onListChanged, loadDefaults]
  );

  const wrap = (base: ConversationController): ConversationController => {
    if (!session) return base;
    const changeProject = async (change: Partial<NonNullable<ChatSession['project']>>) => {
      const project = current.current?.project;
      if (project) await patch({ project: { ...project, ...change } });
    };
    return {
      ...base,
      session,
      messages: [],
      sendError: error,
      send,
      setModel: model => patch({ model }),
      setApprovalMode: approvalMode => patch({ approvalMode }),
      setReasoningEffort: reasoningEffort => patch({ reasoningEffort }),
      setPromptCacheTtl: promptCacheTtl => patch({ promptCacheTtl }),
      setGeneration: async generation => {
        await patch({ generation });
        return true;
      },
      setHistory: historyEnabled => patch({ historyEnabled }),
      setOrchestrate: orchestrate => patch({ orchestrate }),
      settleLocalModel: async () => undefined,
      addContextDirectoryTo: async (_target, path) => {
        await share(path);
        return undefined;
      },
      runCommand: async (name, args) => {
        if (name === 'add-dir') await share(args.trim() || undefined);
        else setError(`Send a message first before using /${name}.`);
      },
      project: {
        busy,
        error: projectError ? { message: projectError, busy: false } : null,
        dismissError: () => setProjectError(null),
        chooseDirectory,
        pickDirectory: async () => {
          const path = await window.b4m.chat.pickProjectDirectory();
          if (path) await chooseDirectory(path);
        },
        setBranch: branch => changeProject({ branch }),
        setWorkspace: workspace => changeProject({ workspace }),
        worktreeFrom: branch => changeProject({ branch, workspace: true }),
        moveToCheckout: async elsewhere => {
          await chooseDirectory(elsewhere.path);
          await changeProject({ workspace: false, branch: elsewhere.branch });
        },
        addContextDirectory: () => share(),
        removeContextDirectory: async directory => {
          if (session.project)
            await changeProject({
              contextDirectories: session.project.contextDirectories.filter(path => path !== directory),
            });
          else await patch({ grantedDirectories: session.grantedDirectories?.filter(path => path !== directory) });
        },
      },
    };
  };
  return { session, start, discard, wrap, busy, patch, share };
}
