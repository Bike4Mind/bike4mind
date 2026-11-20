import { useEffect, useState } from 'react';
import Stack from '@mui/joy/Stack';
import Select from '@mui/joy/Select';
import Option from '@mui/joy/Option';
import Button from '@mui/joy/Button';
import Typography from '@mui/joy/Typography';
import { modelSupportsTools, type ChatModelOption } from '@shared/chat';
import { inheritancePolicy, resolveModelAlias, WORKER_ROLES, type RolePolicy } from '@shared/orchestration';

export function economicalWorkerPreset(models: readonly ChatModelOption[]): RolePolicy | null {
  const worker = models
    .filter(
      model =>
        !model.unavailable &&
        !model.disabled &&
        modelSupportsTools(model.id, model) &&
        /sonnet/i.test(`${model.id} ${model.name}`) &&
        !/preview|beta|deprecated/i.test(model.name)
    )
    .sort(
      (left, right) =>
        (right.releaseDate ?? '').localeCompare(left.releaseDate ?? '') || left.id.localeCompare(right.id)
    )[0];
  if (!worker) return null;
  return { ...inheritancePolicy(), roles: { implementation: worker.id, exploration: worker.id, review: 'inherit' } };
}

const ROUTING_FAMILIES = ['opus', 'sonnet', 'haiku'];

/** The newest usable model of each family an agent's routing instructions tend to name. */
export function familyOverrides(models: readonly ChatModelOption[]): string[] {
  const usable = models
    .filter(model => !model.unavailable && !model.disabled && modelSupportsTools(model.id, model))
    .map(model => model.id);
  return ROUTING_FAMILIES.map(family => resolveModelAlias(family, usable, models)).filter(
    (id): id is string => id !== null
  );
}

