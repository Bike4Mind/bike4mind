import { useState, useEffect } from 'react';
import {
  Box,
  Button,
  Checkbox,
  Chip,
  DialogContent,
  Divider,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  ListDivider,
  MenuItem,
  Option,
  Select,
  Stack,
  Switch,
  Typography,
  Textarea,
  IconButton,
} from '@mui/joy';
import Add from '@mui/icons-material/Add';
import Visibility from '@mui/icons-material/Visibility';
import VisibilityOff from '@mui/icons-material/VisibilityOff';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import type { IdentityProviderSecretPresence } from '@bike4mind/common';
import {
  ADMIN_REASON_PRESETS,
  ActionDialog,
  AdminDialog,
  AdminPageHeader,
  DataTable,
  EmptyState,
  StatusChip,
  type DataColumn,
} from './shared';
import { ADMIN_REGION_GAP } from './shared/adminStyles';
import { RowActionsMenu } from './shared/RowActionsMenu';

interface IdentityProvider {
  id: string;
  name: string;
  emailDomain: string;
  type: 'saml' | 'okta';
  isActive: boolean;
  samlConfig?: {
    entryPoint: string;
    issuer: string;
    cert: string;
    callbackUrl?: string;
    identifierFormat?: string;
    attributeMappings?: {
      email?: string;
      firstName?: string;
      lastName?: string;
      name?: string;
    };
  };
  oktaConfig?: {
    audience: string;
    clientId: string;
    clientSecret: string;
    authServerId?: string;
    useOrgAuthServer?: boolean;
  };
  /**
   * Which credentials are stored. The list API sends these instead of the secrets
   * themselves, so the form can tell a configured IdP from one saved with a blank one.
   */
  hasSecrets?: IdentityProviderSecretPresence;
  createdAt: string;
  updatedAt: string;
}

function ProviderRowMenu({
  idp,
  onSpMetadata,
  onEdit,
  onDelete,
}: {
  idp: IdentityProvider;
  onSpMetadata: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <RowActionsMenu testId={`identity-provider-actions-${idp.id}`} ariaLabel={`Actions for ${idp.name}`}>
      {idp.type === 'saml' && (
        <MenuItem onClick={onSpMetadata} data-testid={`identity-provider-sp-metadata-${idp.id}`}>
          View SP metadata
        </MenuItem>
      )}
      <MenuItem onClick={onEdit} data-testid={`identity-provider-edit-${idp.id}`}>
        Edit provider
      </MenuItem>
      <ListDivider />
      <MenuItem color="danger" onClick={onDelete} data-testid={`identity-provider-delete-${idp.id}`}>
        Delete provider
      </MenuItem>
    </RowActionsMenu>
  );
}

const CellText = ({ text, testId }: { text: string; testId?: string }) => (
  <Typography level="body-sm" noWrap title={text} sx={{ maxWidth: '100%' }} data-testid={testId}>
    {text}
  </Typography>
);

