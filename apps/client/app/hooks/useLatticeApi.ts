/**
 * useLatticeApi
 *
 * React Query hooks for Lattice model API operations.
 * Provides CRUD operations, hydration, and entity/rule management.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type {
  ILatticeModel,
  ILatticeComputedValues,
  ILatticeError,
  LatticeModelType,
  LatticeEntityType,
  LatticeRuleType,
  LatticeDataType,
  ILatticeRuleDefinition,
  PrimitiveValue,
} from '@bike4mind/common';

// TYPES

interface ListModelsParams {
  limit?: number;
  skip?: number;
  sessionId?: string;
  projectId?: string;
}

interface CreateModelParams {
  name: string;
  description?: string;
  modelType?: LatticeModelType;
  sessionId?: string;
  projectId?: string;
}

interface UpdateModelParams {
  id: string;
  name?: string;
  description?: string;
  settings?: Partial<ILatticeModel['settings']>;
}

interface AddEntityParams {
  modelId: string;
  entityId: string;
  name: string;
  type: LatticeEntityType;
  displayName?: string;
  attributes?: Array<{
    key: string;
    value: number | string | boolean | null;
    dataType?: LatticeDataType;
  }>;
  metadata?: Record<string, unknown>;
}

interface SetValueParams {
  modelId: string;
  entityId: string;
  attributeKey: string;
  value: PrimitiveValue;
}

interface AddRuleParams {
  modelId: string;
  ruleId: string;
  name: string;
  type: LatticeRuleType;
  description?: string;
  definition: ILatticeRuleDefinition;
  dependencies?: string[];
  priority?: number;
  enabled?: boolean;
}

interface HydrateParams {
  modelId: string;
  scenarioId?: string;
}

interface HydrateResult {
  success: boolean;
  computedValues: ILatticeComputedValues;
  errors: ILatticeError[];
  computedAt: string;
}

// Query keys
const LATTICE_KEYS = {
  all: ['lattice'] as const,
  models: () => [...LATTICE_KEYS.all, 'models'] as const,
  modelsList: (params?: ListModelsParams) => [...LATTICE_KEYS.models(), 'list', params] as const,
  model: (id: string) => [...LATTICE_KEYS.models(), id] as const,
};

// LIST MODELS

export function useLatticeModels(params: ListModelsParams = {}) {
  return useQuery({
    queryKey: LATTICE_KEYS.modelsList(params),
    queryFn: async () => {
      const response = await api.get<{
        data: ILatticeModel[];
        meta: { total: number; limit: number; skip: number };
      }>('/api/lattice/models', { params });
      return response.data;
    },
    staleTime: 30000, // 30 seconds
  });
}

// GET MODEL

export function useLatticeModel(modelId: string | undefined) {
  return useQuery({
    queryKey: LATTICE_KEYS.model(modelId || ''),
    queryFn: async () => {
      if (!modelId) return null;
      const response = await api.get<ILatticeModel>(`/api/lattice/models/${modelId}`);
      return response.data;
    },
    enabled: !!modelId,
    staleTime: 30000,
  });
}

// CREATE MODEL

export function useCreateLatticeModel() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: CreateModelParams) => {
      const response = await api.post<ILatticeModel>('/api/lattice/models', params);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: LATTICE_KEYS.models() });
    },
  });
}

// UPDATE MODEL

export function useUpdateLatticeModel() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...params }: UpdateModelParams) => {
      const response = await api.put<ILatticeModel>(`/api/lattice/models/${id}`, params);
      return response.data;
    },
    onSuccess: data => {
      queryClient.invalidateQueries({ queryKey: LATTICE_KEYS.model(data.id) });
      queryClient.invalidateQueries({ queryKey: LATTICE_KEYS.models() });
    },
  });
}

// DELETE MODEL

export function useDeleteLatticeModel() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (modelId: string) => {
      await api.delete(`/api/lattice/models/${modelId}`);
      return modelId;
    },
    onSuccess: modelId => {
      queryClient.invalidateQueries({ queryKey: LATTICE_KEYS.model(modelId) });
      queryClient.invalidateQueries({ queryKey: LATTICE_KEYS.models() });
    },
  });
}

// ADD ENTITY

export function useAddLatticeEntity() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ modelId, ...params }: AddEntityParams) => {
      const response = await api.post<ILatticeModel>(`/api/lattice/models/${modelId}/entities`, params);
      return response.data;
    },
    onSuccess: data => {
      queryClient.setQueryData(LATTICE_KEYS.model(data.id), data);
    },
  });
}

// SET VALUE

export function useSetLatticeValue() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ modelId, ...params }: SetValueParams) => {
      const response = await api.put<ILatticeModel>(`/api/lattice/models/${modelId}/values`, params);
      return response.data;
    },
    onSuccess: data => {
      queryClient.setQueryData(LATTICE_KEYS.model(data.id), data);
    },
  });
}

// ADD RULE

export function useAddLatticeRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ modelId, ...params }: AddRuleParams) => {
      const response = await api.post<ILatticeModel>(`/api/lattice/models/${modelId}/rules`, params);
      return response.data;
    },
    onSuccess: data => {
      queryClient.setQueryData(LATTICE_KEYS.model(data.id), data);
    },
  });
}

// HYDRATE MODEL

export function useHydrateLatticeModel() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ modelId, scenarioId }: HydrateParams) => {
      const response = await api.post<HydrateResult>(`/api/lattice/models/${modelId}/hydrate`, { scenarioId });
      return { modelId, ...response.data };
    },
    onSuccess: data => {
      // Invalidate model to refresh lastComputedAt
      queryClient.invalidateQueries({ queryKey: LATTICE_KEYS.model(data.modelId) });
    },
  });
}

// COMBINED HOOK

/**
 * Combined hook providing all Lattice API operations
 */
export function useLatticeApi(modelId?: string) {
  const modelsQuery = useLatticeModels();
  const modelQuery = useLatticeModel(modelId);

  const createModel = useCreateLatticeModel();
  const updateModel = useUpdateLatticeModel();
  const deleteModel = useDeleteLatticeModel();
  const addEntity = useAddLatticeEntity();
  const setValue = useSetLatticeValue();
  const addRule = useAddLatticeRule();
  const hydrate = useHydrateLatticeModel();

  return {
    // Queries
    models: modelsQuery.data?.data ?? [],
    modelsTotal: modelsQuery.data?.meta.total ?? 0,
    modelsLoading: modelsQuery.isLoading,
    modelsError: modelsQuery.error,

    model: modelQuery.data ?? null,
    modelLoading: modelQuery.isLoading,
    modelError: modelQuery.error,

    // Mutations
    createModel: createModel.mutateAsync,
    createModelLoading: createModel.isPending,

    updateModel: updateModel.mutateAsync,
    updateModelLoading: updateModel.isPending,

    deleteModel: deleteModel.mutateAsync,
    deleteModelLoading: deleteModel.isPending,

    addEntity: addEntity.mutateAsync,
    addEntityLoading: addEntity.isPending,

    setValue: setValue.mutateAsync,
    setValueLoading: setValue.isPending,

    addRule: addRule.mutateAsync,
    addRuleLoading: addRule.isPending,

    hydrate: hydrate.mutateAsync,
    hydrateLoading: hydrate.isPending,
    hydrateResult: hydrate.data,

    // Refetch
    refetchModels: modelsQuery.refetch,
    refetchModel: modelQuery.refetch,
  };
}

export { LATTICE_KEYS };