export function OrchestrationSettings() {
  const [policy, setPolicy] = useState<RolePolicy | null>(null);
  const [models, setModels] = useState<ChatModelOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let current = true;
    async function load() {
      try {
        const [saved, catalog] = await Promise.all([window.b4m.chat.getRolePolicy(), window.b4m.chat.listModels()]);
        if (current) {
          setPolicy(saved);
          setModels(catalog.models);
        }
      } catch (failure) {
        if (current) setError(String(failure));
      }
    }
    void load();
    return () => {
      current = false;
    };
  }, []);
  const options = (control: string, selectedIds: readonly string[] = []) => [
    ...models.map(model => (
      <Option
        key={model.id}
        value={model.id}
        data-testid={`${control}-option-${model.id}`}
        disabled={
          !selectedIds.includes(model.id) &&
          (!!model.unavailable || model.disabled || !modelSupportsTools(model.id, model))
        }
      >
        {model.name}
        {model.unavailable || model.disabled || !modelSupportsTools(model.id, model) ? ' (unavailable)' : ''}
      </Option>
    )),
    ...selectedIds
      .filter(id => !models.some(model => model.id === id))
      .map(id => (
        <Option key={id} value={id} data-testid={`${control}-option-${id}`}>
          {id} (unavailable; remove to replace)
        </Option>
      )),
  ];
  const unavailable = policy
    ? Array.from(
        new Set([...Object.values(policy.roles), ...policy.allowedOverrides, ...policy.escalation.allowedModels])
      ).filter(
        id =>
          id !== 'inherit' &&
          !models.some(
            model => model.id === id && !model.unavailable && !model.disabled && modelSupportsTools(model.id, model)
          )
      )
    : [];
  async function save() {
    if (!policy) return;
    setSaving(true);
    setError(null);
    try {
      setPolicy(await window.b4m.chat.setRolePolicy(policy));
    } catch (failure) {
      setError(String(failure));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Stack spacing={1} data-testid="orchestration-settings">
      <Typography level="body-sm">
        Defaults apply when Orchestrate is enabled for a future run. Active trees retain their snapshot. Choose the
        planner using the conversation model picker.
      </Typography>
      {error && (
        <Typography role="alert" color="danger">
          {error}
        </Typography>
      )}
      {unavailable.length > 0 && (
        <Typography role="alert" color="danger">
          Unavailable configuration: {unavailable.join(', ')}. Select a replacement and save.
        </Typography>
      )}
      {policy && (
        <>
          {WORKER_ROLES.map(role => (
            <Stack key={role} spacing={0.5}>
              <Typography level="title-sm">{role}</Typography>
              <Select
                aria-label={`${role} worker model`}
                data-testid={`orchestration-${role}-select`}
                value={policy.roles[role]}
                renderValue={() =>
                  policy.roles[role] === 'inherit'
                    ? 'Inherit parent model'
                    : (models.find(model => model.id === policy.roles[role])?.name ??
                      `${policy.roles[role]} (unavailable)`)
                }
                onChange={(_event, value) =>
                  value && setPolicy({ ...policy, roles: { ...policy.roles, [role]: value } })
                }
              >
                <Option value="inherit">Inherit parent model</Option>
                {!models.some(model => model.id === policy.roles[role]) && policy.roles[role] !== 'inherit' && (
                  <Option value={policy.roles[role]}>{policy.roles[role]} (unavailable)</Option>
                )}
                {options(`orchestration-${role}`)}
              </Select>
            </Stack>
          ))}
          <Typography level="title-sm">Permitted spawn overrides</Typography>
          <Typography level="body-xs">
            Models an agent may request for a worker instead of the role default. A family name such as sonnet starts
            the newest model allowed here. With none allowed, agents are not offered a model choice.
          </Typography>
          <Select
            multiple
            aria-label="Permitted spawn overrides"
            data-testid="orchestration-overrides-select"
            value={policy.allowedOverrides}
            onChange={(_event, value) => setPolicy({ ...policy, allowedOverrides: value })}
          >
            {options('orchestration-overrides', policy.allowedOverrides)}
          </Select>
          <Button
            variant="outlined"
            data-testid="orchestration-overrides-families-btn"
            disabled={familyOverrides(models).every(id => policy.allowedOverrides.includes(id))}
            onClick={() =>
              setPolicy({
                ...policy,
                allowedOverrides: Array.from(new Set([...policy.allowedOverrides, ...familyOverrides(models)])).slice(
                  0,
                  32
                ),
              })
            }
          >
            Allow the newest Opus, Sonnet and Haiku
          </Button>
          <Typography level="title-sm">Models available for an approved task upgrade</Typography>
          <Select
            multiple
            aria-label="Allowed upgrade models"
            data-testid="orchestration-upgrade-models-select"
            value={policy.escalation.allowedModels}
            onChange={(_event, value) =>
              setPolicy({ ...policy, escalation: { ...policy.escalation, allowedModels: value, mode: 'ask' } })
            }
          >
            {options('orchestration-upgrade-models', policy.escalation.allowedModels)}
          </Select>
          <Select
            multiple
            aria-label="Allowed upgrade roles"
            value={policy.escalation.allowedRoles}
            onChange={(_event, value) =>
              setPolicy({ ...policy, escalation: { ...policy.escalation, allowedRoles: value } })
            }
          >
            {WORKER_ROLES.map(role => (
              <Option key={role} value={role}>
                {role}
              </Option>
            ))}
          </Select>
          <Typography level="body-xs">
            Ask before model upgrades. Automatic upgrades are unavailable until shared root budget admission is
            connected. This setting does not enforce a spending cap.
          </Typography>
          <Typography level="body-xs">
            For a premium-planner preset, choose an available Opus model in the conversation picker and apply current
            Sonnet workers below. The preset is unavailable when this catalog has no capable Sonnet model.
          </Typography>
          <Button
            variant="outlined"
            data-testid="orchestration-preset-btn"
            disabled={!economicalWorkerPreset(models)}
            onClick={() => {
              const preset = economicalWorkerPreset(models);
              if (preset) setPolicy(preset);
            }}
          >
            Use current Sonnet workers, inherited review
          </Button>
          <Button data-testid="orchestration-save-btn" loading={saving} onClick={() => void save()}>
            Save future-run defaults
          </Button>
        </>
      )}
    </Stack>
  );
}
