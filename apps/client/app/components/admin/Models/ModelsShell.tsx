import { Stack } from '@mui/joy';
import { useNavigate, useSearch } from '@tanstack/react-router';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import type { AdminSearch } from '../adminTabParams';
import { AdminPageHeader, ViewTabs } from '../shared';
import { ADMIN_REGION_GAP } from '../shared/adminStyles';
import { DiscoverySection } from './Discovery/DiscoverySection';
import { RunDiscoveryButton } from './Discovery/RunDiscoveryButton';
import { ModelListSection } from './List/ModelListSection';
import { ModelPricesSection } from './Prices/ModelPricesSection';
import { ModelSettingsSection } from './Settings/ModelSettingsSection';
import {
  DEFAULT_MODELS_SECTION,
  MODELS_SECTION_PARAM,
  MODELS_TAB_PARAMS,
  parseModelsSection,
  type ModelsSection,
} from './modelsSearch';

const SECTION_LABELS: Record<ModelsSection, string> = {
  list: 'Models',
  prices: 'Prices',
  discovery: 'Discovery',
  settings: 'Settings',
};

const VIEWS = (Object.keys(SECTION_LABELS) as ModelsSection[]).map(id => ({ id, label: SECTION_LABELS[id] }));

/**
 * Admin > AI > Models: the one place for the models users can pick. The section lives in the URL as
 * `modelsSection`; switching drops the previous section's params.
 */
export function ModelsShell() {
  const search = useSearch({ strict: false }) as AdminSearch;
  const navigate = useNavigate();
  const section = parseModelsSection(search[MODELS_SECTION_PARAM]);

  // Not the admin tab store: the URL sync would treat it as a tab switch and rebuild the search without this param.
  const selectSection = (id: string) => {
    const next = parseModelsSection(id);
    return navigate({
      to: '/admin',
      search: (previous: AdminSearch) => ({
        ...previous,
        ...Object.fromEntries(MODELS_TAB_PARAMS.map(key => [key, undefined])),
        [MODELS_SECTION_PARAM]: next === DEFAULT_MODELS_SECTION ? undefined : next,
      }),
      replace: true,
    });
  };

  return (
    <Stack gap={ADMIN_REGION_GAP} data-testid="models-shell">
      <AdminPageHeader
        title="Models"
        description="Models users can pick, why the others are hidden, and what each one costs."
        actions={
          <Stack direction="row" gap={1} alignItems="center">
            <ContextHelpButton helpId="admin/models" tooltipText="Models help" />
            <RunDiscoveryButton data-testid="models-run-discovery-btn" />
          </Stack>
        }
      />
      <ViewTabs
        views={VIEWS}
        activeId={section}
        onSelect={selectSection}
        aria-label="Models sections"
        data-testid="models-sections"
      />
      <div data-testid={`models-section-${section}`}>
        {section === 'list' ? (
          <ModelListSection />
        ) : section === 'prices' ? (
          <ModelPricesSection />
        ) : section === 'discovery' ? (
          <DiscoverySection />
        ) : (
          <ModelSettingsSection />
        )}
      </div>
    </Stack>
  );
}

export default ModelsShell;