const IdentityProvidersTab: React.FC = () => {
  const [idps, setIdps] = useState<IdentityProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingIdp, setEditingIdp] = useState<IdentityProvider | null>(null);
  const [spMetadataOpen, setSpMetadataOpen] = useState(false);
  const [selectedIdp, setSelectedIdp] = useState<IdentityProvider | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<IdentityProvider | null>(null);
  const [showClientSecret, setShowClientSecret] = useState(false);

  // Form state
  const [formData, setFormData] = useState<
    Partial<IdentityProvider> & { name: string; emailDomain: string; type: 'saml' | 'okta'; isActive: boolean }
  >({
    name: '',
    emailDomain: '',
    type: 'saml' as 'saml' | 'okta',
    isActive: true,
    samlConfig: {
      entryPoint: '',
      issuer: '',
      cert: '',
      callbackUrl: '',
      identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      attributeMappings: {
        email: 'email',
        firstName: 'firstName',
        lastName: 'lastName',
        name: 'name',
      },
    },
    oktaConfig: {
      audience: '',
      clientId: '',
      clientSecret: '',
      authServerId: '',
      useOrgAuthServer: false,
    },
  });

  const fetchIdps = async () => {
    try {
      const response = await api.get('/api/admin/identity-providers');
      setIdps(response.data);
      setLoadError(false);
    } catch (error) {
      console.error('Error fetching IDPs:', error);
      toast.error('Failed to load identity providers');
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchIdps();
  }, []);

  const handleCreate = () => {
    setEditingIdp(null);
    setFormData({
      name: '',
      emailDomain: '',
      type: 'saml',
      isActive: true,
      samlConfig: {
        entryPoint: '',
        issuer: '',
        cert: '',
        callbackUrl: '',
        identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        attributeMappings: {
          email: 'email',
          firstName: 'firstName',
          lastName: 'lastName',
          name: 'name',
        },
      },
      oktaConfig: {
        audience: '',
        clientId: '',
        clientSecret: '',
        authServerId: '',
        useOrgAuthServer: false,
      },
    });
    setModalOpen(true);
  };

  const handleEdit = (idp: IdentityProvider) => {
    setEditingIdp(idp);
    setFormData({
      name: idp.name,
      emailDomain: idp.emailDomain,
      type: idp.type,
      isActive: idp.isActive,
      samlConfig: idp.samlConfig || {
        entryPoint: '',
        issuer: '',
        cert: '',
        callbackUrl: '',
        identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        attributeMappings: {
          email: 'email',
          firstName: 'firstName',
          lastName: 'lastName',
          name: 'name',
        },
      },
      oktaConfig: idp.oktaConfig || {
        audience: '',
        clientId: '',
        clientSecret: '',
        authServerId: '',
        useOrgAuthServer: false,
      },
    });
    setModalOpen(true);
  };

  const handleSubmit = async () => {
    try {
      const url = editingIdp ? `/api/admin/identity-providers/${editingIdp.id}` : '/api/admin/identity-providers';

      if (editingIdp) {
        await api.put(url, formData);
        toast.success('Identity provider updated');
      } else {
        await api.post(url, formData);
        toast.success('Identity provider created');
      }

      setModalOpen(false);
      fetchIdps();
    } catch (error: any) {
      console.error('Error saving IDP:', error);
      toast.error(error.response?.data?.error || 'Failed to save identity provider');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.delete(`/api/admin/identity-providers/${id}`);
      toast.success('Identity provider deleted');
      setDeleteTarget(null);
      fetchIdps();
    } catch (error: any) {
      console.error('Error deleting IDP:', error);
      toast.error(error.response?.data?.error || 'Failed to delete identity provider');
    }
  };

  const retryLoad = () => {
    setLoadError(false);
    setLoading(true);
    fetchIdps();
  };

  const columns: DataColumn<IdentityProvider>[] = [
    {
      id: 'name',
      label: 'Name',
      render: idp => <CellText text={idp.name} testId={`identity-provider-name-${idp.id}`} />,
    },
    { id: 'emailDomain', label: 'Email domain', render: idp => <CellText text={idp.emailDomain} /> },
    {
      id: 'type',
      label: 'Type',
      width: '6rem',
      render: idp => (
        <Chip size="sm" variant="soft" color="neutral">
          {idp.type.toUpperCase()}
        </Chip>
      ),
    },
    {
      id: 'status',
      label: 'Status',
      width: '7rem',
      render: idp => (
        <StatusChip
          tone={idp.isActive ? 'good' : 'neutral'}
          label={idp.isActive ? 'Active' : 'Inactive'}
          data-testid={`identity-provider-status-${idp.id}`}
        />
      ),
    },
    {
      id: 'createdAt',
      label: 'Created',
      width: '7.5rem',
      render: idp => <CellText text={new Date(idp.createdAt).toLocaleDateString()} />,
    },
  ];

  return (
    <Stack sx={{ gap: ADMIN_REGION_GAP, minWidth: 0 }} data-testid="admin-identity-providers-tab">
      <AdminPageHeader
        title="Identity providers"
        count={loading || loadError ? undefined : idps.length}
        description="SAML and Okta single sign-on, routed by the user's email domain."
        actions={
          <>
            <ContextHelpButton helpId="admin/identity-providers" tooltipText="Identity providers help" />
            <Button size="sm" startDecorator={<Add />} onClick={handleCreate} data-testid="identity-provider-add-btn">
              Add identity provider
            </Button>
          </>
        }
      />

      <DataTable
        label="Identity providers"
        testId="identity-providers-table"
        rows={idps}
        columns={columns}
        getRowId={idp => idp.id}
        rowTestId={idp => `identity-provider-row-${idp.id}`}
        loading={loading}
        error={loadError && idps.length === 0 ? 'Could not load identity providers.' : undefined}
        onRetry={retryLoad}
        empty={
          <EmptyState
            title="No identity providers yet"
            description="Add a SAML or Okta provider to route an email domain to single sign-on."
            action={
              <Button
                size="sm"
                variant="outlined"
                startDecorator={<Add />}
                onClick={handleCreate}
                data-testid="identity-provider-empty-add-btn"
              >
                Add identity provider
              </Button>
            }
          />
        }
        rowActions={idp => (
          <ProviderRowMenu
            idp={idp}
            onSpMetadata={() => {
              setSelectedIdp(idp);
              setSpMetadataOpen(true);
            }}
            onEdit={() => handleEdit(idp)}
            onDelete={() => setDeleteTarget(idp)}
          />
        )}
        // Name and domain truncate; below 44rem the table scrolls sideways inside its frame.
        minWidth="44rem"
        maxHeight="none"
        pagination={false}
      />

      <AdminDialog
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingIdp ? 'Edit identity provider' : 'Add identity provider'}
        width={640}
        data-testid="identity-provider-form-dialog"
      >
        <DialogContent>
          <Stack spacing={2}>
            <FormControl>
              <FormLabel>Name</FormLabel>
              <Input
                value={formData.name}
                onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
                placeholder="My Company SSO"
                slotProps={{ input: { 'data-testid': 'identity-provider-name-input' } }}
              />
            </FormControl>

            <FormControl>
              <FormLabel>Email Domain</FormLabel>
              <Input
                value={formData.emailDomain}
                onChange={e => setFormData(prev => ({ ...prev, emailDomain: e.target.value }))}
                placeholder="company.com"
                slotProps={{ input: { 'data-testid': 'identity-provider-domain-input' } }}
              />
            </FormControl>

            <FormControl>
              <FormLabel>Type</FormLabel>
              <Select
                value={formData.type}
                onChange={(_, value) => setFormData(prev => ({ ...prev, type: value as 'saml' | 'okta' }))}
              >
                <Option value="saml">SAML</Option>
                <Option value="okta">Okta</Option>
              </Select>
            </FormControl>

            <FormControl orientation="horizontal">
              <FormLabel>Active</FormLabel>
              <Switch
                checked={formData.isActive}
                onChange={e => setFormData(prev => ({ ...prev, isActive: e.target.checked }))}
              />
            </FormControl>

            <Divider />

            {formData.type === 'saml' && (
              <Stack spacing={2}>
                <Typography level="title-sm" component="h3">
                  SAML configuration
                </Typography>

                <FormControl>
                  <FormLabel>Entry Point (SSO URL)</FormLabel>
                  <Input
                    value={formData.samlConfig?.entryPoint || ''}
                    onChange={e =>
                      setFormData(prev => ({
                        ...prev,
                        samlConfig: { ...prev.samlConfig!, entryPoint: e.target.value },
                      }))
                    }
                    placeholder="https://idp.company.com/saml/sso"
                  />
                </FormControl>

                <FormControl>
                  <FormLabel>Issuer</FormLabel>
                  <Input
                    value={formData.samlConfig?.issuer || ''}
                    onChange={e =>
                      setFormData(prev => ({
                        ...prev,
                        samlConfig: { ...prev.samlConfig!, issuer: e.target.value },
                      }))
                    }
                    placeholder="https://idp.company.com"
                  />
                </FormControl>

                <FormControl>
                  <FormLabel>Certificate</FormLabel>
                  <Textarea
                    minRows={4}
                    value={formData.samlConfig?.cert || ''}
                    onChange={e =>
                      setFormData(prev => ({
                        ...prev,
                        samlConfig: { ...prev.samlConfig!, cert: e.target.value },
                      }))
                    }
                    placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                  />
                </FormControl>
              </Stack>
            )}

            {formData.type === 'okta' && (
              <Stack spacing={2}>
                <Typography level="title-sm" component="h3">
                  Okta configuration
                </Typography>

                <FormControl>
                  <FormLabel>Audience (Okta Domain)</FormLabel>
                  <Input
                    value={formData.oktaConfig?.audience || ''}
                    onChange={e =>
                      setFormData(prev => ({
                        ...prev,
                        oktaConfig: { ...prev.oktaConfig!, audience: e.target.value },
                      }))
                    }
                    placeholder="https://company.okta.com"
                  />
                </FormControl>

                <FormControl>
                  <FormLabel>Client ID</FormLabel>
                  <Input
                    value={formData.oktaConfig?.clientId || ''}
                    onChange={e =>
                      setFormData(prev => ({
                        ...prev,
                        oktaConfig: { ...prev.oktaConfig!, clientId: e.target.value },
                      }))
                    }
                  />
                </FormControl>

                <FormControl>
                  <FormLabel>Client Secret</FormLabel>
                  <Input
                    type={showClientSecret ? 'text' : 'password'}
                    value={formData.oktaConfig?.clientSecret || ''}
                    onChange={e =>
                      setFormData(prev => ({
                        ...prev,
                        oktaConfig: { ...prev.oktaConfig!, clientSecret: e.target.value },
                      }))
                    }
                    endDecorator={
                      <IconButton
                        size="sm"
                        variant="plain"
                        onClick={() => setShowClientSecret(!showClientSecret)}
                        title={showClientSecret ? 'Hide secret' : 'Show secret'}
                      >
                        {showClientSecret ? <VisibilityOff /> : <Visibility />}
                      </IconButton>
                    }
                  />
                  {/* The API never sends a stored secret back, so this field is always blank on
                      an edit. Say what is actually stored, or a blank field reads as
                      "the secret is gone" - and a genuinely missing one stays invisible. */}
                  {editingIdp && (
                    <FormHelperText>
                      {editingIdp.hasSecrets?.clientSecret
                        ? 'A secret is stored. Leave blank to keep it.'
                        : 'No secret is stored for this provider - logins will fall back to the deploy-level Okta credentials.'}
                    </FormHelperText>
                  )}
                </FormControl>

                <FormControl>
                  <Checkbox
                    label="Use Org-Level Authorization Server"
                    checked={formData.oktaConfig?.useOrgAuthServer || false}
                    onChange={e =>
                      setFormData(prev => ({
                        ...prev,
                        oktaConfig: { ...prev.oktaConfig!, useOrgAuthServer: e.target.checked },
                      }))
                    }
                  />
                  <Typography level="body-xs" sx={{ mt: 0.5 }}>
                    Check this for org-level authorization server (discovery URL: https://domain/.well-known/...). Leave
                    unchecked for custom authorization servers.
                  </Typography>
                </FormControl>

                <FormControl>
                  <FormLabel>Authorization Server ID (Optional)</FormLabel>
                  <Input
                    value={formData.oktaConfig?.authServerId || ''}
                    onChange={e =>
                      setFormData(prev => ({
                        ...prev,
                        oktaConfig: { ...prev.oktaConfig!, authServerId: e.target.value },
                      }))
                    }
                    placeholder="default"
                    disabled={formData.oktaConfig?.useOrgAuthServer}
                  />
                  <Typography level="body-xs" sx={{ mt: 0.5 }}>
                    Leave blank to use &apos;default&apos;. Ignored if &quot;Use Org-Level Authorization Server&quot; is
                    checked.
                  </Typography>
                </FormControl>
              </Stack>
            )}

            <Stack direction="row" justifyContent="flex-end" spacing={1}>
              <Button
                variant="plain"
                color="neutral"
                onClick={() => setModalOpen(false)}
                data-testid="identity-provider-form-cancel-btn"
              >
                Cancel
              </Button>
              <Button onClick={handleSubmit} data-testid="identity-provider-form-submit-btn">
                {editingIdp ? 'Save changes' : 'Add identity provider'}
              </Button>
            </Stack>
          </Stack>
        </DialogContent>
      </AdminDialog>

      <AdminDialog
        open={spMetadataOpen}
        onClose={() => setSpMetadataOpen(false)}
        title="Service provider metadata"
        width={640}
        data-testid="identity-provider-sp-metadata-dialog"
      >
        <DialogContent>
          <Typography level="body-md" sx={{ mb: 2 }}>
            Use these values to configure {selectedIdp?.name} on the Identity Provider side:
          </Typography>

          <Stack spacing={3}>
            <FormControl>
              <FormLabel>ACS URL (Assertion Consumer Service URL)</FormLabel>
              <Input
                value={`${window.location.origin}/api/auth/saml/callback`}
                readOnly
                endDecorator={
                  <Button
                    size="sm"
                    variant="outlined"
                    onClick={() => navigator.clipboard.writeText(`${window.location.origin}/api/auth/saml/callback`)}
                  >
                    Copy
                  </Button>
                }
              />
            </FormControl>

            <FormControl>
              <FormLabel>Entity ID (Service Provider Identifier)</FormLabel>
              <Input
                value={`${window.location.origin}/saml/metadata`}
                readOnly
                endDecorator={
                  <Button
                    size="sm"
                    variant="outlined"
                    onClick={() => navigator.clipboard.writeText(`${window.location.origin}/saml/metadata`)}
                  >
                    Copy
                  </Button>
                }
              />
            </FormControl>

            <FormControl>
              <FormLabel>Start URL (Optional - Post-login redirect)</FormLabel>
              <Input
                value={`${window.location.origin}/new`}
                readOnly
                endDecorator={
                  <Button
                    size="sm"
                    variant="outlined"
                    onClick={() => navigator.clipboard.writeText(`${window.location.origin}/new`)}
                  >
                    Copy
                  </Button>
                }
              />
            </FormControl>

            <FormControl>
              <FormLabel>SAML Initiation URL (Use this for testing or direct links)</FormLabel>
              <Input
                value={`${window.location.origin}/api/auth/saml?idp=${selectedIdp?.id}`}
                readOnly
                endDecorator={
                  <Button
                    size="sm"
                    variant="outlined"
                    onClick={() =>
                      navigator.clipboard.writeText(`${window.location.origin}/api/auth/saml?idp=${selectedIdp?.id}`)
                    }
                  >
                    Copy
                  </Button>
                }
              />
            </FormControl>

            <Box>
              <Typography level="title-sm" component="h3" sx={{ mb: 1 }}>
                Configuration instructions
              </Typography>
              <Typography level="body-sm" component="div">
                <ol style={{ margin: 0, paddingLeft: '1.2em' }}>
                  <li>Copy the ACS URL and paste it as the &quot;ACS URL&quot; in your IdP configuration</li>
                  <li>Copy the Entity ID and paste it as the &quot;Entity ID&quot; or &quot;SP Identifier&quot;</li>
                  <li>Optionally, set the Start URL for post-login redirects</li>
                  <li>Ensure the Name ID format is set to &quot;Email Address&quot; or &quot;Persistent&quot;</li>
                  <li>Configure attribute mappings if needed (email, firstName, lastName)</li>
                  <li>
                    <strong>For testing:</strong> Use the SAML Initiation URL instead of the generic callback URL
                  </li>
                  <li>
                    <strong>RelayState:</strong> If your IdP supports it, set RelayState to `idp={selectedIdp?.id}` to
                    help identify this provider
                  </li>
                </ol>
              </Typography>
            </Box>

            <Stack direction="row" spacing={2} sx={{ justifyContent: 'flex-end' }}>
              <Button
                variant="outlined"
                onClick={() => setSpMetadataOpen(false)}
                data-testid="identity-provider-sp-metadata-close-btn"
              >
                Close
              </Button>
            </Stack>
          </Stack>
        </DialogContent>
      </AdminDialog>

      {/* The delete endpoint is audited but takes no reason, so the dialog collects one without sending it. */}
      <ActionDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Delete identity provider"
        description={
          <>
            Deletes <b>{deleteTarget?.name}</b> and its configuration. Users whose email domain is{' '}
            <b>{deleteTarget?.emailDomain}</b> lose single sign-on. To keep the configuration, turn the provider off
            under Edit provider instead.
          </>
        }
        reasonPresets={ADMIN_REASON_PRESETS.identityProviderDelete}
        reasonAudited={false}
        tone="danger"
        // ActionDialog trims what the admin types, so the stored name is trimmed to match.
        typedConfirm={deleteTarget ? { expected: deleteTarget.name.trim(), noun: 'provider name' } : undefined}
        confirmLabel="Delete provider"
        onConfirm={() => (deleteTarget ? handleDelete(deleteTarget.id) : undefined)}
        data-testid="identity-provider-delete-dialog"
      />
    </Stack>
  );
};

export default IdentityProvidersTab;
