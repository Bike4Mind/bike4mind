import { useSettingsFromServer } from '@client/app/hooks/data/settings';
import {
  isBlankSettingValue,
  allSettingDefinitions,
  resolveSettingDefinition,
  settingsMap,
  SETTING_TABS,
  type SettingDefinition,
  API_SERVICE_GROUPS,
  Category,
  CATEGORY_ICONS,
  type SettingKey,
} from '@bike4mind/common';
import { EmbeddingProviderLimits } from './EmbeddingProviderLimits';
import { useAdminSettingsSearchParams, type SettingSectionKey } from './useAdminSettingsSearchParams';
import {
  Checkbox,
  FormControl,
  Input,
  LinearProgress,
  Link,
  Sheet,
  Stack,
  Typography,
  Tabs,
  TabList,
  Tab,
  TabPanel,
  Box,
  Divider,
  SvgIcon,
  type SvgIconProps,
  Tooltip,
} from '@mui/joy';
import React, { useCallback, useMemo, useState, type ComponentProps } from 'react';
import AdminSettingInputField from './AdminSettingInputField';
import AdminStringListSettingField from './AdminStringListSettingField';
import { AdminOperationsModelSetting } from './AdminOperationsModelSetting';
import { AdminTurnstileStatusNotice } from './AdminTurnstileStatusNotice';
import { AdminGenerationModelsSetting } from './AdminGenerationModelsSetting';
import { AdminRecommendedModelsSetting } from './AdminRecommendedModelsSetting';
import { ScopedOverridesByScope } from './ScopedOverridesByScope';
import { AdminTab } from './adminSidebarConfig';
import { useAdminModal } from './useAdminModal';

import AdminLogoUpload from './AdminLogoUpload';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { SettingsDraftProvider } from './SettingsDraftProvider';
import { AdminPageHeader, SettingsSection } from './shared';

import SmartToyIcon from '@mui/icons-material/SmartToy';
import PsychologyIcon from '@mui/icons-material/Psychology';
import AssistantIcon from '@mui/icons-material/Assistant';
import WbSunnyIcon from '@mui/icons-material/WbSunny';
import SearchIcon from '@mui/icons-material/Search';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import FeedbackIcon from '@mui/icons-material/Feedback';
import SettingsIcon from '@mui/icons-material/Settings';
import ScienceIcon from '@mui/icons-material/Science';
import BookIcon from '@mui/icons-material/Book';
import GroupIcon from '@mui/icons-material/Group';
import PaymentsIcon from '@mui/icons-material/Payments';
import StorageIcon from '@mui/icons-material/Storage';
import BrushIcon from '@mui/icons-material/Brush';
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings';
import AppRegistrationIcon from '@mui/icons-material/AppRegistration';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import SavingsIcon from '@mui/icons-material/Savings';
import ExtensionIcon from '@mui/icons-material/Extension';
import WidgetsIcon from '@mui/icons-material/Widgets';
import SecurityIcon from '@mui/icons-material/Security';
import ManageAccountsIcon from '@mui/icons-material/ManageAccounts';
import ForumIcon from '@mui/icons-material/Forum';
import PaletteIcon from '@mui/icons-material/Palette';
import GavelIcon from '@mui/icons-material/Gavel';
import ShareIcon from '@mui/icons-material/Share';
import HandymanIcon from '@mui/icons-material/Handyman';
import ImageIcon from '@mui/icons-material/Image';
import ChatIcon from '@mui/icons-material/Chat';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import NightsStayIcon from '@mui/icons-material/NightsStay';
import SpeedIcon from '@mui/icons-material/Speed';

const HEADER_HEIGHT = '100px';

// Minimal searchable shape - the subset of a real setting definition that search
// inspects. Derived from the definition type so it stays in sync if those fields change.
type SearchableSetting = Pick<SettingDefinition<string>, 'key' | 'name' | 'description' | 'isSensitive'>;

