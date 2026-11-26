import { useRef } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type {
  ISkillListingTemplate,
  SkillTemplateDraft,
  SkillTemplateEditorView,
  SkillTemplateExampleRun,
  SkillTemplateExampleUpdate,
  SkillTemplateUpdate,
} from '@bike4mind/common';
import { skillTemplatePreviewPath } from '@bike4mind/common';

/** The listing author's template editor (pages/api/skills/market/[id]/template/*). */

const IMAGE_STATUS_POLL_MS = 3000;
// Bounds the moderation poll if a check never lands (about five minutes of a single pending image).
const MAX_IMAGE_STATUS_POLLS = 100;
const GENERATION_POLL_MS = 3000;
const MAX_GENERATION_POLLS = 100;
const MAX_CONSECUTIVE_POLL_ERRORS = 3;
const EXAMPLE_RUN_POLL_MS = 3000;
// About as long as the server waits before it treats a run as lost (EXAMPLE_RUN_STALE_MS).
const MAX_EXAMPLE_RUN_POLLS = 300;

type TemplateResponse = { template: ISkillListingTemplate };

export const skillTemplateKey = (listingId: string) => ['skill-market', 'template', listingId] as const;

/** Poll while an example run or an image check is in flight; stop once it settles. */
export function skillTemplatePollMs(data: SkillTemplateEditorView | undefined, polls: number): number | false {
  if (data?.template?.example?.status === 'running' && polls < MAX_EXAMPLE_RUN_POLLS) return EXAMPLE_RUN_POLL_MS;
  if (data?.previewImageStatus === 'pending' && polls < MAX_IMAGE_STATUS_POLLS) return IMAGE_STATUS_POLL_MS;
  return false;
}

/** Names what is being waited on, so the poll budget restarts for each new run or image. */
export function skillTemplatePollKey(data: SkillTemplateEditorView | undefined): string {
  if (data?.template?.example?.status === 'running') return `example:${String(data.template.example.runAt ?? '')}`;
  if (data?.previewImageStatus === 'pending') return `image:${data.template?.previewImage?.fabFileId ?? ''}`;
  return '';
}

export type SkillTemplatePollState = { key: string; polls: number };

/** One refetch decision, counting polls per run: the count restarts whenever the key changes. */
export function nextSkillTemplatePoll(
  state: SkillTemplatePollState,
  data: SkillTemplateEditorView | undefined
): { state: SkillTemplatePollState; ms: number | false } {
  const key = skillTemplatePollKey(data);
  const polls = state.key === key ? state.polls : 0;
  const ms = skillTemplatePollMs(data, polls);
  return { state: { key, polls: ms === false ? polls : polls + 1 }, ms };
}

export const useSkillTemplate = (listingId: string) => {
  const pollState = useRef<SkillTemplatePollState>({ key: '', polls: 0 });
  return useQuery({
    queryKey: skillTemplateKey(listingId),
    queryFn: async () => (await api.get<SkillTemplateEditorView>(`/api/skills/market/${listingId}/template`)).data,
    refetchInterval: query => {
      const next = nextSkillTemplatePoll(pollState.current, query.state.data);
      pollState.current = next.state;
      return next.ms;
    },
    retry: false,
  });
};

type GenerationQuest = { images?: string[]; type?: string; status?: string };

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Polls an image generation until it has an image; throws when it fails or never finishes. A failed
 * poll request is retried, so one network blip does not lose a paid generation.
 */
export async function waitForGeneratedImage(
  questId: string,
  { intervalMs = GENERATION_POLL_MS, maxPolls = MAX_GENERATION_POLLS } = {}
): Promise<void> {
  let consecutiveErrors = 0;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    let data: GenerationQuest;
    try {
      data = (await api.get<GenerationQuest>(`/api/quests/${questId}`)).data;
      consecutiveErrors = 0;
    } catch (error) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) throw error;
      await sleep(intervalMs);
      continue;
    }
    if (data.images?.length) return;
    if (data.type === 'error' || data.status === 'error' || data.status === 'failed') {
      throw new Error('The image generation failed. Try again.');
    }
    await sleep(intervalMs);
  }
  throw new Error('The image is taking too long. Try again in a moment.');
}

/** A template write; the editor view and My listings refetch after it. */
function useTemplateMutation<TInput = void>(write: (input: TInput) => Promise<TemplateResponse>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: TInput) => (await write(input)).template,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['skill-market'], predicate: query => query.queryKey[1] !== 'me' });
    },
  });
}

