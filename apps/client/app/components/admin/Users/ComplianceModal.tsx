import {
  Alert,
  Button,
  Chip,
  LinearProgress,
  Modal,
  ModalClose,
  ModalDialog,
  Sheet,
  Stack,
  Table,
  Typography,
} from '@mui/joy';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { getErrorMessage } from '@client/app/utils/error';
import { useGetUserCompliance } from '@client/app/hooks/data/userCompliance';

export const useComplianceModal = create<{
  userId: string | null;
  setUserId: (userId: string | null) => void;
}>()(set => ({
  userId: null,
  setUserId: userId => set({ userId }),
}));

const fmt = (d: string | Date | null | undefined) => (d ? new Date(d).toLocaleString() : '—');

const ComplianceModal = () => {
  const [userId, setUserId] = useComplianceModal(useShallow(s => [s.userId, s.setUserId]));
  const { data, isLoading, isError, error, refetch } = useGetUserCompliance(userId);

  return (
    <Modal open={!!userId} onClose={() => setUserId(null)}>
      <ModalDialog
        data-testid="compliance-modal"
        sx={{ maxHeight: '90vh', overflowY: 'auto', minWidth: { xs: '90vw', md: 720 } }}
      >
        <ModalClose data-testid="modal-close-btn" />
        <Typography level="h4">User Compliance</Typography>

        {isError ? (
          <Alert color="danger" variant="soft" data-testid="compliance-error">
            <Stack spacing={1}>
              <Typography level="body-sm">Failed to load compliance data: {getErrorMessage(error)}</Typography>
              <Button size="sm" variant="outlined" color="danger" onClick={() => refetch()}>
                Retry
              </Button>
            </Stack>
          </Alert>
        ) : isLoading || !data ? (
          <LinearProgress />
        ) : (
          <Stack spacing={3} mt={1}>
            {/* 1. Legal acceptance (AUP/ToS gate) */}
            <Stack spacing={1} data-testid="compliance-legal-section">
              <Typography level="title-md">Legal acceptance</Typography>
              {data.aupAcceptedVersion ? (
                <>
                  <Typography level="body-sm">
                    AUP accepted: version <b>{data.aupAcceptedVersion}</b> on {fmt(data.aupAcceptedAt)} · Status:{' '}
                    <Chip size="sm" color={data.isCurrent ? 'success' : 'warning'}>
                      {data.isCurrent ? 'Current' : 'Not current'}
                    </Chip>
                  </Typography>
                  <Typography level="body-xs">
                    In-force version: {data.currentPolicyVersion} · Adult attested:{' '}
                    {data.ageAttestedAdult === null ? '—' : data.ageAttestedAdult ? 'Yes' : 'No'}
                  </Typography>
                </>
              ) : (
                <Typography level="body-sm" data-testid="compliance-never-accepted" color="danger">
                  Never accepted the AUP (in-force version: {data.currentPolicyVersion}).
                </Typography>
              )}
            </Stack>

            {/* 2. Moderation incidents */}
            <Stack spacing={1}>
              <Typography level="title-md">Moderation incidents ({data.moderationIncidents.length})</Typography>
              <Sheet variant="outlined" sx={{ borderRadius: 'sm' }}>
                <Table size="sm" stickyHeader data-testid="compliance-incidents-table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Labels</th>
                      <th>Provider</th>
                      <th>Model</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.moderationIncidents.length === 0 ? (
                      <tr>
                        <td colSpan={4}>No incidents.</td>
                      </tr>
                    ) : (
                      data.moderationIncidents.map((m, i) => (
                        <tr key={i}>
                          <td>{fmt(m.createdAt)}</td>
                          <td>{m.labels.map(l => `${l.name} (${Math.round(l.confidence * 100)}%)`).join(', ')}</td>
                          <td>{m.provider}</td>
                          <td>{m.model}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </Table>
              </Sheet>
            </Stack>

            {/* 3. Flags */}
            <Stack spacing={1} data-testid="compliance-flags">
              <Typography level="title-md">Moderation / ban state</Typography>
              <Stack direction="row" spacing={1}>
                <Chip color={data.flags.isBanned ? 'danger' : 'neutral'}>Banned: {String(data.flags.isBanned)}</Chip>
                <Chip color={data.flags.isModerated ? 'warning' : 'neutral'}>
                  Moderated: {String(data.flags.isModerated)}
                </Chip>
                <Chip color={data.flags.disputePending ? 'warning' : 'neutral'}>
                  Dispute pending: {String(data.flags.disputePending)}
                </Chip>
              </Stack>
            </Stack>

            {/* 4. Auth trail */}
            <Stack spacing={1}>
              <Typography level="title-md">Recent auth events ({data.recentAuthEvents.length})</Typography>
              <Sheet variant="outlined" sx={{ borderRadius: 'sm' }}>
                <Table size="sm" stickyHeader data-testid="compliance-auth-events">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Event</th>
                      <th>Actor</th>
                      <th>IP</th>
                      <th>User agent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentAuthEvents.length === 0 ? (
                      <tr>
                        <td colSpan={5}>No recent events.</td>
                      </tr>
                    ) : (
                      data.recentAuthEvents.map((e, i) => (
                        <tr key={i}>
                          <td>{fmt(e.createdAt)}</td>
                          <td>{e.event}</td>
                          {/* actorUserId is only set for admin-driven events (e.g. session_revoked) - a
                              self-initiated logout has no distinct actor to show. */}
                          <td>{e.actorUserId ?? '-'}</td>
                          <td>{e.actorIp}</td>
                          <td>{e.userAgent}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </Table>
              </Sheet>
            </Stack>
          </Stack>
        )}
      </ModalDialog>
    </Modal>
  );
};

export default ComplianceModal;