// Wrapper mapping a MUI icon component into the plain section-header icon that
// IconMap exposes. Kept as a thin indirection so IconMap and its completeness
// test keep working.
const JoyIcon = (IconComponent: React.ComponentType<any>) => {
  const WrappedIcon: React.FC<{ sx?: SvgIconProps['sx'] }> = ({ sx, ...props }) => (
    <SvgIcon component={IconComponent} sx={sx} {...props} />
  );
  WrappedIcon.displayName = `JoyIcon(${IconComponent.displayName || 'Unknown'})`;
  return WrappedIcon;
};

type IconMapType = {
  [K: string]: React.FC<{ sx?: SvgIconProps['sx'] }>;
};

// Exported for the icon-completeness test that guards against unmapped config
// icon names (an unmapped name renders <undefined /> and crashes admin settings).
export const IconMap: IconMapType = {
  SmartToy: JoyIcon(SmartToyIcon),
  Psychology: JoyIcon(PsychologyIcon),
  Assistant: JoyIcon(AssistantIcon),
  WbSunny: JoyIcon(WbSunnyIcon),
  Search: JoyIcon(SearchIcon),
  CalendarMonth: JoyIcon(CalendarMonthIcon),
  Feedback: JoyIcon(FeedbackIcon),
  Settings: JoyIcon(SettingsIcon),
  Science: JoyIcon(ScienceIcon),
  Book: JoyIcon(BookIcon),
  Group: JoyIcon(GroupIcon),
  Payments: JoyIcon(PaymentsIcon),
  Storage: JoyIcon(StorageIcon),
  Brush: JoyIcon(BrushIcon),
  AdminPanelSettings: JoyIcon(AdminPanelSettingsIcon),
  AppRegistration: JoyIcon(AppRegistrationIcon),
  Image: JoyIcon(ImageIcon),
  AutoAwesome: JoyIcon(AutoAwesomeIcon),
  Extension: JoyIcon(ExtensionIcon),
  Widgets: JoyIcon(WidgetsIcon),
  Security: JoyIcon(SecurityIcon),
  ManageAccounts: JoyIcon(ManageAccountsIcon),
  Forum: JoyIcon(ForumIcon),
  Palette: JoyIcon(PaletteIcon),
  Gavel: JoyIcon(GavelIcon),
  Share: JoyIcon(ShareIcon),
  Handyman: JoyIcon(HandymanIcon),
  Chat: JoyIcon(ChatIcon),
  PictureAsPdf: JoyIcon(PictureAsPdfIcon),
  NightsStay: JoyIcon(NightsStayIcon),
  Speed: JoyIcon(SpeedIcon),
  Savings: JoyIcon(SavingsIcon),
};

// Resolve a settings icon name to a component, falling back to the Settings gear
// for a missing OR unmapped name so an unknown key never renders <undefined /> and
// crashes the tree. Exported for direct unit tests of the fallback behavior.
export const resolveSettingsIcon = (icon: string | undefined): React.FC<{ sx?: SvgIconProps['sx'] }> =>
  (icon && IconMap[icon]) || IconMap.Settings;

type SettingConfig = SettingDefinition<string>;
// The field components are typed against the core catalog. A contributed definition has the same
// runtime shape, and the update route accepts its key once registered.
type CoreSettingConfig = (typeof settingsMap)[keyof typeof settingsMap];

// Edited only on the Growth and Pricing tab (GROWTH_PRICING_SECTIONS in AdminGrowthPricingTab); the
// Credits System group links there instead. ReferralCreditsAmount is on that tab too but keeps its
// Referrals editor here, so it is not listed.
export const GROWTH_PRICING_ONLY_KEYS: ReadonlySet<SettingKey> = new Set<SettingKey>([
  'allowOpenRegistration',
  'defaultFreeCredits',
  'enforceCredits',
  'pricePerCredit',
  'lowCreditsThreshold',
  'enableTeamPlan',
  'teamPlanMinSeats',
  'teamPlanMaxSeats',
  'teamPlanCreditsPerSeat',
  'ReferralFirstAnswerCredits',
  'ReferralFirstPaymentCredits',
  'ReferralSecondPaymentCredits',
  'ReferralHoldDays',
  'ReferralInvitesPerUser',
  'ReferralAlertRewardsPerDay',
]);

