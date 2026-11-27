import { api } from '@client/app/contexts/ApiContext';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import type {
  CallableFunctionApprovalMode,
  CallableFunctionCallSummary,
  CallableFunctionExample,
  CallableFunctionGrantVisibility,
  CallableFunctionSlugHolder,
  CallableFunctionStampData,
  FunctionContract,
  FunctionContractChange,
  FunctionContractProblem,
  ICallableFunctionDetail,
  ICallableFunctionPublic,
  ICallableFunctionShared,
  ICallableFunctionSource,
  McpToolApprovalMode,
} from '@bike4mind/common';
import type { CallableFunctionShareView } from '@pages/api/callable-functions/[id]/grants';
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
    mutationFn: async ({ id, expectedVersion, contract }: CallableFunctionPinInput & { id: string }) =>
      (
        await api.post<ICallableFunctionPublic>(`${COLLECTION}/${encodeURIComponent(id)}/pin`, {
          expectedVersion,
          contract,
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

/** One of the owner's own tools with its contract; null `id` waits. Another person's tool answers 404. */
export function useCallableFunctionDetail(id: string | null) {
  const hasAccessToken = useAccessToken(s => !!s.accessToken);
  return useQuery({
    queryKey: [...CALLABLE_FUNCTIONS_LIST_QUERY_KEY, id, 'detail'],
    queryFn: async () => (await api.get<ICallableFunctionDetail>(`${COLLECTION}/${encodeURIComponent(id ?? '')}`)).data,
    enabled: hasAccessToken && !!id,
  });
}

/**
 * Runs the saved tool's declared tests on the server, against the pinned code, or only the named ones (those an
 * earlier run left not run); nothing is written but the call log.
 */
export const useRunCallableFunctionTests = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, tests }: { id: string; tests?: string[] }) =>
      (
        await api.post<CallableFunctionTestRun>(
          `${COLLECTION}/${encodeURIComponent(id)}/test-run`,
          tests ? { tests } : {}
        )
      ).data,
    onSettled: (_run, _error, { id }) => queryClient.invalidateQueries({ queryKey: callsQueryKey(id) }),
  });
};

const callsQueryKey = (id: string) => [...CALLABLE_FUNCTIONS_LIST_QUERY_KEY, id, 'calls'] as const;

/** How often an open calls panel re-reads, so calls made from chat, REST, or MCP show without a reload. */
export const CALLABLE_FUNCTION_CALLS_REFRESH_MS = 15_000;

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

/**
 * The owner's calls of the saved tool over the last 30 days; refetched with the list after any change to the tool,
 * after a server test run, and every `CALLABLE_FUNCTION_CALLS_REFRESH_MS` while shown.
 */
export function useCallableFunctionCalls(id: string) {
  return useQuery({
    queryKey: callsQueryKey(id),
    queryFn: async () =>
      (await api.get<CallableFunctionCallSummary>(`${COLLECTION}/${encodeURIComponent(id)}/calls`)).data,
    refetchInterval: CALLABLE_FUNCTION_CALLS_REFRESH_MS,
  });
}

const shareQueryKey = (id: string) => [...CALLABLE_FUNCTIONS_LIST_QUERY_KEY, id, 'grants'] as const;

/** The account holding exactly `email`, in any organization, for the owner of tool `id` to share with; null if none. */
export async function lookupCallableFunctionRecipient(
  id: string,
  email: string
): Promise<{ id: string; name: string } | null> {
  return (
    await api.get<{ id: string; name: string } | null>(`${COLLECTION}/${encodeURIComponent(id)}/recipient`, {
      params: { email },
    })
  ).data;
}

/**
 * The owner's share of the tool: its grants and the named people's names. Not kept once nothing watches it: the share
 * dialog seeds its form from this once, so a cached copy from before a save would be saved back over it.
 */
export function useCallableFunctionShare(id: string, enabled = true) {
  return useQuery({
    queryKey: shareQueryKey(id),
    queryFn: async () =>
      (await api.get<CallableFunctionShareView>(`${COLLECTION}/${encodeURIComponent(id)}/grants`)).data,
    enabled,
    gcTime: 0,
  });
}

