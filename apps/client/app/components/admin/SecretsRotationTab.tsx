import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Box,
  CircularProgress,
  Sheet,
  Table,
  Typography,
  Button,
  Chip,
  Tooltip,
  IconButton,
  Modal,
  ModalDialog,
  FormControl,
  FormLabel,
  Input,
  Stack,
} from '@mui/joy';
import SecurityIcon from '@mui/icons-material/Security';
import RefreshIcon from '@mui/icons-material/Refresh';
import EditIcon from '@mui/icons-material/Edit';
import SaveIcon from '@mui/icons-material/Save';
import { api } from '@client/app/contexts/ApiContext';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { useState } from 'react';
import { ISecretRotationDocument } from '@bike4mind/common';

dayjs.extend(relativeTime);

export default function SecretsRotationTab() {
  const queryClient = useQueryClient();
  const [openRenewModal, setOpenRenewModal] = useState(false);
  const [openEditModal, setOpenEditModal] = useState(false);
  const [currentSecret, setCurrentSecret] = useState<ISecretRotationDocument | null>(null);
  const [editFormData, setEditFormData] = useState({
    previousKey: '',
    rotationIntervalDays: 30,
    description: '',
  });

  const { data, isLoading, error, refetch } = useQuery<ISecretRotationDocument[]>({
    queryKey: ['secrets-rotation'],
    queryFn: async () => {
      const response = await api.get('/api/secret-rotations');
      return response.data;
    },
    refetchInterval: 300000, // Auto-refresh every 5 minutes
  });

  const editMutation = useMutation({
    mutationFn: (data: { id: string; previousKey?: string; rotationIntervalDays?: number; description?: string }) =>
      api.put(`/api/secret-rotations/${data.id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['secrets-rotation'] });
      setOpenEditModal(false);
    },
  });

  const renewMutation = useMutation({
    mutationFn: (data: { id: string }) => api.post('/api/secret-rotations/renewed', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['secrets-rotation'] });
      setOpenRenewModal(false);
    },
  });

  const handleRenew = (secret: ISecretRotationDocument) => {
    setCurrentSecret(secret);
    setOpenRenewModal(true);
  };

  const handleRefresh = () => {
    refetch();
  };

  const getStatusColor = (active: boolean, nextRotation: Date) => {
    if (!active) return 'danger';
    if (dayjs(nextRotation).isBefore(dayjs())) return 'warning';
    return 'success';
  };

  if (isLoading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="200px">
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return (
      <Box p={2}>
        <Typography color="danger">Error loading secrets rotation data</Typography>
        <Button onClick={handleRefresh} variant="soft" sx={{ mt: 2 }}>
          Retry
        </Button>
      </Box>
    );
  }

  return (
    <Sheet sx={{ p: 2, height: '100%', overflow: 'auto' }}>
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography level="h3" startDecorator={<SecurityIcon />}>
            Secrets Rotation
          </Typography>
          <ContextHelpButton helpId="admin/secrets-management" tooltipText="Secrets Management Help" />
        </Stack>
        <Box display="flex" gap={1}>
          <Tooltip title="Refresh data">
            <IconButton onClick={handleRefresh} variant="outlined">
              <RefreshIcon />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      <Modal open={openEditModal} onClose={() => setOpenEditModal(false)}>
        <ModalDialog>
          <Typography level="h4" mb={2}>
            Edit Secret Rotation: {currentSecret?.keyName}
          </Typography>
          <Stack spacing={2}>
            <FormControl>
              <FormLabel>Description</FormLabel>
              <Input
                name="description"
                value={editFormData.description}
                onChange={e => setEditFormData({ ...editFormData, description: e.target.value })}
              />
            </FormControl>
            <FormControl>
              <FormLabel>Previous Key</FormLabel>
              <Input
                name="previousKey"
                value={editFormData.previousKey}
                onChange={e => setEditFormData({ ...editFormData, previousKey: e.target.value })}
              />
            </FormControl>
            <FormControl>
              <FormLabel>Rotation Interval (days)</FormLabel>
              <Input
                name="rotationIntervalDays"
                value={editFormData.rotationIntervalDays}
                onChange={e => setEditFormData({ ...editFormData, rotationIntervalDays: Number(e.target.value) })}
                type="number"
                slotProps={{
                  input: {
                    min: 1,
                    max: 365,
                  },
                }}
              />
            </FormControl>
            <Button
              onClick={() => {
                if (currentSecret) {
                  editMutation.mutate({
                    id: currentSecret.id,
                    ...editFormData,
                  });
                }
              }}
              loading={editMutation.isPending}
            >
              Save Changes
            </Button>
          </Stack>
        </ModalDialog>
      </Modal>

      <Modal open={openRenewModal} onClose={() => setOpenRenewModal(false)}>
        <ModalDialog>
          <Typography level="h4" mb={2} textAlign="center">
            Set Secret as Renewed
          </Typography>
          <Typography level="h3" textAlign="center">
            {currentSecret?.keyName}
          </Typography>
          <Stack spacing={2}>
            <Button
              onClick={() => {
                if (currentSecret) {
                  renewMutation.mutate({
                    id: currentSecret.id,
                  });
                }
              }}
              loading={renewMutation.isPending}
              startDecorator={<SaveIcon />}
            >
              Confirm
            </Button>
          </Stack>
        </ModalDialog>
      </Modal>

      <Box sx={{ overflowX: { xs: 'auto', sm: 'visible' } }}>
        <Table stickyHeader hoverRow sx={{ minWidth: { xs: '900px', sm: 'auto' } }}>
          <thead>
            <tr>
              <th style={{ width: '20%', wordBreak: 'break-all' }}>Secret Key Name</th>
              <th>Description</th>
              <th>Last Rotation</th>
              <th>Next Rotation</th>
              <th>Interval (days)</th>
              <th style={{ width: '8%' }}>Status</th>
              <th>Last Renewed By</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {data?.map(secret => (
              <tr key={secret.id}>
                <td style={{ wordBreak: 'break-all' }}>
                  <Typography fontWeight="lg">{secret.keyName}</Typography>
                </td>
                <td>{secret.description}</td>
                <td>
                  <Box>
                    {dayjs(secret.rotatedAt).format('MMM D, YYYY')}
                    <Typography level="body-xs" color="neutral">
                      {dayjs(secret.rotatedAt).fromNow()}
                    </Typography>
                  </Box>
                </td>
                <td>
                  <Box>
                    {dayjs(secret.nextRotation).format('MMM D, YYYY')}
                    <Typography
                      level="body-xs"
                      color={dayjs(secret.nextRotation).isBefore(dayjs()) ? 'danger' : 'neutral'}
                    >
                      {dayjs(secret.nextRotation).fromNow()}
                    </Typography>
                  </Box>
                </td>
                <td>{secret.rotationIntervalDays}</td>
                <td>
                  <Chip variant="soft" color={getStatusColor(secret.isActive, secret.nextRotation)}>
                    {secret.isActive ? 'active' : 'inactive'}
                  </Chip>
                </td>
                <td>{secret.lastRotatedByName}</td>
                <td>
                  <Box display="flex" gap={1}>
                    <Button
                      size="sm"
                      variant="outlined"
                      onClick={() => handleRenew(secret)}
                      startDecorator={<RefreshIcon />}
                    >
                      Renew
                    </Button>
                    <Button
                      size="sm"
                      variant="plain"
                      onClick={() => {
                        setCurrentSecret(secret);
                        setEditFormData({
                          previousKey: secret.previousKey || '',
                          rotationIntervalDays: secret.rotationIntervalDays,
                          description: secret.description || '',
                        });
                        setOpenEditModal(true);
                      }}
                      startDecorator={<EditIcon />}
                    >
                      Edit
                    </Button>
                  </Box>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Box>
    </Sheet>
  );
}
