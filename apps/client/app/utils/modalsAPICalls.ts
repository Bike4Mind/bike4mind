import { toast } from 'sonner';
import { IModalDocument } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';

export const createModal = async (modal: Partial<IModalDocument>): Promise<IModalDocument> => {
  try {
    const response = await api.post(`/api/modals/create`, modal);

    if (response.status === 201) {
      toast.success('Modal created');
      return response.data;
    } else {
      toast.error('Failed to create modal');
      throw new Error('Failed to create modal');
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    toast.error(`Error creating modal: ${errorMessage}`);
    throw error; // Throw the original error for better debugging
  }
};

export const updateModal = async (modalId: string, modal: Partial<IModalDocument>): Promise<IModalDocument> => {
  try {
    const response = await api.put(`/api/modals/${modalId}/update`, modal);

    if (response.status === 200) {
      toast.success('Modal updated');
      return response.data;
    } else {
      toast.error('Failed to update modal');
      throw new Error('Failed to update modal');
    }
  } catch (error) {
    toast.error(`Error updating modal`);
    throw new Error(`Error updating modal`);
  }
};

export const deleteModalFromServer = async (modalId: string): Promise<void> => {
  try {
    console.log('deleting modal with id: ', modalId);
    const response = await api.delete(`/api/modals/${modalId}/delete`);

    if (response.status === 200) {
      toast.success('Modal deleted');
    } else {
      toast.error(`Failed to delete modal`);
      throw new Error(`Failed to delete modal`);
    }
  } catch (error) {
    toast.error(`Error deleting modal`);
    throw new Error(`Error deleting modal`);
  }
};