/**
 * Removes the cached share after a save instead of refetching it: a refetch in flight keeps the query alive past
 * `gcTime: 0`, so a dialog reopened meanwhile would seed its form from the pre-save share.
 */
function useDropShare() {
  const queryClient = useQueryClient();
  return (id: string) => queryClient.removeQueries({ queryKey: shareQueryKey(id) });
}

export interface CallableFunctionShareInput {
  visibility: CallableFunctionGrantVisibility;
  projectId?: string;
  organizationId?: string;
  userIds: string[];
}

/** Replaces the tool's share; only a live tool can be shared. */
export const useShareCallableFunction = () => {
  const invalidate = useInvalidateCallableFunctions();
  const dropShare = useDropShare();
  return useMutation({
    mutationFn: async ({ id, ...share }: CallableFunctionShareInput & { id: string }) =>
      (await api.put<ICallableFunctionPublic>(`${COLLECTION}/${encodeURIComponent(id)}/grants`, share)).data,
    onSuccess: (_fn, { id }) => dropShare(id),
    onSettled: invalidate,
  });
};

export const useStopSharingCallableFunction = () => {
  const invalidate = useInvalidateCallableFunctions();
  const dropShare = useDropShare();
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.delete<ICallableFunctionPublic>(`${COLLECTION}/${encodeURIComponent(id)}/grants`)).data,
    onSuccess: (_fn, id) => dropShare(id),
    onSettled: invalidate,
  });
};

/** Records this person's review of a tool shared with them, naming the interface hash they were shown. */
export const useReviewSharedCallableFunction = () => {
  const invalidate = useInvalidateCallableFunctions();
  return useMutation({
    mutationFn: async ({ id, ...review }: { id: string; reviewHash: string; approval: CallableFunctionApprovalMode }) =>
      (await api.put<ICallableFunctionShared>(`${COLLECTION}/${encodeURIComponent(id)}/review`, review)).data,
    onSettled: invalidate,
  });
};

/** Changes this person's approval mode for a reviewed tool, or turns it off or on. */
export const useUpdateSharedCallableFunctionReview = () => {
  const invalidate = useInvalidateCallableFunctions();
  return useMutation({
    mutationFn: async ({
      id,
      ...settings
    }: {
      id: string;
      approval?: CallableFunctionApprovalMode;
      enabled?: boolean;
    }) => (await api.patch<ICallableFunctionShared>(`${COLLECTION}/${encodeURIComponent(id)}/review`, settings)).data,
    onSettled: invalidate,
  });
};

/** Tools other people shared with this person, with this person's review of each. */
export function useSharedCallableFunctions(enabled = true) {
  const hasAccessToken = useAccessToken(s => !!s.accessToken);
  return useQuery({
    queryKey: [...CALLABLE_FUNCTIONS_LIST_QUERY_KEY, 'shared'],
    queryFn: async () => (await api.get<ICallableFunctionShared[]>(`${COLLECTION}/shared`)).data,
    enabled: hasAccessToken && enabled,
  });
}

export const usePinCallableFunctionData = () => {
  const invalidate = useInvalidateCallableFunctions();
  return useMutation({
    mutationFn: async ({ id, fileId, name }: { id: string; fileId: string; name: string }) =>
      (await api.post<ICallableFunctionPublic>(`${COLLECTION}/${encodeURIComponent(id)}/data`, { fileId, name })).data,
    onSettled: invalidate,
  });
};

export const useSetCallableFunctionSources = () => {
  const invalidate = useInvalidateCallableFunctions();
  return useMutation({
    mutationFn: async ({ id, sources }: { id: string; sources: ICallableFunctionSource[] }) =>
      (await api.put<ICallableFunctionPublic>(`${COLLECTION}/${encodeURIComponent(id)}/sources`, { sources })).data,
    onSettled: invalidate,
  });
};

