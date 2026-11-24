import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type {
  ISkillListingTemplate,
  SkillTemplateDraft,
  SkillTemplateEditorView,
  SkillTemplateUpdate,
} from '@bike4mind/common';

/** The listing author's template editor (pages/api/skills/market/[id]/template/*). */

const IMAGE_STATUS_POLL_MS = 3000;
// Bounds the moderation poll if a check never lands (about five minutes of a single pending image).
const MAX_IMAGE_STATUS_POLLS = 100;
const GENERATION_POLL_MS = 3000;
const MAX_GENERATION_POLLS = 100;
const MAX_CONSECUTIVE_POLL_ERRORS = 3;

type TemplateResponse = { template: ISkillListingTemplate };

export const skillTemplateKey = (listingId: string) => ['skill-market', 'template', listingId] as const;

export const useSkillTemplate = (listingId: string) =>
  useQuery({
    queryKey: skillTemplateKey(listingId),
    queryFn: async () => (await api.get<SkillTemplateEditorView>(`/api/skills/market/${listingId}/template`)).data,
    refetchInterval: query =>
      query.state.data?.previewImageStatus === 'pending' && query.state.dataUpdateCount < MAX_IMAGE_STATUS_POLLS
        ? IMAGE_STATUS_POLL_MS
        : false,
    retry: false,
  });

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
