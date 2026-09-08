import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';
import { useAdminGenerateApiKey, AdminCreateUserApiKeyRequest } from '@client/app/hooks/data/userApiKeys';
import { useGetDataLakes } from '@client/app/hooks/data/dataLakes';
import { useCopyToClipboard } from '@client/app/hooks/useCopyToClipboard';
import { GENERIC_MODAL_API_KEY_SCOPES } from '@client/app/constants/apiKeyScopes';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import WarningIcon from '@mui/icons-material/Warning';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControl,
  FormLabel,
  Input,
  Modal,
  ModalDialog,
  Select,
  Skeleton,
  Option,
  Stack,
  Typography,
} from '@mui/joy';
import { useState } from 'react';
import { toast } from 'sonner';
import dayjs from 'dayjs';

interface AdminGenerateApiKeyModalProps {
  open: boolean;
  onClose: () => void;
  user: AdminUserListItem;
}

// Embed keys are minted through the dedicated embed flow (epic #41 Phase E), not
// this generic modal, so embed:chat is excluded from the offered scopes.
const scopeOptions = GENERIC_MODAL_API_KEY_SCOPES;
const scopeValues = scopeOptions.map(s => s.value);

export default function AdminGenerateApiKeyModal({ open, onClose, user }: AdminGenerateApiKeyModalProps) {
  const [formData, setFormData] = useState<AdminCreateUserApiKeyRequest>({
    name: '',
    scopes: [],
    rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
  });
  const [expirationDays, setExpirationDays] = useState<string>('never');
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const { handleCopyToClipboard, copied } = useCopyToClipboard({ showToast: true });
  const { data: lakes, isLoading: lakesLoading, isError: lakesError, refetch: refetchLakes } = useGetDataLakes(open);
  const preauthorizedLakeIds = formData.preauthorizedLakeIds ?? [];

  const generateMutation = useAdminGenerateApiKey({
    onSuccess: result => {
      setGeneratedKey(result.key);
      toast.success(`API key created for ${user.username}`);
    },
  });

  const resetForm = () => {
    setFormData({
      name: '',
      scopes: [],
      rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
    });
    setExpirationDays('never');
    setGeneratedKey(null);
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const handleSubmit = () => {
    const submitData: AdminCreateUserApiKeyRequest = {
      ...formData,
      expiresAt: expirationDays === 'never' ? undefined : dayjs().add(parseInt(expirationDays), 'days').toDate(),
      preauthorizedLakeIds: preauthorizedLakeIds.length > 0 ? preauthorizedLakeIds : undefined,
    };
    generateMutation.mutate({ userId: user.id, data: submitData });
  };

  const toggleLake = (lakeId: string) => {
    setFormData({
      ...formData,
      preauthorizedLakeIds: preauthorizedLakeIds.includes(lakeId)
        ? preauthorizedLakeIds.filter(id => id !== lakeId)
        : [...preauthorizedLakeIds, lakeId],
    });
  };

  const allScopesSelected = scopeOptions.every(s => formData.scopes.includes(s.value));

  const toggleAllScopes = () => {
    setFormData({ ...formData, scopes: allScopesSelected ? [] : [...scopeValues] });
  };

  if (generatedKey) {
    return (
      <Modal open={open} onClose={handleClose}>
        <ModalDialog size="lg" sx={{ width: '600px', maxHeight: '90vh', overflow: 'auto' }}>
          <Typography level="h4" mb={2}>
            API Key Generated for {user.username}
          </Typography>

          <Alert color="warning" startDecorator={<WarningIcon />} sx={{ mb: 2 }}>
            Copy this key now. It will not be shown again.
          </Alert>

          <Box
            sx={{
              p: 2,
              bgcolor: 'background.level1',
              borderRadius: 'sm',
              fontFamily: 'monospace',
              fontSize: 'sm',
              wordBreak: 'break-all',
              border: '1px solid',
              borderColor: 'divider',
            }}
          >
            {generatedKey}
          </Box>

          <Stack direction="row" spacing={2} justifyContent="flex-end" mt={2}>
            <Button
              startDecorator={<ContentCopyIcon />}
              variant="solid"
              color={copied ? 'success' : 'primary'}
              onClick={() => handleCopyToClipboard(generatedKey)}
            >
              {copied ? 'Copied!' : 'Copy Key'}
            </Button>
            <Button variant="outlined" onClick={handleClose}>
              Done
            </Button>
          </Stack>
        </ModalDialog>
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={handleClose}>
      <ModalDialog size="lg" sx={{ width: '600px', maxHeight: '90vh', overflow: 'auto' }}>
        <Typography level="h4" mb={2}>
          Generate API Key for {user.username}
        </Typography>

        <Stack spacing={3}>
          <FormControl required>
            <FormLabel>Key Name</FormLabel>
            <Input
              placeholder="e.g., Data Lake Upload, CI/CD Pipeline"
              value={formData.name}
              onChange={e => setFormData({ ...formData, name: e.target.value })}
            />
          </FormControl>

          <FormControl required>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5 }}>
              <FormLabel sx={{ mb: 0 }}>
                Scopes ({formData.scopes.length}/{scopeOptions.length} selected)
              </FormLabel>
              <Button size="sm" variant="plain" onClick={toggleAllScopes}>
                {allScopesSelected ? 'Clear All' : 'Select All'}
              </Button>
            </Box>
            <Box
              sx={{
                maxHeight: '360px',
                overflow: 'auto',
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: 'sm',
                p: 1,
              }}
            >
              {scopeOptions.map(scope => (
                <Box key={scope.value} sx={{ mb: 1 }}>
                  <Checkbox
                    label={scope.label}
                    checked={formData.scopes.includes(scope.value)}
                    onChange={e => {
                      if (e.target.checked) {
                        setFormData({ ...formData, scopes: [...formData.scopes, scope.value] });
                      } else {
                        setFormData({ ...formData, scopes: formData.scopes.filter(s => s !== scope.value) });
                      }
                    }}
                  />
                  <Typography level="body-xs" color="neutral" sx={{ ml: 4 }}>
                    {scope.description}
                  </Typography>
                </Box>
              ))}
            </Box>
          </FormControl>

          <FormControl>
            <FormLabel sx={{ mb: 0.5 }} data-testid="admin-generate-key-lakes-count">
              Pre-authorized lakes ({preauthorizedLakeIds.length} selected)
            </FormLabel>
            <Typography level="body-xs" color="neutral" sx={{ mb: 1 }}>
              Lets this key admit any of the checked lakes into a session it manages but is not a member of, on top of
              the caller&apos;s ordinary access. Leave empty for a key with no such widening.
            </Typography>
            <Box
              sx={{
                maxHeight: '200px',
                overflow: 'auto',
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: 'sm',
                p: 1,
              }}
              data-testid="admin-generate-key-lakes-box"
            >
              {lakesLoading ? (
                <Stack gap={1} data-testid="admin-generate-key-lakes-loading">
                  {[0, 1].map(i => (
                    <Skeleton key={i} variant="text" level="body-sm" />
                  ))}
                </Stack>
              ) : lakesError ? (
                <Stack gap={1} data-testid="admin-generate-key-lakes-error">
                  <Typography level="body-sm" sx={{ color: 'danger.400' }}>
                    Could not load lakes.
                  </Typography>
                  <Button size="sm" variant="outlined" color="neutral" onClick={() => refetchLakes()}>
                    Retry
                  </Button>
                </Stack>
              ) : (lakes?.length ?? 0) === 0 ? (
                <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                  No lakes yet
                </Typography>
              ) : (
                lakes!.map(lake => (
                  <Checkbox
                    key={lake.id}
                    size="sm"
                    label={lake.name}
                    checked={preauthorizedLakeIds.includes(lake.id)}
                    onChange={() => toggleLake(lake.id)}
                    data-testid={`admin-generate-key-lake-checkbox-${lake.id}`}
                  />
                ))
              )}
            </Box>
          </FormControl>

          <FormControl>
            <FormLabel>Expiration</FormLabel>
            <Select value={expirationDays} onChange={(_, value) => setExpirationDays(value as string)}>
              <Option value="30">30 days</Option>
              <Option value="90">90 days</Option>
              <Option value="365">1 year</Option>
              <Option value="never">Never expires</Option>
            </Select>
          </FormControl>

          <Box>
            <Typography level="title-sm" mb={1}>
              Rate Limits
            </Typography>
            <Stack direction="row" spacing={2}>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Requests per minute</FormLabel>
                <Input
                  type="number"
                  value={formData.rateLimit?.requestsPerMinute}
                  onChange={e => {
                    const val = parseInt(e.target.value);
                    if (!isNaN(val) && val >= 0) {
                      setFormData({
                        ...formData,
                        rateLimit: { ...formData.rateLimit!, requestsPerMinute: val },
                      });
                    }
                  }}
                />
              </FormControl>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Requests per day</FormLabel>
                <Input
                  type="number"
                  value={formData.rateLimit?.requestsPerDay}
                  onChange={e => {
                    const val = parseInt(e.target.value);
                    if (!isNaN(val) && val >= 0) {
                      setFormData({
                        ...formData,
                        rateLimit: { ...formData.rateLimit!, requestsPerDay: val },
                      });
                    }
                  }}
                />
              </FormControl>
            </Stack>
          </Box>

          <Stack direction="row" spacing={2} justifyContent="flex-end">
            <Button variant="outlined" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              loading={generateMutation.isPending}
              disabled={!formData.name || formData.scopes.length === 0}
            >
              Generate API Key
            </Button>
          </Stack>
        </Stack>
      </ModalDialog>
    </Modal>
  );
}