export const useUnpinCallableFunctionData = () => {
  const invalidate = useInvalidateCallableFunctions();
  return useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) =>
      (
        await api.delete<ICallableFunctionPublic>(
          `${COLLECTION}/${encodeURIComponent(id)}/data/${encodeURIComponent(name)}`
        )
      ).data,
    onSettled: invalidate,
  });
};

const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');

/** Verified pin bytes by sha256, so a repeat run fetches nothing; identical bytes are identical under any name. */
const dataBytesByHash = new Map<string, Promise<ArrayBuffer>>();

/** Test hook: forgets the cached pin bytes. */
export function resetCallableFunctionDataCache(): void {
  dataBytesByHash.clear();
}

/** Bytes from a link the read route answered with, checked against `sha256`; `label` names them in errors. */
async function readVerifiedBytes(url: string, sha256: string, label: string, mismatch: string) {
  let bytes: ArrayBuffer;
  if (url.startsWith('/')) {
    bytes = (await api.get<ArrayBuffer>(url, { responseType: 'arraybuffer' })).data;
  } else {
    // A signed link to the data bucket: no credentials, and nothing for the browser to keep.
    const response = await fetch(url, { credentials: 'omit', cache: 'no-store' });
    if (!response.ok) throw new Error(`The ${label} could not be read (${response.status}).`);
    bytes = await response.arrayBuffer();
  }
  if (hex(await globalThis.crypto.subtle.digest('SHA-256', bytes)) !== sha256) {
    throw new Error(`The ${label} ${mismatch}.`);
  }
  return bytes;
}

/** The verified bytes for `sha256`, read by `read` only when no earlier read of the same hash is cached. */
async function cachedBytes(sha256: string, read: () => Promise<ArrayBuffer>): Promise<ArrayBuffer> {
  let cached = dataBytesByHash.get(sha256);
  if (!cached) {
    cached = read();
    dataBytesByHash.set(sha256, cached);
    cached.catch(() => dataBytesByHash.delete(sha256));
  }
  return (await cached).slice(0);
}

async function fetchVerifiedDataBytes(id: string, pin: ICallableFunctionPublic['dataPins'][number]) {
  const { url } = (
    await api.get<{ url: string }>(`${COLLECTION}/${encodeURIComponent(id)}/data/${encodeURIComponent(pin.name)}`)
  ).data;
  return readVerifiedBytes(url, pin.sha256, `data file ${pin.name}`, 'does not match its pinned hash');
}

/**
 * The pinned bytes of a saved tool, each checked against its sha256 before Python sees it, for `/data/<name>` in the
 * browser. Each call returns fresh copies, so the caller can transfer them to the sandbox; the cached bytes stay.
 * Throws when a file cannot be read or does not match.
 */
export async function fetchCallableFunctionDataFiles(
  id: string,
  pins: ICallableFunctionPublic['dataPins']
): Promise<{ name: string; bytes: ArrayBuffer }[]> {
  return Promise.all(
    pins.map(async pin => ({
      name: pin.name,
      bytes: await cachedBytes(pin.sha256, () => fetchVerifiedDataBytes(id, pin)),
    }))
  );
}

/**
 * Each source's bytes for `/data/<name>` in the browser, read through the owner-only route that fetches them as a
 * server call would, with the stamp entry a server call would write. The bytes come from the same one-minute link and
 * hash cache as pinned files, as fresh copies. Throws when a source cannot be read or does not match.
 */
export async function fetchCallableFunctionSources(
  id: string,
  sources: ICallableFunctionPublic['sources']
): Promise<{ name: string; bytes: ArrayBuffer; entry: CallableFunctionStampData }[]> {
  return Promise.all(
    sources.map(async source => {
      const { entry, url } = (
        await api.get<{ entry: CallableFunctionStampData; url: string }>(
          `${COLLECTION}/${encodeURIComponent(id)}/sources/${encodeURIComponent(source.name)}`
        )
      ).data;
      const bytes = await cachedBytes(entry.sha256, () =>
        readVerifiedBytes(url, entry.sha256, `source ${source.name}`, 'does not match the hash it was read with')
      );
      return { name: source.name, bytes, entry: { ...entry, name: source.name } };
    })
  );
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
