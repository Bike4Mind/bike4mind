import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { ISkill, IUserShare, Permission } from '@bike4mind/common';

/** Page size for the skills list. The API caps `limit` at 100; we page through. */
const SKILLS_PAGE_SIZE = 100;
/** Hard ceiling on pages fetched, so a runaway loop can't hammer the API. */
const SKILLS_MAX_PAGES = 50;

/**
 * A skill as returned by the API - `ISkill` plus the sharing fields the
 * Mongoose document carries (`ShareableDocumentSchema`). `ISkill` itself omits
 * them; the share-management UI needs them, so widen the read types here.
 */
export type ISkillWithSharing = ISkill & {
  users?: IUserShare[];
  isGlobalRead?: boolean;
  isGlobalWrite?: boolean;
};

/** Desired sharing state sent to PUT /api/skills/:id/share (PUT = full replace). */
export type SkillSharingInput = {
  users?: Array<{ userId: string; permissions: Permission[] }>;
  isGlobalRead?: boolean;
  isGlobalWrite?: boolean;
};

/**
 * Fetch the user's accessible skills (owned + shared + global-read).
 *
 * Mirrors `useGetAgents` - long stale window because skill definitions
 * change rarely, and `useGetSkills` is read on every chat-input render to
 * power the `/`-suggestion picker. Manual invalidation from the
 * Skills management UI refreshes after CRUD.
 */
export const useGetSkills = (enabled: boolean = true) => {
  return useQuery({
    queryKey: ['skills'],
    queryFn: async (): Promise<ISkill[]> => {
      // Page through so a user (or admin, once global/org skills exist in
      // volume) past the first page isn't silently truncated in the picker.
      const all: ISkill[] = [];
      for (let page = 1; page <= SKILLS_MAX_PAGES; page++) {
        const response = await api.get<{ data: ISkill[]; hasMore: boolean; total: number }>(
          `/api/skills?limit=${SKILLS_PAGE_SIZE}&page=${page}`
        );
        all.push(...response.data.data);
        if (!response.data.hasMore) break;
      }
      return all;
    },
    enabled,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
};

export const useGetSkill = (id: string | undefined) => {
  return useQuery({
    queryKey: ['skill', id],
    queryFn: async (): Promise<ISkillWithSharing> => {
      const response = await api.get<ISkillWithSharing>(`/api/skills/${id}`);
      return response.data;
    },
    enabled: Boolean(id),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
};

export type SkillFormInput = Pick<ISkill, 'name' | 'description' | 'body'> &
  Partial<Pick<ISkill, 'argumentHint' | 'allowedTools' | 'disableModelInvocation'>>;

export const useCreateSkill = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SkillFormInput): Promise<ISkill> => {
      const response = await api.post<ISkill>('/api/skills', input);
      return response.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['skills'] });
    },
  });
};

export const useUpdateSkill = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...patch }: { id: string } & Partial<SkillFormInput>): Promise<ISkill> => {
      const response = await api.put<ISkill>(`/api/skills/${id}`, patch);
      return response.data;
    },
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['skills'] });
      void qc.invalidateQueries({ queryKey: ['skill', vars.id] });
    },
  });
};

export const useDeleteSkill = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      await api.delete(`/api/skills/${id}`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['skills'] });
    },
  });
};

export const useUpdateSkillSharing = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...sharing }: { id: string } & SkillSharingInput): Promise<ISkillWithSharing> => {
      const response = await api.put<ISkillWithSharing>(`/api/skills/${id}/share`, sharing);
      return response.data;
    },
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['skills'] });
      void qc.invalidateQueries({ queryKey: ['skill', vars.id] });
    },
  });
};

/** Minimal user shape resolved by email for the share dialog. */
export type ResolvedShareUser = { id: string; name?: string; email?: string };

/**
 * Resolve a user by exact email so the share dialog can add them by address
 * (avoids exposing the full user directory in an autocomplete). Returns null
 * when no user matches.
 */
export const lookupUserByEmail = async (email: string): Promise<ResolvedShareUser | null> => {
  const response = await api.get<ResolvedShareUser | null>(`/api/users/by-email/${encodeURIComponent(email)}`);
  return response.data ?? null;
};
