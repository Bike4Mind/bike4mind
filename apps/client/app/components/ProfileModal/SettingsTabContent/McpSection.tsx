import { McpServerName } from '@bike4mind/common';
import { Checkbox, FormControl, Input, Stack, Typography, Button, FormLabel, Table, IconButton, Box } from '@mui/joy';
import React, { useState } from 'react';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import { Select, Option, Modal, ModalDialog, Chip } from '@mui/joy';
import { mcpSettings } from '@client/app/utils/mcpSettings';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { gray } from '@client/app/utils/themes/colors';
import SectionContainer from '../SectionContainer';
import { useMcpServers, mcpServerKeys } from '@client/app/hooks/data/mcpServers';
import McpToolsModal from './McpToolsModal';

interface EnvVariable {
  key: string;
  value: string;
}

interface McpServer {
  id: string;
  name: McpServerName;
  envVariables: EnvVariable[];
  enabled: boolean;
  tools?: string[];
}

const McpSection = () => {
  const queryClient = useQueryClient();
  const [formData, setFormData] = useState<Omit<McpServer, 'id'>>({
    name: McpServerName.LinkedIn,
    envVariables: mcpSettings[McpServerName.LinkedIn]?.envVariables?.map(key => ({
      key,
      value: '',
    })) || [{ key: '', value: '' }],
    enabled: true,
  });

  const handleAddEnvVariable = () => {
    setFormData(prev => ({
      ...prev,
      envVariables: [...prev.envVariables, { key: '', value: '' }],
    }));
  };

  const handleRemoveEnvVariable = (index: number) => {
    setFormData(prev => ({
      ...prev,
      envVariables: prev.envVariables.filter((_, i) => i !== index),
    }));
  };

  const handleEnvVariableChange = (index: number, field: 'key' | 'value', value: string) => {
    setFormData(prev => ({
      ...prev,
      envVariables: prev.envVariables.map((envVar, i) => (i === index ? { ...envVar, [field]: value } : envVar)),
    }));
  };

  const [editingId, setEditingId] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [toolsModalServer, setToolsModalServer] = useState<McpServer | null>(null);

  const { data: servers, isLoading } = useMcpServers();

  const createMutation = useMutation({
    mutationFn: (data: Omit<McpServer, 'id'>) => api.post('/api/mcp-servers', data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: mcpServerKeys.list() }),
  });

  const updateMutation = useMutation({
    mutationFn: (data: McpServer) => api.put(`/api/mcp-servers/${data.id}`, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: mcpServerKeys.list() }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/mcp-servers/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: mcpServerKeys.list() }),
  });

  const connectMutation = useMutation({
    mutationFn: (id: string) => api.post(`/api/mcp-servers/${id}/connect`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: mcpServerKeys.list() }),
  });

  const handleConnect = async (id: string) => {
    try {
      await connectMutation.mutateAsync(id);
    } catch (error) {
      console.error('Error connecting to MCP server:', error);
    }
  };

  const handleEdit = (server: McpServer) => {
    setFormData({
      name: server.name,
      envVariables: server.envVariables,
      enabled: server.enabled,
    });
    setEditingId(server.id);
    setIsModalOpen(true);
  };

  const handleCancelEdit = () => {
    setFormData({
      name: McpServerName.LinkedIn,
      envVariables: mcpSettings[McpServerName.LinkedIn]?.envVariables?.map(key => ({
        key,
        value: '',
      })) || [{ key: '', value: '' }],
      enabled: true,
    });
    setEditingId(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editingId) {
        await updateMutation.mutateAsync({ ...formData, id: editingId });
      } else {
        await createMutation.mutateAsync(formData);
      }
      handleCancelEdit();
    } catch (error) {
      console.error('Error saving MCP server:', error);
    }
  };

  const handleDelete = async (id: string) => {
    if (window.confirm('Are you sure you want to delete this server?')) {
      await deleteMutation.mutateAsync(id);
    }
  };

  return (
    <>
      <SectionContainer
        title="MCP Servers"
        action={
          <Button
            variant="solid"
            onClick={() => {
              handleCancelEdit();
              setIsModalOpen(true);
            }}
          >
            Add New MCP Server
          </Button>
        }
      >
        <Box>
          {isLoading ? (
            <Typography>Loading...</Typography>
          ) : servers?.length ? (
            <Box sx={{ overflowX: 'auto' }}>
              <Table variant="outlined" borderAxis="bothBetween" sx={{ minWidth: '600px' }}>
                <thead>
                  <tr>
                    <th style={{ width: '15%', minWidth: '100px' }}>Name</th>
                    <th style={{ width: '10%', minWidth: '80px' }}>Enabled</th>
                    <th style={{ width: '25%', minWidth: '150px' }}>Env Variables</th>
                    <th style={{ width: '15%', minWidth: '100px' }}>Tools</th>
                    <th style={{ width: '35%', minWidth: '200px' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {servers.map(server => (
                    <tr key={server.id}>
                      <td>{server.name}</td>
                      <td>{server.enabled ? 'Yes' : 'No'}</td>
                      <td>
                        <Box
                          sx={{
                            maxHeight: '90px',
                            overflowY: 'scroll',
                            wordBreak: 'break-word',
                            pr: 1,
                            '&::-webkit-scrollbar': {
                              width: '4px',
                            },
                            '&::-webkit-scrollbar-thumb': {
                              backgroundColor: gray[655],
                              borderRadius: '3px',
                            },
                          }}
                        >
                          {server.envVariables.map((env, i) => (
                            <div key={i}>{env.key}</div>
                          ))}
                        </Box>
                      </td>
                      <td>
                        {server.tools?.length ? (
                          <Chip
                            variant="soft"
                            color="primary"
                            sx={{ cursor: 'pointer' }}
                            onClick={() => setToolsModalServer(server)}
                          >
                            {server.tools.length} tool{server.tools.length !== 1 ? 's' : ''}
                          </Chip>
                        ) : (
                          <Typography level="body-sm" color="neutral">
                            None
                          </Typography>
                        )}
                      </td>
                      <td>
                        {server.name === McpServerName.Atlassian || server.name === McpServerName.Github ? (
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                            <Typography level="body-xs" color="neutral" sx={{ flexShrink: 0 }}>
                              Managed via Connected Apps / Github Integration
                            </Typography>
                            <IconButton onClick={() => handleDelete(server.id)} size="sm">
                              <DeleteIcon sx={{ fontSize: 16 }} />
                            </IconButton>
                          </Box>
                        ) : (
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                            <IconButton onClick={() => handleEdit(server)} size="sm">
                              <EditIcon sx={{ fontSize: 16 }} />
                            </IconButton>
                            <IconButton onClick={() => handleDelete(server.id)} size="sm">
                              <DeleteIcon sx={{ fontSize: 16 }} />
                            </IconButton>
                            <Button
                              variant="outlined"
                              color="success"
                              onClick={() => handleConnect(server.id)}
                              loading={connectMutation.isPending}
                              size="sm"
                            >
                              Connect
                            </Button>
                          </Box>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Box>
          ) : (
            <Typography>No MCP servers found</Typography>
          )}
        </Box>
      </SectionContainer>

      <Modal open={isModalOpen} onClose={() => setIsModalOpen(false)}>
        <ModalDialog>
          <form
            onSubmit={e => {
              handleSubmit(e);
              setIsModalOpen(false);
            }}
          >
            <Stack spacing={2}>
              <Typography level="h4">{editingId ? 'Edit MCP Server' : 'Create New MCP Server'}</Typography>

              <FormControl>
                <FormLabel>Server Name</FormLabel>
                <Select
                  value={formData.name}
                  onChange={(e, value) => {
                    const name = value as McpServerName;
                    setFormData(prev => ({
                      ...prev,
                      name,
                      envVariables: mcpSettings[name]?.envVariables?.map(key => ({
                        key,
                        value: '',
                      })) || [{ key: '', value: '' }],
                    }));
                  }}
                  required
                >
                  {Object.values(McpServerName)
                    .filter(name => name !== McpServerName.Atlassian && name !== McpServerName.Github)
                    .map(name => (
                      <Option key={name} value={name}>
                        {name}
                      </Option>
                    ))}
                </Select>
              </FormControl>

              <FormControl>
                <FormLabel>Enabled</FormLabel>
                <Checkbox
                  checked={formData.enabled}
                  onChange={e => setFormData(prev => ({ ...prev, enabled: e.target.checked }))}
                />
              </FormControl>

              <Typography level="title-md">Environment Variables</Typography>
              {formData.envVariables.map((envVar, index) => (
                <Stack key={index} direction="row" spacing={2} alignItems="center">
                  <FormControl>
                    <FormLabel>Key</FormLabel>
                    <Input
                      value={envVar.key}
                      onChange={e => handleEnvVariableChange(index, 'key', e.target.value)}
                      required
                    />
                  </FormControl>
                  <FormControl>
                    <FormLabel>Value</FormLabel>
                    <Input
                      value={envVar.value}
                      onChange={e => handleEnvVariableChange(index, 'value', e.target.value)}
                      required
                    />
                  </FormControl>
                  <Button color="danger" variant="soft" onClick={() => handleRemoveEnvVariable(index)} sx={{ mt: 2 }}>
                    Remove
                  </Button>
                </Stack>
              ))}

              <Button variant="outlined" color="neutral" onClick={handleAddEnvVariable} type="button">
                Add Environment Variable
              </Button>

              <Stack direction="row" spacing={2}>
                <Button variant="solid" type="submit">
                  {editingId ? 'Update Server' : 'Create Server'}
                </Button>
                <Button
                  variant="outlined"
                  onClick={() => {
                    handleCancelEdit();
                    setIsModalOpen(false);
                  }}
                >
                  Cancel
                </Button>
              </Stack>
            </Stack>
          </form>
        </ModalDialog>
      </Modal>

      <McpToolsModal
        open={!!toolsModalServer}
        onClose={() => setToolsModalServer(null)}
        serverName={toolsModalServer?.name || ''}
        tools={toolsModalServer?.tools || []}
      />
    </>
  );
};

export default McpSection;
