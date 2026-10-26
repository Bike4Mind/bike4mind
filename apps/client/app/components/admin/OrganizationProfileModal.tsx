import { useGetOrganization } from '@client/app/hooks/data/organizations';
import { LinearProgress, Modal, ModalClose, ModalDialog } from '@mui/joy';
import { isAxiosError } from 'axios';
import React, { useEffect } from 'react';
import { toast } from 'sonner';
import OrganizationProfileUpdated from './OrganizationProfileUpdated';
import { useOpenOrganizationId } from './useOrganizationsTabParams';

/**
 * The profile of the organization named by `?orgId=`, fetched by id so a refresh or a shared link
 * reopens it. A settled 404 (unknown id, or one this admin cannot see) closes the modal rather than
 * leaving a dead pane; a cached error that is refetching, or a 5xx, must not close it.
 */
const OrganizationProfileModal: React.FC<{ onClosed: () => void }> = ({ onClosed }) => {
  const { orgId, setOrgId } = useOpenOrganizationId();
  const organization = useGetOrganization(orgId);

  const isUnknownOrganization =
    !organization.isFetching && isAxiosError(organization.error) && organization.error.response?.status === 404;
  useEffect(() => {
    if (!orgId || !isUnknownOrganization) return;
    // A fixed id dedupes StrictMode's double effect run.
    toast.error('That organization could not be found.', { id: 'admin-organization-not-found' });
    setOrgId(null);
  }, [orgId, isUnknownOrganization, setOrgId]);

  const close = () => {
    setOrgId(null);
    onClosed();
  };

  return (
    <Modal open={!!orgId} onClose={close}>
      <ModalDialog
        size="lg"
        sx={{ maxHeight: '80vh', overflow: 'auto' }}
        data-testid="admin-organization-profile-modal"
      >
        <ModalClose />
        {organization.data ? (
          <OrganizationProfileUpdated org={organization.data} onClose={close} activeDays={30} />
        ) : (
          <LinearProgress data-testid="admin-organization-profile-loading" />
        )}
      </ModalDialog>
    </Modal>
  );
};

export default OrganizationProfileModal;
