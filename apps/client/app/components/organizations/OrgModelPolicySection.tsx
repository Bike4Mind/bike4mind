import { FC, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  Checkbox,
  CircularProgress,
  FormControl,
  FormHelperText,
  FormLabel,
  Option,
  Select,
  Stack,
  Switch,
  Typography,
} from '@mui/joy';
import {
  b4mLLMTools,
  expandOrgAllowedTools,
  ModelBackend,
  type IOrganizationDocument,
  type ModelInfo,
  type OrgModelPolicy,
} from '@bike4mind/common';
import {
  useOrgModelPolicy,
  useResetOrgModelPolicy,
  useSaveOrgModelPolicy,
} from '@client/app/hooks/data/useOrgModelPolicy';
import { useLockedModels, useModelInfo } from '@client/app/hooks/data/useModelInfo';

interface PolicyForm {
  restrictProviders: boolean;
  providers: string[];
  restrictModels: boolean;
  models: string[];
  restrictTools: boolean;
  tools: string[];
}

const toForm = (policy: OrgModelPolicy): PolicyForm => ({
  restrictProviders: policy.allowedProviders !== null,
  providers: [...(policy.allowedProviders ?? [])],
  restrictModels: policy.allowedModels !== null,
  models: [...(policy.allowedModels ?? [])],
  restrictTools: policy.allowedTools !== null,
  tools: [...(policy.allowedTools ?? [])],
});

const toPolicy = (form: PolicyForm): OrgModelPolicy => ({
  allowedProviders: form.restrictProviders ? (form.providers as OrgModelPolicy['allowedProviders']) : null,
  allowedModels: form.restrictModels ? form.models : null,
  allowedTools: form.restrictTools ? (form.tools as OrgModelPolicy['allowedTools']) : null,
});

const PROVIDERS: readonly string[] = Object.values(ModelBackend);

// A companion (e.g. retrieve_knowledge_content) is allowed with the tool it pairs with, so it is shown
// beside that tool rather than as its own checkbox.
const TOOL_ROWS: ReadonlyArray<{ tool: string; companions: string[] }> = (() => {
  const covered = new Set<string>();
  const rows: Array<{ tool: string; companions: string[] }> = [];
  for (const tool of b4mLLMTools.options) {
    if (covered.has(tool)) continue;
    const companions = [...expandOrgAllowedTools([tool])].filter(name => name !== tool);
    companions.forEach(name => covered.add(name));
    rows.push({ tool, companions });
  }
  return rows;
})();

const toggle = (list: string[], value: string, on: boolean) =>
  on ? [...list.filter(item => item !== value), value] : list.filter(item => item !== value);

const sameList = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

const sameForm = (a: PolicyForm, b: PolicyForm) =>
  a.restrictProviders === b.restrictProviders &&
  a.restrictModels === b.restrictModels &&
  a.restrictTools === b.restrictTools &&
  sameList(a.providers, b.providers) &&
  sameList(a.models, b.models) &&
  sameList(a.tools, b.tools);

const RestrictSwitch: FC<{ id: string; label: string; checked: boolean; onChange: (on: boolean) => void }> = ({
  id,
  label,
  checked,
  onChange,
}) => (
  <Switch
    checked={checked}
    onChange={event => onChange(event.target.checked)}
    data-testid={`org-model-policy-${id}-switch`}
    slotProps={{ input: { 'aria-label': label } }}
    endDecorator={checked ? 'Restricted' : 'All allowed'}
  />
);

