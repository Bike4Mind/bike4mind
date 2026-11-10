import { Stack, Typography } from '@mui/joy';
import type { SettingKey } from '@bike4mind/common';
import { SettingsSection } from '../../shared';
import { SettingKeyRow } from './SettingKeyRow';

export type SettingBlock = { id: string; title: string; description: string; keys: readonly SettingKey[] };

export const SectionHeading = ({ title, description }: { title: string; description: string }) => (
  <Stack sx={{ gap: 0.5, mb: 2 }}>
    <Typography level="title-md" component="h2" sx={{ color: 'admin.ink' }}>
      {title}
    </Typography>
    <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
      {description}
    </Typography>
  </Stack>
);

/** One section per block, each holding a SettingKeyRow per key. Render inside a SettingsDraftProvider. */
export function SettingBlocks({
  blocks,
  storedByKey,
  testIdPrefix,
  derived,
}: {
  blocks: readonly SettingBlock[];
  storedByKey: ReadonlyMap<string, unknown>;
  testIdPrefix: string;
  derived?: (key: SettingKey, stored: unknown) => string | null;
}) {
  return (
    <Stack gap={2}>
      {blocks.map(block => (
        <SettingsSection
          key={block.id}
          component="section"
          sx={{ mb: 0 }}
          data-testid={`${testIdPrefix}-block-${block.id}`}
        >
          <SectionHeading title={block.title} description={block.description} />
          <Stack sx={{ gap: 1 }}>
            {block.keys.map((key, index) => {
              const stored = storedByKey.get(key);
              return (
                <SettingKeyRow
                  key={key}
                  settingKey={key}
                  stored={stored}
                  index={index}
                  testIdPrefix={testIdPrefix}
                  derived={derived?.(key, stored)}
                />
              );
            })}
          </Stack>
        </SettingsSection>
      ))}
    </Stack>
  );
}