/** Proposes copy from the approved version. Nothing is stored until the author saves. */
export const useDraftSkillTemplate = (listingId: string) =>
  useMutation({
    mutationFn: async () => {
      const url = `/api/skills/market/${listingId}/template/draft`;
      return (await api.post<{ draft: SkillTemplateDraft; generatedFromVersionId: string }>(url)).data;
    },
  });

export const useSaveSkillTemplate = (listingId: string) =>
  useTemplateMutation(async (body: SkillTemplateUpdate) => {
    const url = `/api/skills/market/${listingId}/template`;
    return (await api.put<TemplateResponse>(url, body)).data;
  });

export const usePublishSkillTemplate = (listingId: string) =>
  useTemplateMutation(async () => {
    const url = `/api/skills/market/${listingId}/template/publish`;
    return (await api.post<TemplateResponse>(url)).data;
  });

export const useUnpublishSkillTemplate = (listingId: string) =>
  useTemplateMutation(async () => {
    const url = `/api/skills/market/${listingId}/template/publish`;
    return (await api.delete<TemplateResponse>(url)).data;
  });

export const useSetSkillTemplateFreeRun = (listingId: string) =>
  useTemplateMutation(async (enabled: boolean) => {
    const url = `/api/skills/market/${listingId}/template/free-run`;
    return (await api.put<TemplateResponse>(url, { enabled })).data;
  });

/** Uses a file the author just uploaded as the preview image. */
export const useSetSkillTemplateImage = (listingId: string) =>
  useTemplateMutation(async (fabFileId: string) => {
    const url = `/api/skills/market/${listingId}/template/image`;
    return (await api.put<TemplateResponse>(url, { fabFileId })).data;
  });

/** Generates an image from a pasted result (billed to the author), waits for it, then uses it. */
export const useGenerateSkillTemplateImage = (listingId: string) =>
  useTemplateMutation(async (result: string) => {
    const generateUrl = `/api/skills/market/${listingId}/template/image/generate`;
    const { questId } = (await api.post<{ questId: string }>(generateUrl, { result })).data;
    await waitForGeneratedImage(questId);
    const fromGenerationUrl = `/api/skills/market/${listingId}/template/image/from-generation`;
    return (await api.post<TemplateResponse>(fromGenerationUrl, { questId })).data;
  });

export const useApproveSkillTemplateImage = (listingId: string) =>
  useTemplateMutation(async () => {
    const url = `/api/skills/market/${listingId}/template/image/approve`;
    return (await api.post<TemplateResponse>(url)).data;
  });

export const useRemoveSkillTemplateImage = (listingId: string) =>
  useTemplateMutation(async () => {
    const url = `/api/skills/market/${listingId}/template/image`;
    return (await api.delete<TemplateResponse>(url)).data;
  });

/** Starts an example run on the platform's keys; the template comes back `running` (202). */
export const useRunSkillTemplateExample = (listingId: string) =>
  useTemplateMutation(async (body: SkillTemplateExampleRun) => {
    const url = `/api/skills/market/${listingId}/template/example`;
    return (await api.post<TemplateResponse>(url, body)).data;
  });

/** The demo switch, a reply trim or the sample file. */
export const useEditSkillTemplateExample = (listingId: string) =>
  useTemplateMutation(async (body: SkillTemplateExampleUpdate) => {
    const url = `/api/skills/market/${listingId}/template/example`;
    return (await api.put<TemplateResponse>(url, body)).data;
  });

/**
 * The author's page as the public page draws it. Fetched with the API's token, since an iframe `src`
 * cannot send it; `stamp` changes whenever the stored template does, which refetches it.
 */
export const useSkillTemplatePreviewHtml = (listingId: string, stamp: string, enabled: boolean) =>
  useQuery({
    queryKey: [...skillTemplateKey(listingId), 'preview', stamp],
    queryFn: async () =>
      (
        await api.get<string>(skillTemplatePreviewPath(listingId), {
          responseType: 'text',
        })
      ).data,
    enabled,
    placeholderData: keepPreviousData,
    retry: false,
  });

export type SkillTemplateTryResult = { skillName: string; examplePrompt: string; imported: boolean };

/** Reuse or import a template page's skill for the signed-in visitor (pages/api/skills/template/try/[slug].ts). */
export const useTrySkillTemplate = () =>
  useMutation({
    mutationFn: async (slug: string) =>
      (await api.post<SkillTemplateTryResult>(`/api/skills/template/try/${encodeURIComponent(slug)}`)).data,
  });
