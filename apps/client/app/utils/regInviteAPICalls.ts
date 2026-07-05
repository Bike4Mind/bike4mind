import { api } from '@client/app/contexts/ApiContext';
import { IRegInviteDocument } from '@bike4mind/common';

export const getRegInvitesFromServer = async () => {
  const response = await api.get<IRegInviteDocument[]>(`/api/reg-invites`);
  return response.data;
};

export const updateRegInvites = async (invite: Partial<IRegInviteDocument & { ids: string[] }>) => {
  const response = await api.post(`/api/reg-invites/update`, invite);
  return response.data;
};

export const createRegInvites = async (data: {
  multiple: number;
  unlimitedUse?: boolean;
  tags?: string[];
  startingCredits?: number;
  startingStorage?: number;
}) => {
  const response = await api.post(`/api/reg-invites/create`, data);
  return response.data;
};

export const deleteRegInvites = async (ids: string[]) => {
  const response = await api.post(`/api/reg-invites/delete`, { ids });
  return response.data;
};

export type IUserInvitation = {
  userName?: string;
  friendEmail: string[];
  emailTitle: string;
  emailBody: string;
  tags?: string[];
};

export type IReferralResult = {
  message: string;
  sent: string[];
  skipped: string[];
  failed: string[];
};

export const submitReferral = async (data: IUserInvitation): Promise<IReferralResult> => {
  const response = await api.post<IReferralResult>(`/api/reg-invites/refer`, data);
  return response.data;
};

export const submitUserInvitation = async (data: IUserInvitation) => {
  const response = await api.post(`/api/reg-invites/user-invite`, data);
  return response.data;
};
