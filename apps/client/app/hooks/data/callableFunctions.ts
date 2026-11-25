import { api } from '@client/app/contexts/ApiContext';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import type {
  CallableFunctionCallSummary,
  CallableFunctionExample,
  CallableFunctionSlugHolder,
  FunctionContract,
  FunctionContractChange,
  FunctionContractProblem,
  ICallableFunctionPublic,
  McpToolApprovalMode,
} from '@bike4mind/common';
import type { CallableFunctionsStatus } from '@pages/api/callable-functions/status';
import type { CallableFunctionTestRun } from '@pages/api/callable-functions/[id]/test-run';
import type { CallableFunctionPromotion } from '@pages/api/callable-functions/[id]/promote';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { CALLABLE_FUNCTIONS_LIST_QUERY_KEY, CALLABLE_FUNCTIONS_STATUS_QUERY_KEY } from './queryKeys';

// Client for pages/api/callable-functions/**. Request bodies mirror
// apps/client/server/validators/callableFunctionValidators.ts, which refuses unknown keys.

const COLLECTION = '/api/callable-functions';

function useCallableFunctionsStatus(): CallableFunctionsStatus | undefined {
  const hasAccessToken = useAccessToken(s => !!s.accessToken);
  const { data } = useQuery({
    queryKey: CALLABLE_FUNCTIONS_STATUS_QUERY_KEY,
    queryFn: async () => (await api.get<CallableFunctionsStatus>('/api/callable-functions/status')).data,
    enabled: hasAccessToken,
    staleTime: 5 * 60 * 1000,
  });
  return data;
}

/** Whether this user may call Python artifact functions. False while loading and on any error. */
export function useCallableFunctionsEnabled(): boolean {
  return useCallableFunctionsStatus()?.enabled === true;
}

/** Whether this stage can run functions on the server. False while loading and on any error. */
export function useCallableFunctionsServerRuntime(): boolean {
  return useCallableFunctionsStatus()?.serverRuntime === true;
}

export {
  mcpConnectionErrorMessage as callableFunctionErrorMessage,
  mcpConnectionErrorCode as callableFunctionErrorCode,
} from './mcpConnections';

/** The cases a 409 `cases_left` names as not yet passed on this version; empty for any other error. */
export function callableFunctionCasesLeft(error: unknown): { kind: 'test' | 'example'; name: string }[] {
  if (!isAxiosError(error)) return [];
  const data = error.response?.data as { code?: unknown; left?: unknown } | undefined;
  if (data?.code !== 'cases_left' || !Array.isArray(data.left)) return [];
  return data.left.filter(
    (entry): entry is { kind: 'test' | 'example'; name: string } =>
      (entry?.kind === 'test' || entry?.kind === 'example') && typeof entry?.name === 'string'
  );
}

/** The problems a 400 `invalid_contract` lists; empty for any other error. */
export function callableFunctionErrorProblems(error: unknown): FunctionContractProblem[] {
  if (!isAxiosError(error)) return [];
  const problems = (error.response?.data as { problems?: unknown } | undefined)?.problems;
  if (!Array.isArray(problems)) return [];
  return problems.filter(
    (problem): problem is FunctionContractProblem =>
      typeof problem?.path === 'string' && typeof problem?.message === 'string'
  );
}

/** The tool a 409 `slug_taken` names as holding the name; null for any other error. */
export function callableFunctionSlugHolder(error: unknown): CallableFunctionSlugHolder | null {
  if (!isAxiosError(error)) return null;
  const data = error.response?.data as { code?: unknown; functionId?: unknown; sourceDeleted?: unknown } | undefined;
  if (data?.code !== 'slug_taken' || typeof data.functionId !== 'string' || typeof data.sourceDeleted !== 'boolean') {
    return null;
  }
  return { functionId: data.functionId, sourceDeleted: data.sourceDeleted };
}

const CHANGE_SIDES: readonly unknown[] = ['inputs', 'outputs', null];

/** The changes a 409 `breaking_change` lists; empty for any other error. */
export function callableFunctionBreakingChanges(error: unknown): FunctionContractChange[] {
  if (!isAxiosError(error)) return [];
  const data = error.response?.data as { code?: unknown; changes?: unknown } | undefined;
  if (data?.code !== 'breaking_change' || !Array.isArray(data.changes)) return [];
  return data.changes.filter(
    (change): change is FunctionContractChange =>
      typeof change?.path === 'string' &&
      typeof change?.field === 'string' &&
      typeof change?.kind === 'string' &&
      CHANGE_SIDES.includes(change?.side)
  );
}

/** The promotion a 409 `breaking_change` measured against; null when the tool was never promoted. */
export function callableFunctionBreakingSincePromotion(error: unknown): number | null {
  if (!isAxiosError(error)) return null;
  const data = error.response?.data as { code?: unknown; promotedSeq?: unknown } | undefined;
  return data?.code === 'breaking_change' && typeof data.promotedSeq === 'number' ? data.promotedSeq : null;
}

/** Whether a 409 `contract_unreadable` refused an update: the stored contract no longer parses. */
export function callableFunctionContractUnreadable(error: unknown): boolean {
  if (!isAxiosError(error)) return false;
  return (error.response?.data as { code?: unknown } | undefined)?.code === 'contract_unreadable';
}

export interface ArtifactCallableFunctions {
  /** The tool saved under `name`, or null when there is none. */
  saved: ICallableFunctionPublic | null;
  /** The artifact's tools under other names, oldest first. */
  others: ICallableFunctionPublic[];
}

