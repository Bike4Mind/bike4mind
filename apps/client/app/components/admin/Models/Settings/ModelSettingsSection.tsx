import { useMemo, type ReactNode } from 'react';
import { Alert, Stack, Typography } from '@mui/joy';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { settingsMap, type SettingKey } from '@bike4mind/common';
import { useSettingsFromServer } from '@client/app/hooks/data/settings';
import AdminSettingInputField from '../../AdminSettingInputField';
import AdminStringListSettingField from '../../AdminStringListSettingField';
import { AdminGenerationModelsSetting } from '../../AdminGenerationModelsSetting';
import { AdminOperationsModelSetting } from '../../AdminOperationsModelSetting';
import { AdminRecommendedModelsSetting } from '../../AdminRecommendedModelsSetting';
import { SettingsDraftProvider } from '../../SettingsDraftProvider';
import {
  ErrorState,
  LoadingState,
  MissingPermissionState,
  SettingsSection,
  useMissingAdminPermission,
} from '../../shared';
import { useModelWriteBlock } from '../ModelWriteAction';
import { ModelSettingChoiceField } from './ModelSettingChoiceField';
import {
  leavesModelSettings,
  MODEL_SETTINGS_GROUP_KEYS,
  MODEL_SETTING_CHOICES,
  type ChoiceSettingKey,
} from './modelSettingsKeys';

const isChoiceKey = (key: SettingKey): key is ChoiceSettingKey => key in MODEL_SETTING_CHOICES;

function GroupHeading({ id, title, description }: { id: string; title: string; description: string }) {
  return (
    <Stack gap={0.5} data-testid={`models-settings-${id}-heading`}>
      <Typography level="title-md" component="h2" sx={{ color: 'admin.ink' }}>
        {title}
      </Typography>
      <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
        {description}
      </Typography>
    </Stack>
  );
}

function Group({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Stack component="section" gap={1.5} data-testid={`models-settings-group-${id}`}>
      <GroupHeading id={id} title={title} description={description} />
      {children}
    </Stack>
  );
}

/**
 * GET /api/settings/fetch returns the model keys only to a settings:manage holder; anyone else would see the compiled
 * defaults here as if they were the stored values, so the fields are not drawn for them.
 */
export function ModelSettingsSection() {
  const missing = useMissingAdminPermission('settings:manage');
  if (missing) return <MissingPermissionState requirement="settings:manage" />;
  return <ModelSettingsFields />;
}

function ModelSettingsFields() {
  const { data, isLoading, isError, isFetching, refetch } = useSettingsFromServer();
  const blocked = useModelWriteBlock();

  const storedByKey = useMemo(() => {
    const map = new Map<string, unknown>();
    for (const row of data ?? []) map.set(row.settingName, row.settingValue);
    return map;
  }, [data]);

  if (isLoading) return <LoadingState label="Loading model settings" testId="models-settings-loading" />;
  if (isError && !data) {
    return (
      <ErrorState message="Model settings could not be loaded." onRetry={() => void refetch()} retrying={isFetching} />
    );
  }

  // The remount key resets a field's draft when its stored value changes, as on the other settings pages.
  const renderField = (key: SettingKey, index: number) => {
    const setting = settingsMap[key];
    const stored = storedByKey.get(key);
    const fieldKey = `${key}-${JSON.stringify(stored ?? null)}`;
    if (isChoiceKey(key)) return <ModelSettingChoiceField key={fieldKey} settingKey={key} stored={stored} />;
    if (setting.type === 'object') {
      return (
        <AdminStringListSettingField
          key={fieldKey}
          index={index}
          setting={setting}
          storedValue={stored ?? setting.defaultValue}
        />
      );
    }
    return (
      <AdminSettingInputField
        key={fieldKey}
        index={index}
        setting={setting}
        defaultValue={stored ?? setting.defaultValue}
      />
    );
  };

  // Same rule as the general Settings page: a dependent setting shows only while its parent is on.
  const isVisible = (key: SettingKey) => {
    const parent = (settingsMap[key] as { dependsOn?: SettingKey }).dependsOn;
    if (!parent) return true;
    const stored = storedByKey.get(parent);
    return stored !== undefined ? String(stored) === 'true' : settingsMap[parent].defaultValue === true;
  };

  const renderCard = (group: keyof typeof MODEL_SETTINGS_GROUP_KEYS, keys: readonly SettingKey[]) => (
    <SettingsSection sx={{ mb: 0 }} data-testid={`models-settings-${group}-fields`}>
      <Stack gap={2}>{keys.filter(isVisible).map(renderField)}</Stack>
    </SettingsSection>
  );

  return (
    <SettingsDraftProvider isLeaving={leavesModelSettings}>
      <Stack gap={3} data-testid="models-settings">
        {blocked && (
          <Alert
            color="neutral"
            variant="soft"
            startDecorator={<LockOutlinedIcon />}
            data-testid="models-settings-blocked"
          >
            {blocked}
          </Alert>
        )}
        {/* A disabled fieldset disables every native control inside it, so a blocked admin sees the values but cannot stage an edit. */}
        <Stack
          component="fieldset"
          disabled={Boolean(blocked)}
          inert={blocked ? true : undefined}
          gap={3}
          sx={{ border: 0, p: 0, m: 0, minWidth: 0 }}
        >
          <Group
            id="discovery"
            title="Discovery"
            description="How the scheduled provider check finds new models and what it does with them."
          >
            {renderCard('discovery', MODEL_SETTINGS_GROUP_KEYS.discovery)}
          </Group>

          <Group
            id="defaults"
            title="Defaults"
            description="The models used when no model is chosen, the ones pinned in the picker, and the ones behind background work."
          >
            {renderCard('defaults', ['DefaultAPIModel'])}
            <AdminRecommendedModelsSetting />
            <AdminOperationsModelSetting />
          </Group>

          <Group id="free-tier" title="Free tier" description="Which models accounts without a paid plan may call.">
            {renderCard('freeTier', MODEL_SETTINGS_GROUP_KEYS.freeTier)}
          </Group>

          <Group id="generation" title="Generation" description="Which video and music models users can start.">
            <AdminGenerationModelsSetting />
          </Group>
        </Stack>
      </Stack>
    </SettingsDraftProvider>
  );
}
