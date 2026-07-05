import { IMementoDocument } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { CreateMementoDTO, UpdateMementoDTO } from './mementoDtos';

export async function createBatchMementosOnServer(mementos: CreateMementoDTO[]): Promise<IMementoDocument[]> {
  const response = await api.post('/api/mementos/create-batch', mementos);
  return response.data;
}

export async function deleteMementoFromServer(id: string): Promise<void> {
  await api.delete(`/api/mementos/${id}/delete`);
}

export async function deleteAllMementosFromServer(): Promise<void> {
  await api.post('/api/mementos/delete-all');
}

export const createMementoOnServer = async (memento: CreateMementoDTO) => {
  const response = await api.post('/api/mementos/create', memento);
  return response.data;
};

export const updateMementoOnServer = async (id: string, updates: UpdateMementoDTO) => {
  const response = await api.patch(`/api/mementos/${id}/update`, updates);
  return response.data;
};

export const triggerMementoGrooming = async () => {
  const response = await api.post('/api/mementos/groom');
  return response.data;
};
