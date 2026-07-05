import { useState, useEffect } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  Divider,
  FormControl,
  FormLabel,
  Input,
  Modal,
  ModalDialog,
  Option,
  Select,
  Stack,
  Switch,
  Table,
  Typography,
  Textarea,
  IconButton,
} from '@mui/joy';
import { Add, Edit, Delete, Info, Visibility, VisibilityOff } from '@mui/icons-material';
import toast from 'react-hot-toast';
import { api } from '@client/app/contexts/ApiContext';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';

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
  createdAt: string;
  updatedAt: string;
}

const IdentityProvidersTab: React.FC = () => {
  const [idps, setIdps] = useState<IdentityProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingIdp, setEditingIdp] = useState<IdentityProvider | null>(null);
  const [spMetadataOpen, setSpMetadataOpen] = useState(false);
  const [selectedIdp, setSelectedIdp] = useState<IdentityProvider | null>(null);
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
    } catch (error) {
      console.error('Error fetching IDPs:', error);
      toast.error('Failed to load identity providers');
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
    if (!confirm('Are you sure you want to delete this identity provider?')) {
      return;
    }

    try {
      await api.delete(`/api/admin/identity-providers/${id}`);
      toast.success('Identity provider deleted');
      fetchIdps();
    } catch (error: any) {
      console.error('Error deleting IDP:', error);
      toast.error(error.response?.data?.error || 'Failed to delete identity provider');
    }
  };

  if (loading) {
    return <Typography>Loading identity providers...</Typography>;
  }

  return (
    <Box sx={{ p: 2 }}>
      <Box
        sx={{
          display: 'flex',
          flexDirection: { xs: 'column', sm: 'row' },
          justifyContent: 'space-between',
          alignItems: { xs: 'stretch', sm: 'center' },
          gap: 2,
          mb: 3,
        }}
      >
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography level="h2">Identity Providers</Typography>
          <ContextHelpButton helpId="admin/identity-providers" tooltipText="Identity Providers Help" />
        </Stack>
        <Button startDecorator={<Add />} onClick={handleCreate} sx={{ width: { xs: '100%', sm: 'auto' } }}>
          Add Identity Provider
        </Button>
      </Box>

      <Box sx={{ overflowX: { xs: 'auto', sm: 'visible' } }}>
        <Table sx={{ minWidth: { xs: '700px', sm: 'auto' } }}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email Domain</th>
              <th>Type</th>
              <th>Status</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {idps.map(idp => (
              <tr key={idp.id}>
                <td>{idp.name}</td>
                <td>{idp.emailDomain}</td>
                <td>
                  <Chip color={idp.type === 'saml' ? 'primary' : 'success'}>{idp.type.toUpperCase()}</Chip>
                </td>
                <td>
                  <Chip color={idp.isActive ? 'success' : 'neutral'}>{idp.isActive ? 'Active' : 'Inactive'}</Chip>
                </td>
                <td>{new Date(idp.createdAt).toLocaleDateString()}</td>
                <td>
                  <Stack direction="row" spacing={1}>
                    {idp.type === 'saml' && (
                      <IconButton
                        size="sm"
                        color="neutral"
                        onClick={() => {
                          setSelectedIdp(idp);
                          setSpMetadataOpen(true);
                        }}
                        title="View SP Metadata"
                      >
                        <Info />
                      </IconButton>
                    )}
                    <IconButton size="sm" onClick={() => handleEdit(idp)}>
                      <Edit />
                    </IconButton>
                    <IconButton size="sm" color="danger" onClick={() => handleDelete(idp.id)}>
                      <Delete />
                    </IconButton>
                  </Stack>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Box>

      {idps.length === 0 && (
        <Card sx={{ mt: 2 }}>
          <CardContent>
            <Typography level="body-md" textAlign="center">
              No identity providers configured. Click &quot;Add Identity Provider&quot; to get started.
            </Typography>
          </CardContent>
        </Card>
      )}

      {/* Modal for Create/Edit */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)}>
        <ModalDialog sx={{ minWidth: 600, maxWidth: 800, maxHeight: '90vh', overflow: 'auto' }}>
          <Typography level="h3">{editingIdp ? 'Edit Identity Provider' : 'Add Identity Provider'}</Typography>

          <Stack spacing={2} sx={{ mt: 2 }}>
            <FormControl>
              <FormLabel>Name</FormLabel>
              <Input
                value={formData.name}
                onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
                placeholder="My Company SSO"
              />
            </FormControl>

            <FormControl>
              <FormLabel>Email Domain</FormLabel>
              <Input
                value={formData.emailDomain}
                onChange={e => setFormData(prev => ({ ...prev, emailDomain: e.target.value }))}
                placeholder="company.com"
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
                <Typography level="h4">SAML Configuration</Typography>

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
                <Typography level="h4">Okta Configuration</Typography>

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

            <Stack direction="row" spacing={2} sx={{ mt: 3 }}>
              <Button onClick={() => setModalOpen(false)} variant="outlined">
                Cancel
              </Button>
              <Button onClick={handleSubmit}>{editingIdp ? 'Update' : 'Create'}</Button>
            </Stack>
          </Stack>
        </ModalDialog>
      </Modal>

      {/* SP Metadata Modal */}
      <Modal open={spMetadataOpen} onClose={() => setSpMetadataOpen(false)}>
        <ModalDialog sx={{ minWidth: 600, maxWidth: 800 }}>
          <Typography level="h3">Service Provider Metadata</Typography>
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
                  <Button size="sm" onClick={() => navigator.clipboard.writeText(`${window.location.origin}/new`)}>
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
                    onClick={() =>
                      navigator.clipboard.writeText(`${window.location.origin}/api/auth/saml?idp=${selectedIdp?.id}`)
                    }
                  >
                    Copy
                  </Button>
                }
              />
            </FormControl>

            <Box sx={{ p: 2, bgcolor: 'background.level1', borderRadius: 'md' }}>
              <Typography level="body-sm" sx={{ fontWeight: 'bold', mb: 1 }}>
                Configuration Instructions:
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
              <Button variant="outlined" onClick={() => setSpMetadataOpen(false)}>
                Close
              </Button>
            </Stack>
          </Stack>
        </ModalDialog>
      </Modal>
    </Box>
  );
};

export default IdentityProvidersTab;
