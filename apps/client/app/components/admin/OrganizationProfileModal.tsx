import { IOrganizationDocument, WithId } from '@bike4mind/common';
import { useGetOrganization } from '@client/app/hooks/data/organizations';
import { Button, LinearProgress, Modal, ModalClose, ModalDialog, Stack, Typography } from '@mui/joy';
import { isAxiosError } from 'axios';
import React, { useEffect, useState } from 'react';
import { toast } from 'sonner';
import OrganizationProfileUpdated from './OrganizationProfileUpdated';
import { useOpenOrganizationId } from './useOrganizationsTabParams';

/**
 * The profile of the organization named by `?orgId=`. Only a settled 404 closes it. It shows the org
 * as opened, not the live query: OrganizationProfileUpdated resets unsaved edits whenever `org`
 * changes, and every org mutation invalidates `['organizations']`.
 */
const OrganizationProfileModal: React.FC<{ onClosed: () => void }> = ({ onClosed }) => {
  const { orgId, setOrgId } = useOpenOrganizationId();
  const organization = useGetOrganization(orgId);

  const [openedOrganization, setOpenedOrganization] = useState<WithId<IOrganizationDocument> | null>(null);
  if (!orgId && openedOrganization) setOpenedOrganization(null);
  // Wait for the fetch to settle: a closed org's cached query is invalidated without being refetched,
  // so reopening it serves stale data first, and saving the profile would write that back.
  if (
    orgId &&
    !organization.isFetching &&
    !organization.error &&
    organization.data?.id === orgId &&
    openedOrganization?.id !== orgId
  ) {
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
          <Stack spacing={1.5} alignItems="flex-start">
            <Typography role="alert" color="danger" data-testid="admin-organization-profile-error">
              This organization could not be loaded.
            </Typography>
            <Button
              variant="outlined"
              onClick={() => organization.refetch()}
              data-testid="admin-organization-profile-retry-btn"
            >
              Retry
            </Button>
          </Stack>
        ) : (
          <LinearProgress data-testid="admin-organization-profile-loading" />
        )}
      </ModalDialog>
    </Modal>
  );
};

export default OrganizationProfileModal;
