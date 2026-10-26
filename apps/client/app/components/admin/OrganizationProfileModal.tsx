import { IOrganizationDocument, WithId } from '@bike4mind/common';
import { useGetOrganization } from '@client/app/hooks/data/organizations';
import { LinearProgress, Modal, ModalClose, ModalDialog, Typography } from '@mui/joy';
import { isAxiosError } from 'axios';
import React, { useEffect, useState } from 'react';
import { toast } from 'sonner';
import OrganizationProfileUpdated from './OrganizationProfileUpdated';
import { useOpenOrganizationId } from './useOrganizationsTabParams';

/**
 * The profile of the organization named by `?orgId=`, fetched by id so a refresh or a shared link
 * reopens it. A settled 404 (unknown id, or one this admin cannot see) closes the modal rather than
 * leaving a dead pane; a cached error that is refetching, or a 5xx, must not close it.
 *
 * The profile gets the org as it was when opened, not the live query: OrganizationProfileUpdated
 * resets its unsaved edits whenever `org` changes, and every org mutation (a group-type save inside
 * this same modal included) invalidates `['organizations']` and would hand it a new object.
 */
const OrganizationProfileModal: React.FC<{ onClosed: () => void }> = ({ onClosed }) => {
  const { orgId, setOrgId } = useOpenOrganizationId();
  const organization = useGetOrganization(orgId);

  const [openedOrganization, setOpenedOrganization] = useState<WithId<IOrganizationDocument> | null>(null);
  if (!orgId && openedOrganization) setOpenedOrganization(null);
  if (orgId && organization.data?.id === orgId && openedOrganization?.id !== orgId) {
    setOpenedOrganization(organization.data);
  }
  const shownOrganization = openedOrganization?.id === orgId ? openedOrganization : null;

  const isUnknownOrganization =
    !organization.isFetching && isAxiosError(organization.error) && organization.error.response?.status === 404;
  useEffect(() => {
    if (!orgId || !isUnknownOrganization) return;
    // A fixed id dedupes StrictMode's double effect run.
    toast.error('That organization could not be found.', { id: 'admin-organization-not-found' });
    setOrgId(null);
  }, [orgId, isUnknownOrganization, setOrgId]);
  const failedToLoad = !shownOrganization && !organization.isFetching && !!organization.error && !isUnknownOrganization;

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
        {shownOrganization ? (
          <OrganizationProfileUpdated org={shownOrganization} onClose={close} activeDays={30} />
        ) : failedToLoad ? (
          <Typography color="danger" data-testid="admin-organization-profile-error">
            This organization could not be loaded. Close this window and try again.
          </Typography>
        ) : (
          <LinearProgress data-testid="admin-organization-profile-loading" />
        )}
      </ModalDialog>
    </Modal>
  );
};

export default OrganizationProfileModal;