// Settings whose value is a list of plain strings get the one-entry-per-line editor.
const STRING_LIST_SETTING_KEYS = new Set<string>([
  'ImageModerationReviewerEmails',
  'blockedEmailDomains',
  'freeTierAllowedModels',
  'noCardUnlockPhoneBlockedPrefixes',
]);

const AdminSettingsTab: React.FC = () => {
  const { section, setSection, searchTerm, setSearchTerm } = useAdminSettingsSearchParams();
  const [allTabs, setAllTabs] = useState<boolean>(false);
  const settingsFromServer = useSettingsFromServer();
  const setAdminTab = useAdminModal(s => s.setActiveTab);

  // Index server values by setting name once, so the hot search/filter paths
  // don't re-scan the whole list per setting on every keystroke.
  const settingValueByName = useMemo(() => {
    const map = new Map<string, NonNullable<typeof settingsFromServer.data>[number]['settingValue']>();
    for (const s of settingsFromServer.data ?? []) map.set(s.settingName, s.settingValue);
    return map;
  }, [settingsFromServer.data]);

  // Returns true when EVERY whitespace-separated token in `searchTerm` appears in
  // the setting's name, description, key, or (non-sensitive) live value. Checking
  // all four fields matches the standard path to custom-rendered settings, and
  // tokenizing lets a query like "Liveops Webhooks" match "LiveOps Channel Webhook URL".
  const matchesSearch = useCallback(
    (setting: SearchableSetting, searchTerm: string): boolean => {
      const q = searchTerm.trim().toLowerCase();
      if (!q) return true;

      const settingValue = settingValueByName.get(setting.key);
      const haystack = [
        setting.name,
        setting.description,
        setting.key,
        // Don't match against sensitive values (API keys, secrets, webhook URLs).
        !setting.isSensitive && typeof settingValue === 'string' ? settingValue : undefined,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      // Every token must appear in the haystack. Tolerate a trailing plural "s"
      // (e.g. "webhooks" matches "webhook") so natural queries still resolve.
      return q.split(/\s+/).every(token => {
        if (haystack.includes(token)) return true;
        return token.length > 3 && token.endsWith('s') && haystack.includes(token.slice(0, -1));
      });
    },
    [settingValueByName]
  );

  // logoSettings is excluded from the generic list and rendered by <AdminLogoUpload />.
  // Computed once so the category injection and the render gate can't drift apart.
  const logoMatchesSearch = useMemo(
    () => !!searchTerm && matchesSearch(settingsMap.logoSettings, searchTerm),
    [searchTerm, matchesSearch]
  );

  // The Growth and Pricing keys have no editor here, so a search for one points to the tab instead.
  const growthPricingMatchesSearch = useMemo(
    () => !!searchTerm && [...GROWTH_PRICING_ONLY_KEYS].some(key => matchesSearch(settingsMap[key], searchTerm)),
    [searchTerm, matchesSearch]
  );

  const filteredSettings = useMemo(() => {
    return allSettingDefinitions().filter(settingConfig => {
      const settingInfo = resolveSettingDefinition(settingConfig.key);

      if (!settingInfo) return false;

      if ((GROWTH_PRICING_ONLY_KEYS as ReadonlySet<string>).has(settingConfig.key)) return false;

      // Hide settings that have dedicated custom UI in other admin tabs
      if (
        [
          'logoSettings',
          // Per-model video and music toggles are rendered by <AdminGenerationModelsSetting />
          'videoGeneration',
          'musicGeneration',
          // Ordered model list is rendered by <AdminRecommendedModelsSetting />
          'recommendedModelIds',
          'RapidReplySettings',
          'SystemFiles',
          // Release notes config is edited in the Release notes tab
          'releaseNotesConfig',
          // SRE Agent config has its own dedicated admin tab
          'sreAgentConfig',
          // Context Telemetry settings are managed in the Context Inspector tab
          'EnableContextTelemetry',
          'contextTelemetryAlerts',
          // SecOps Triage config has its own dedicated SecOps Triage tab
          'secopsTriageConfig',
          // Overwatch rollup sync is an internal cron-lock document, not user-configurable
          'overwatchRollupSync',
          // PR Status Digest settings are edited inline in the PR Status Digest tab
          'prReportRepo',
          'prReportIdentityMap',
          'prReportWebhookUrl',
          'prReportEgressAllowlist',
        ].includes(settingConfig.key)
      )
        return false;

      // Hide child settings when their parent setting is off
      if (settingInfo.dependsOn) {
        const parentValue = settingValueByName.get(settingInfo.dependsOn);
        const parentDefault = resolveSettingDefinition(settingInfo.dependsOn)?.defaultValue;
        const isParentOn = parentValue !== undefined ? String(parentValue) === 'true' : parentDefault === true;
        if (!isParentOn) return false;
      }

      const isBike4MindSetting = settingInfo?.app === 'bike4mind';

      // In tab-scoped mode, hide settings not applicable to the current theme.
      // "All Tabs" mode reveals everything (across all tabs and app scopes).
      if (!allTabs && settingInfo.app) {
        if (!isBike4MindSetting) return false;
      }

      if (searchTerm) {
        return matchesSearch(settingInfo, searchTerm);
      }

      return true;
    });
  }, [searchTerm, settingValueByName, allTabs, matchesSearch]);

  // Total settings matching the current search across ALL tabs - so the count is
  // visible even when the active tab happens to show none of them.
  const matchCount = filteredSettings.length + (logoMatchesSearch ? 1 : 0);

  const groupedSettings = useMemo(() => {
    // First group by tab
    const tabGroups = Object.entries(SETTING_TABS).reduce(
      (acc, [tabId, tabInfo]) => {
        acc[tabId] = filteredSettings.filter(setting => {
          const settingInfo = resolveSettingDefinition(setting.key);
          return settingInfo?.category && tabInfo.categories.includes(settingInfo.category);
        });
        return acc;
      },
      {} as Record<string, SettingConfig[]>
    );

    // Then within each tab, group by category and group
    const grouped = Object.entries(tabGroups).reduce(
      (tabAcc, [tabId, tabSettings]) => {
        const categorized = tabSettings.reduce(
          (categoryAcc, setting) => {
            const settingInfo = resolveSettingDefinition(setting.key);
            const category = settingInfo?.category ?? 'Uncategorized';

            if (!categoryAcc[category]) {
              categoryAcc[category] = {
                ungrouped: [],
                groups: {},
              };
            }

            if (settingInfo?.group) {
              if (!categoryAcc[category].groups[settingInfo.group]) {
                categoryAcc[category].groups[settingInfo.group] = [];
              }
              categoryAcc[category].groups[settingInfo.group].push(setting);
            } else {
              categoryAcc[category].ungrouped.push(setting);
            }

            return categoryAcc;
          },
          {} as Record<
            Category,
            {
              ungrouped: SettingConfig[];
              groups: Record<string, SettingConfig[]>;
            }
          >
        );

        tabAcc[tabId] = categorized;
        return tabAcc;
      },
      {} as Record<
        string,
        Record<
          Category,
          {
            ungrouped: SettingConfig[];
            groups: Record<string, SettingConfig[]>;
          }
        >
      >
    );

    // logoSettings is excluded from the standard list (it's rendered by
    // <AdminLogoUpload />), so a search matching it wouldn't otherwise surface the
    // Branding category. Inject that category here so the uploader stays findable.
    if (logoMatchesSearch) {
      const category = settingsMap.logoSettings.category as Category;
      const ownerTab = Object.entries(SETTING_TABS).find(([, tabInfo]) => tabInfo.categories.includes(category))?.[0];
      if (ownerTab) {
        if (!grouped[ownerTab]) grouped[ownerTab] = {} as (typeof grouped)[string];
        if (!grouped[ownerTab][category]) {
          grouped[ownerTab][category] = { ungrouped: [], groups: {} };
        }
      }
    }

    return grouped;
  }, [filteredSettings, logoMatchesSearch]);

  const renderSettingGroup = (settings: SettingConfig[], groupName?: string, groupId?: string) => {
    const groupInfo = groupId ? Object.values(API_SERVICE_GROUPS).find(g => g.id === groupId) : null;
    const IconComponent = resolveSettingsIcon(groupInfo?.icon);

    // Split settings into top-level entries and inline children.
    // A setting is an inline child when:
    //   1. It has a dependsOn that points to another setting IN this group
    //   2. It is a boolean type
    const settingKeysInGroup = new Set(settings.map(s => s.key));
    const inlineChildrenByParent = new Map<string, SettingConfig[]>();
    const topLevelSettings: SettingConfig[] = [];

    for (const s of settings) {
      const meta = resolveSettingDefinition(s.key);
      const dep = meta?.dependsOn;
      if (dep && settingKeysInGroup.has(dep) && meta?.type === 'boolean') {
        // Resolve to a top-level parent: if dep is itself a child in this group
        // (its own dependsOn also points into the group), re-parent this grandchild
        // to the grandparent so the one-level subSettings render includes it.
        // Single-hop only - it resolves a grandchild (current max nesting), not a
        // 4+ level chain; a deeper chain would need a walk-to-root loop here.
        const parentMeta = resolveSettingDefinition(dep);
        const grandparentDep = parentMeta?.dependsOn;
        const resolvedParent = grandparentDep && settingKeysInGroup.has(grandparentDep) ? grandparentDep : dep;
        const children = inlineChildrenByParent.get(resolvedParent) ?? [];
        children.push(s);
        inlineChildrenByParent.set(resolvedParent, children);
      } else {
        topLevelSettings.push(s);
      }
    }

    return (
      <SettingsSection key={groupId || 'ungrouped'}>
        {groupName && (
          <Box>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              alignItems={{ xs: 'flex-start', sm: 'center' }}
              spacing={1}
              sx={{ p: 2 }}
            >
              <Stack direction="row" alignItems="center" spacing={1}>
                <IconComponent />
                <Typography level="title-lg">{groupName}</Typography>
              </Stack>
              {groupInfo?.description && (
                <Typography
                  level="body-sm"
                  sx={{ color: 'text.secondary', ml: { xs: 0, sm: 'auto' }, mt: { xs: 0.5, sm: 0 } }}
                >
                  {groupInfo.description}
                </Typography>
              )}
            </Stack>
            <Divider inset="none" />
          </Box>
        )}
        <Box>
          <Stack spacing={1}>
            {topLevelSettings.map((setting, index) => {
              const children = inlineChildrenByParent.get(setting.key);
              const subSettings = children?.map(child => ({
                setting: child,
                defaultValue: settingValueByName.get(child.key) ?? child.defaultValue,
              }));
              // A string-list setting gets a one-entry-per-line editor; the React key is the stored
              // value so a save or refetch resets the draft. Keyed explicitly rather than by value
              // shape: any future object setting with an array default would otherwise get this
              // editor, and toStringList drops non-string entries.
              if (setting.type === 'object' && STRING_LIST_SETTING_KEYS.has(setting.key)) {
                const storedValue = settingValueByName.get(setting.key) ?? setting.defaultValue;
                return (
                  <AdminStringListSettingField
                    key={`${setting.key}-${JSON.stringify(storedValue)}`}
                    index={index}
                    setting={setting as CoreSettingConfig}
                    storedValue={storedValue}
                  />
                );
              }
              return (
                <AdminSettingInputField
                  key={`${setting.key}-${groupId || 'ungrouped'}-${setting.name}-${index}`}
                  index={index}
                  setting={setting as CoreSettingConfig}
                  // clearDeletesRow: no stored row (or a blank one, which the resolver also reads as unset)
                  // means unset, NOT the declared default - pass null so the field renders its unset label.
                  defaultValue={
                    setting.clearDeletesRow && isBlankSettingValue(settingValueByName.get(setting.key))
                      ? null
                      : (settingValueByName.get(setting.key) ?? setting.defaultValue)
                  }
                  subSettings={subSettings as ComponentProps<typeof AdminSettingInputField>['subSettings']}
                />
              );
            })}
          </Stack>

          {/* The measured counterpart to this group's throughput levers. Scoped to this group
              rather than the AI category: it only makes sense next to the numbers it advises on. */}
          {groupId === API_SERVICE_GROUPS.DATA_LAKE_COST.id && <EmbeddingProviderLimits />}

          {groupId === API_SERVICE_GROUPS.CREDITS.id && (
            <Typography level="body-sm" sx={{ color: 'text.secondary', mt: 1 }}>
              Signup, starter credits, credit pricing and team-plan limits are edited on{' '}
              <Link
                component="button"
                onClick={() => setAdminTab(AdminTab.GrowthPricing)}
                data-testid="admin-settings-credits-growth-pricing-link"
              >
                Growth and Pricing
              </Link>
              .
            </Typography>
          )}
        </Box>
      </SettingsSection>
    );
  };

  const renderCategory = (
    category: string,
    data: { ungrouped: SettingConfig[]; groups: Record<string, SettingConfig[]> }
  ) => {
    const { ungrouped, groups } = data;
    const CategoryIconComponent = resolveSettingsIcon(CATEGORY_ICONS[category as keyof typeof CATEGORY_ICONS]);
    return (
      <Stack key={`category-${category}`} spacing={2}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <CategoryIconComponent sx={{ '--Icon-fontSize': '24px', color: 'primary.500' }} />
          <Typography level="h2" color="primary">
            {category}
          </Typography>
        </Stack>

        {/* Operations Model component for the AI category */}
        {category === 'AI' && <AdminOperationsModelSetting />}

        {category === 'AI' && <AdminRecommendedModelsSetting />}

        {category === 'AI' && <AdminGenerationModelsSetting />}

        {category === 'Users' && (
          <AdminTurnstileStatusNotice enabled={String(settingValueByName.get('turnstileEnabled')) === 'true'} />
        )}

        {/* The by-scope read of the override overlay. Category-scoped rather than group-scoped:
            seven of the nine scope-capable settings are AI, and the panel lists all nine wherever
            it renders. */}
        {category === 'AI' && <ScopedOverridesByScope />}

        {/* Logo Upload for the Branding category - shown when there's no
            search or the search matches the logoSettings definition */}
        {category === 'Branding' && (!searchTerm || logoMatchesSearch) && <AdminLogoUpload />}

        {/* Render grouped settings */}
        {Object.entries(groups).map(([groupId, groupSettings]) => {
          const groupInfo = Object.values(API_SERVICE_GROUPS).find(g => g.id === groupId);
          return renderSettingGroup(
            groupSettings.sort(
              (a, b) => (resolveSettingDefinition(a.key)?.order || 0) - (resolveSettingDefinition(b.key)?.order || 0)
            ),
            groupInfo?.name || groupId,
            groupId
          );
        })}

        {/* Render ungrouped settings */}
        {ungrouped.length > 0 && renderSettingGroup(ungrouped, undefined, `ungrouped-${category}`)}
      </Stack>
    );
  };

  return (
    <Sheet sx={{ width: '100%' }}>
      {settingsFromServer.isLoading ? (
        <LinearProgress size={'lg'} sx={{ marginX: '5px', width: '100%' }} />
      ) : (
        <>
          <Stack
            spacing={2}
            direction={{ xs: 'column', md: 'row' }}
            alignItems={{ xs: 'stretch', md: 'center' }}
            sx={{
              p: '1rem',
              minHeight: { xs: 'auto', md: HEADER_HEIGHT },
              borderBottom: '1px dashed',
              borderColor: 'divider',
            }}
          >
            <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: { xs: 1, md: 0 } }}>
              <AdminPageHeader title="Settings" description="Edit configuration, then save or discard your changes." />
              <ContextHelpButton helpId="admin/admin-settings" tooltipText="Admin Settings Help" />
            </Stack>
            <FormControl sx={{ width: { xs: '100%', md: '40vw' } }}>
              <Input
                placeholder="Search by name, description, or non-sensitive value (/)"
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                fullWidth
                slotProps={{
                  input: {
                    'data-testid': 'admin-settings-search-input',
                    'data-admin-search': true,
                    'aria-label': 'Search settings',
                    'aria-keyshortcuts': '/',
                  },
                }}
              />
            </FormControl>
            {searchTerm && (
              <Typography
                level="body-sm"
                role="status"
                aria-live="polite"
                sx={{ whiteSpace: 'nowrap', color: 'text.secondary' }}
                data-testid="admin-settings-search-count"
              >
                {matchCount} result{matchCount === 1 ? '' : 's'}
              </Typography>
            )}
            <FormControl>
              <Tooltip title="Show matches from every tab in one list, including app-scoped settings" variant="soft">
                <Checkbox
                  checked={allTabs}
                  onChange={e => setAllTabs(e.target.checked)}
                  label="All Tabs"
                  data-testid="admin-settings-all-tabs-checkbox"
                />
              </Tooltip>
            </FormControl>
          </Stack>

          {growthPricingMatchesSearch && (
            <Typography
              level="body-sm"
              sx={{ px: '1rem', pt: 1 }}
              data-testid="admin-settings-search-growth-pricing-hint"
            >
              Signup, starter credits, credit pricing and team-plan limits are edited on{' '}
              <Link
                component="button"
                onClick={() => setAdminTab(AdminTab.GrowthPricing)}
                data-testid="admin-settings-search-growth-pricing-link"
              >
                Growth and Pricing
              </Link>
              .
            </Typography>
          )}

          {allTabs ? (
            <Stack
              spacing={3}
              sx={{ overflowY: 'auto', height: `calc(100vh - ${HEADER_HEIGHT} - 100px)`, p: '1rem' }}
              data-testid="admin-settings-all-tabs-results"
            >
              {Object.values(groupedSettings).flatMap(tabCategories =>
                Object.entries(tabCategories).map(([category, data]) => renderCategory(category, data))
              )}
            </Stack>
          ) : (
            <Tabs
              value={section}
              onChange={(_, value) => setSection(value as SettingSectionKey)}
              sx={{ bgcolor: 'background.body' }}
            >
              <TabList
                variant="plain"
                sx={{
                  '--List-padding': '0px',
                  '--List-radius': '0px',
                  '--ListItem-minHeight': '48px',
                  borderBottom: '1px solid',
                  borderColor: 'divider',
                  overflowX: 'auto',
                }}
              >
                {Object.entries(SETTING_TABS).map(([tabId, tabInfo]) => {
                  const TabIcon = resolveSettingsIcon(tabInfo.icon);
                  return (
                    <Tab
                      key={tabId}
                      value={tabId}
                      variant={section === tabId ? 'soft' : 'plain'}
                      data-testid={`admin-settings-section-tab-${tabInfo.id}`}
                      sx={{
                        borderRadius: 0,
                        minWidth: { xs: 'auto', md: 'unset' },
                        px: { xs: 2, md: 3 },
                      }}
                    >
                      <Stack direction="row" alignItems="center" spacing={1}>
                        <TabIcon sx={{ '--Icon-fontSize': '20px' }} />
                        <Typography sx={{ display: { xs: 'none', sm: 'block' } }}>{tabInfo.name}</Typography>
                      </Stack>
                    </Tab>
                  );
                })}
              </TabList>
              {Object.entries(groupedSettings).map(([tabId, tabCategories]) => (
                <TabPanel key={tabId} value={tabId}>
                  <Stack
                    spacing={2}
                    sx={{
                      overflowY: 'auto',
                      height: `calc(100vh - ${HEADER_HEIGHT} - 100px)`,
                      p: '1rem',
                    }}
                  >
                    {Object.entries(tabCategories).map(([category, data]) => renderCategory(category, data))}
                  </Stack>
                </TabPanel>
              ))}
            </Tabs>
          )}
        </>
      )}
    </Sheet>
  );
};

AdminSettingsTab.displayName = 'AdminSettingsTab';

export default function AdminSettingsPage() {
  return (
    <SettingsDraftProvider>
      <AdminSettingsTab />
    </SettingsDraftProvider>
  );
}
