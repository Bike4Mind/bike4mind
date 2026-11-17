import { api } from '@client/app/contexts/ApiContext';
import type { AccountSegment } from '@bike4mind/common';

// PUT /api/admin/organizations/:id/segment - platform-admin only.
export const setOrganizationAccountSegment = async (
  organizationId: string,
  accountSegment: AccountSegment,
  reason: string
): Promise<{ accountSegment: AccountSegment }> => {
  const response = await api.put<{ accountSegment: AccountSegment }>(
    `/api/admin/organizations/${organizationId}/segment`,
    { accountSegment, reason }
  );
  return response.data;
};