const PolicyEditor: FC<{ orgId: string; saved: PolicyForm; invalidStored: boolean }> = ({
  orgId,
  saved,
  invalidStored,
}) => {
  const [form, setForm] = useState<PolicyForm>(saved);
  const save = useSaveOrgModelPolicy(orgId);
  const reset = useResetOrgModelPolicy(orgId);
  const { data: listedModels } = useModelInfo();
  const { data: lockedModels } = useLockedModels();

  // Models the org currently disallows come back locked, so both lists together are the full choice.
  const modelChoices = useMemo(() => {
    const byId = new Map<string, ModelInfo>();
    for (const model of [...(listedModels ?? []), ...(lockedModels ?? [])]) byId.set(model.id, model);
    return [...byId.values()]
      .filter(model => !form.restrictProviders || form.providers.includes(model.backend))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [listedModels, lockedModels, form.restrictProviders, form.providers]);

  const update = (patch: Partial<PolicyForm>) => setForm(current => ({ ...current, ...patch }));
  const emptyRestriction =
    (form.restrictProviders && form.providers.length === 0) || (form.restrictModels && form.models.length === 0);
  const busy = save.isPending || reset.isPending;
  const canSave = !busy && !emptyRestriction && (invalidStored || !sameForm(form, saved));

  return (
    <Card variant="outlined" data-testid="org-model-policy-section">
      <Stack spacing={3}>
        <Box>
          <Typography level="title-md">Models and tools</Typography>
          <Typography level="body-sm">
            Limit which AI providers, models and built-in tools members can use when working in this organization.
            Connector (MCP) tools are governed by the connector policy instead.
          </Typography>
        </Box>
        {invalidStored && (
          <Alert color="danger" data-testid="org-model-policy-invalid-alert">
            The saved policy could not be read, so every model is blocked for this organization. Save or reset it to fix
            this.
          </Alert>
        )}

        <FormControl>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <FormLabel>Providers</FormLabel>
            <RestrictSwitch
              id="providers"
              label="Restrict providers"
              checked={form.restrictProviders}
              onChange={on => update({ restrictProviders: on })}
            />
          </Stack>
          {form.restrictProviders && (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, mt: 1 }}>
              {PROVIDERS.map(provider => (
                <Checkbox
                  key={provider}
                  label={provider}
                  checked={form.providers.includes(provider)}
                  onChange={event => update({ providers: toggle(form.providers, provider, event.target.checked) })}
                  data-testid={`org-model-policy-provider-${provider}`}
                />
              ))}
            </Box>
          )}
          {form.restrictProviders && form.providers.length === 0 && (
            <FormHelperText>Choose at least one provider.</FormHelperText>
          )}
        </FormControl>

        <FormControl>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <FormLabel>Models</FormLabel>
            <RestrictSwitch
              id="models"
              label="Restrict models"
              checked={form.restrictModels}
              onChange={on => update({ restrictModels: on })}
            />
          </Stack>
          {form.restrictModels && (
            <Select
              multiple
              value={form.models}
              onChange={(_event, value) => update({ models: value })}
              placeholder="Choose allowed models"
              data-testid="org-model-policy-models-select"
              sx={{ mt: 1 }}
            >
              {modelChoices.map(model => (
                <Option key={model.id} value={model.id}>
                  {model.name}
                </Option>
              ))}
            </Select>
          )}
          {form.restrictModels && form.models.length === 0 && (
            <FormHelperText>Choose at least one model.</FormHelperText>
          )}
        </FormControl>

        <FormControl>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <FormLabel>Built-in tools</FormLabel>
            <RestrictSwitch
              id="tools"
              label="Restrict built-in tools"
              checked={form.restrictTools}
              onChange={on => update({ restrictTools: on })}
            />
          </Stack>
          {form.restrictTools && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mt: 1 }}>
              {TOOL_ROWS.map(({ tool, companions }) => (
                <Checkbox
                  key={tool}
                  label={companions.length > 0 ? `${tool} (with ${companions.join(', ')})` : tool}
                  checked={form.tools.includes(tool)}
                  onChange={event => update({ tools: toggle(form.tools, tool, event.target.checked) })}
                  data-testid={`org-model-policy-tool-${tool}`}
                />
              ))}
              <FormHelperText>Unchecking every tool turns off all built-in tools.</FormHelperText>
            </Box>
          )}
        </FormControl>

        <Stack direction="row" spacing={1} justifyContent="flex-end">
          <Button
            variant="plain"
            color="neutral"
            onClick={() => reset.mutate()}
            disabled={busy}
            data-testid="org-model-policy-reset-btn"
          >
            Reset to unrestricted
          </Button>
          <Button
            onClick={() => save.mutate(toPolicy(form))}
            disabled={!canSave}
            loading={save.isPending}
            data-testid="org-model-policy-save-btn"
          >
            Save
          </Button>
        </Stack>
      </Stack>
    </Card>
  );
};

const OrgModelPolicySection: FC<{ organization: IOrganizationDocument }> = ({ organization }) => {
  const { data, isLoading, isError } = useOrgModelPolicy(organization.id);

  if (isLoading) return <CircularProgress size="sm" />;
  if (isError || !data) {
    return (
      <Alert color="danger" data-testid="org-model-policy-load-error">
        Could not load the model policy.
      </Alert>
    );
  }
  // Keyed on the saved policy so a save or reset reloads the form from what the server stored.
  return (
    <PolicyEditor
      key={JSON.stringify(data.policy)}
      orgId={organization.id}
      saved={toForm(data.policy)}
      invalidStored={data.invalidStored}
    />
  );
};

export default OrgModelPolicySection;
