import { api } from '@client/app/contexts/ApiContext';

export const isElabsReady = async (): Promise<boolean> => {
  let results: boolean = false;
  try {
    const response = await api.get(`/api/elabs/ready`);
    results = response.data.ready;
  } catch (e) {
    console.log('Failed to check if elabs ready', e);
  }

  return results;
};