/**
 * The tools saved from this artifact, split by whether their name is `name`; an artifact holds one tool per name.
 * `version` is the artifact version the viewer shows; it is part of the key so that saving the artifact re-reads
 * whether a newer version is available.
 */
export function useArtifactCallableFunction(artifactId: string | null, version: number, name: string) {
  const hasAccessToken = useAccessToken(s => !!s.accessToken);
  return useQuery({
    queryKey: [...CALLABLE_FUNCTIONS_LIST_QUERY_KEY, artifactId, version],
    queryFn: async () => (await api.get<ICallableFunctionPublic[]>(COLLECTION, { params: { artifactId } })).data,
    select: (functions: ICallableFunctionPublic[]): ArtifactCallableFunctions => ({
      saved: functions.find(fn => fn.slug === name) ?? null,
      others: functions.filter(fn => fn.slug !== name),
    }),
    enabled: hasAccessToken && !!artifactId,
  });
}

export interface CallableFunctionPinInput {
  /** The artifact version the person saw; the server answers 409 when the artifact has moved on since. */
  expectedVersion: number;
  contract: FunctionContract;
}

/** Every write re-reads the list, a failed one too: a create refused as a duplicate means the list was stale. */
function useInvalidateCallableFunctions() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: CALLABLE_FUNCTIONS_LIST_QUERY_KEY });
  };
}

export const useCreateCallableFunction = () => {
  const invalidate = useInvalidateCallableFunctions();
  return useMutation({
    mutationFn: async ({ artifactId, expectedVersion, contract }: CallableFunctionPinInput & { artifactId: string }) =>
      (await api.post<ICallableFunctionPublic>(COLLECTION, { artifactId, expectedVersion, contract })).data,
    onSettled: invalidate,
  });
};

export const useRepinCallableFunction = () => {
  const invalidate = useInvalidateCallableFunctions();
  return useMutation({
    mutationFn: async ({
      id,
      expectedVersion,
      contract,
      acceptBreaking,
    }: CallableFunctionPinInput & { id: string; acceptBreaking?: true }) =>
      (
        await api.post<ICallableFunctionPublic>(`${COLLECTION}/${encodeURIComponent(id)}/pin`, {
          expectedVersion,
          contract,
          ...(acceptBreaking ? { acceptBreaking } : {}),
        })
      ).data,
    onSettled: invalidate,
  });
};

export const useSetCallableFunctionEnabled = () => {
  const invalidate = useInvalidateCallableFunctions();
  return useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) =>
      (await api.patch<ICallableFunctionPublic>(`${COLLECTION}/${encodeURIComponent(id)}`, { enabled })).data,
    onSettled: invalidate,
  });
};

export const useSetCallableFunctionApproval = () => {
  const invalidate = useInvalidateCallableFunctions();
  return useMutation({
    mutationFn: async ({ id, approval }: { id: string; approval: McpToolApprovalMode }) =>
      (await api.patch<ICallableFunctionPublic>(`${COLLECTION}/${encodeURIComponent(id)}`, { approval })).data,
    onSettled: invalidate,
  });
};

/** Every tool the person saved, oldest first; off until the setting is on. */
export function useCallableFunctionList(enabled: boolean) {
  const hasAccessToken = useAccessToken(s => !!s.accessToken);
  return useQuery({
    queryKey: [...CALLABLE_FUNCTIONS_LIST_QUERY_KEY, 'all'],
    queryFn: async () => (await api.get<ICallableFunctionPublic[]>(COLLECTION)).data,
    enabled: hasAccessToken && enabled,
  });
}

/**
 * Runs the saved tool's declared tests on the server, against the pinned code, or only the named ones (those an
 * earlier run left not run); nothing is written but the call log.
 */
export const useRunCallableFunctionTests = () =>
  useMutation({
    mutationFn: async ({ id, tests }: { id: string; tests?: string[] }) =>
      (
        await api.post<CallableFunctionTestRun>(
          `${COLLECTION}/${encodeURIComponent(id)}/test-run`,
          tests ? { tests } : {}
        )
      ).data,
  });

const callsQueryKey = (id: string) => [...CALLABLE_FUNCTIONS_LIST_QUERY_KEY, id, 'calls'] as const;

/**
 * Promotes the saved tool to live once the server reads its contract and runs every declared test and worked example;
 * a refusal is a 4xx whose message names the reason.
 */
export const usePromoteCallableFunction = () => {
  const invalidate = useInvalidateCallableFunctions();
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.post<CallableFunctionPromotion>(`${COLLECTION}/${encodeURIComponent(id)}/promote`, {})).data,
    onSettled: invalidate,
  });
};

/** Replaces the saved tool's worked examples. */
export const useSetCallableFunctionExamples = () => {
  const invalidate = useInvalidateCallableFunctions();
  return useMutation({
    mutationFn: async ({ id, examples }: { id: string; examples: CallableFunctionExample[] }) =>
      (await api.put<ICallableFunctionPublic>(`${COLLECTION}/${encodeURIComponent(id)}/examples`, { examples })).data,
    onSettled: invalidate,
  });
};

/** The owner's calls of the saved tool over the last 30 days; refetched with the list after any change to the tool. */
export function useCallableFunctionCalls(id: string) {
  return useQuery({
    queryKey: callsQueryKey(id),
    queryFn: async () =>
      (await api.get<CallableFunctionCallSummary>(`${COLLECTION}/${encodeURIComponent(id)}/calls`)).data,
  });
}

export const useDeleteCallableFunction = () => {
  const invalidate = useInvalidateCallableFunctions();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`${COLLECTION}/${encodeURIComponent(id)}`);
    },
    onSettled: invalidate,
  });
};
