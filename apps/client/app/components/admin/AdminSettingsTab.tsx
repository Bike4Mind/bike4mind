import { useSettingsFromServer } from '@client/app/hooks/data/settings';
import { settingsMap, SETTING_TABS, API_SERVICE_GROUPS, Category, CATEGORY_ICONS } from '@bike4mind/common';
import {
  Checkbox,
  FormControl,
  Input,
  LinearProgress,
  Sheet,
  Stack,
  Typography,
  Tabs,
  TabList,
  Tab,
  TabPanel,
  Card,
  CardContent,
  CardOverflow,
  Divider,
  SvgIcon,
  Theme,
  Box,
  type SvgIconProps,
  Button,
  FormLabel,
  Tooltip,
} from '@mui/joy';
import React, { useCallback, useMemo, useState } from 'react';
import AdminSettingInputField from './AdminSettingInputField';
import { AdminOperationsModelSetting } from './AdminOperationsModelSetting';

import AdminLogoUpload from './AdminLogoUpload';
import { keyframes } from '@mui/system';
import { McpServerName } from '@bike4mind/common';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';

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
// inspects. Derived from settingsMap so it stays in sync if those fields change.
type SearchableSetting = Pick<
  (typeof settingsMap)[keyof typeof settingsMap],
  'key' | 'name' | 'description' | 'isSensitive'
>;

const spin = keyframes`
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
`;

const bounce = keyframes`
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-5px); }
`;

const sparkle = keyframes`
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(1.2); }
`;

const shake = keyframes`
  0%, 100% { transform: rotate(0deg); }
  25% { transform: rotate(-5deg); }
  75% { transform: rotate(5deg); }
`;

const rainbow = keyframes`
  0% { color: #ff0000; }
  17% { color: #ff8000; }
  33% { color: #ffff00; }
  50% { color: #00ff00; }
  67% { color: #0000ff; }
  83% { color: #8000ff; }
  100% { color: #ff0000; }
`;

const pulse = keyframes`
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.1); }
`;

const rain = keyframes`
  0% { 
    opacity: 0;
    transform: translateY(-100%);
  }
  50% { opacity: 1; }
  100% { 
    opacity: 0;
    transform: translateY(100%);
  }
`;

const snow = keyframes`
  0% {
    opacity: 0;
    transform: translate(-20px, -100%) rotate(0deg);
  }
  50% { opacity: 0.8; }
  100% {
    opacity: 0;
    transform: translate(20px, 100%) rotate(360deg);
  }
`;

const sunshine = keyframes`
  0% { 
    transform: scale(1) rotate(0deg);
    box-shadow: 0 0 0 0 rgba(255, 191, 0, 0.7);
  }
  50% { 
    transform: scale(1.2) rotate(180deg);
    box-shadow: 0 0 20px 10px rgba(255, 191, 0, 0.3);
  }
  100% { 
    transform: scale(1) rotate(360deg);
    box-shadow: 0 0 0 0 rgba(255, 191, 0, 0.7);
  }
`;

const doubleRainbow = keyframes`
  0% { 
    filter: drop-shadow(0 0 2px #ff0000)
           drop-shadow(0 0 2px #ff8000)
           drop-shadow(0 0 2px #ffff00)
           drop-shadow(0 0 2px #00ff00)
           drop-shadow(0 0 2px #0000ff);
    transform: scale(1);
  }
  50% { 
    filter: drop-shadow(0 0 8px #ff0000)
           drop-shadow(0 0 8px #ff8000)
           drop-shadow(0 0 8px #ffff00)
           drop-shadow(0 0 8px #00ff00)
           drop-shadow(0 0 8px #0000ff);
    transform: scale(1.1);
  }
  100% { 
    filter: drop-shadow(0 0 2px #ff0000)
           drop-shadow(0 0 2px #ff8000)
           drop-shadow(0 0 2px #ffff00)
           drop-shadow(0 0 2px #00ff00)
           drop-shadow(0 0 2px #0000ff);
    transform: scale(1);
  }
`;

const gentleTilt = keyframes`
  0% { transform: rotate(0deg); }
  25% { transform: rotate(1deg); }
  75% { transform: rotate(-1deg); }
  100% { transform: rotate(0deg); }
`;

const gentleFloat = keyframes`
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-2px); }
`;

const createWeatherParticles = (count: number) => {
  const styles: Record<string, any> = {};
  for (let i = 0; i < count; i++) {
    const delay = Math.random() * 2;
    const leftPos = Math.random() * 100;
    styles[`&:before:nth-of-type(${i + 1})`] = {
      left: `${leftPos}%`,
      animationDelay: `${delay}s`,
    };
  }
  return styles;
};

const getRandomWeatherEffect = () => {
  const effects = [
    {
      // Rain effect
      '&:before': {
        content: '""',
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        pointerEvents: 'none',
        background: 'linear-gradient(180deg, transparent, #4dabf5)',
        animation: `${rain} 1s linear infinite`,
        ...createWeatherParticles(10),
      },
    },
    {
      // Snow effect
      '&:before': {
        content: '""',
        position: 'absolute',
        width: '5px',
        height: '5px',
        borderRadius: '50%',
        background: 'white',
        boxShadow: '0 0 5px white',
        animation: `${snow} 3s ease-in-out infinite`,
        ...createWeatherParticles(15),
      },
    },
    {
      // Sunshine effect
      '&:before': {
        content: '""',
        position: 'absolute',
        top: '50%',
        left: '50%',
        width: '30px',
        height: '30px',
        borderRadius: '50%',
        background: '#ffbf00',
        transform: 'translate(-50%, -50%)',
        animation: `${sunshine} 4s ease infinite`,
      },
    },
    {
      // Rainbow effect
      '&:before': {
        content: '""',
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        animation: `${doubleRainbow} 2s ease infinite`,
        background:
          'linear-gradient(180deg, rgba(255,0,0,0.2), rgba(255,165,0,0.2), rgba(255,255,0,0.2), rgba(0,128,0,0.2), rgba(0,0,255,0.2), rgba(75,0,130,0.2), rgba(238,130,238,0.2))',
        borderRadius: 'inherit',
      },
    },
  ] as const;

  return effects[Math.floor(Math.random() * effects.length)];
};

// Wrapper for MUI icons that adds hover animations
const JoyIcon = (IconComponent: React.ComponentType<any>) => {
  const shouldHaveWeatherEffect = IconComponent === WbSunnyIcon;
  const WrappedIcon: React.FC<{ sx?: SvgIconProps['sx'] }> = ({ sx, ...props }) => {
    const weatherEffect = React.useMemo(
      () => (shouldHaveWeatherEffect ? getRandomWeatherEffect() : undefined),
      [] // No dependencies needed since shouldHaveWeatherEffect is constant
    );

    return (
      <SvgIcon
        component={IconComponent}
        sx={{
          transition: 'all 0.3s ease',
          '&:hover': {
            ...(IconComponent === AutoAwesomeIcon && {
              animation: `${sparkle} 1s ease infinite`,
              color: 'warning.400',
            }),
            ...(IconComponent === ScienceIcon && {
              animation: `${bounce} 0.5s ease infinite`,
              color: 'success.400',
            }),
            ...(IconComponent === SettingsIcon && {
              animation: `${spin} 2s linear infinite`,
              color: 'primary.400',
            }),
            ...(IconComponent === PsychologyIcon && {
              transform: 'scale(1.2)',
              color: 'warning.400',
            }),
            ...(IconComponent === SmartToyIcon && {
              animation: `${bounce} 1s ease infinite`,
              color: 'success.400',
            }),
            ...(IconComponent === SecurityIcon && {
              animation: `${pulse} 1s ease infinite`,
              color: 'success.400',
              filter: 'drop-shadow(0 0 5px currentColor)',
            }),
            ...(IconComponent === PaletteIcon && {
              animation: `${rainbow} 3s linear infinite`,
            }),
            ...(IconComponent === HandymanIcon && {
              animation: `${shake} 0.5s ease infinite`,
              color: 'warning.400',
            }),
            ...(IconComponent === ForumIcon && {
              transform: 'scale(1.2) rotate(15deg)',
              color: 'primary.400',
            }),
            ...(IconComponent === CalendarMonthIcon && {
              animation: `${gentleFloat} 2s ease-in-out infinite`,
              color: 'primary.400',
              filter: 'drop-shadow(0 0 2px currentColor)',
            }),
            ...(IconComponent === WbSunnyIcon && weatherEffect),
          },
          ...sx,
        }}
        {...props}
      />
    );
  };
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
};

const settingConfigs = Object.values(settingsMap);

interface EnvVariable {
  key: string;
  value: string;
}

interface McpServerFormData {
  name: McpServerName;
  envVariables: EnvVariable[];
  enabled: boolean;
}

const McpServerForm = () => {
  const [formData, setFormData] = useState<McpServerFormData>({
    name: '' as McpServerName,
    envVariables: [{ key: '', value: '' }],
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const response = await fetch('/api/mcp-servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to save MCP server');
      }

      const result = await response.json();
      console.log('Server saved:', result);

      setFormData({
        name: '' as McpServerName,
        envVariables: [{ key: '', value: '' }],
        enabled: true,
      });
    } catch (error) {
      console.error('Error saving MCP server:', error);
    }
  };

  return (
    <Card variant="outlined">
      <CardContent>
        <form onSubmit={handleSubmit}>
          <Stack spacing={2}>
            <Typography level="h4">MCP Server Configuration</Typography>

            <FormControl>
              <FormLabel>Server Name</FormLabel>
              <Input
                value={formData.name}
                onChange={e => setFormData(prev => ({ ...prev, name: e.target.value as McpServerName }))}
                required
              />
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

            <Button type="submit" color="primary">
              Create Server
            </Button>
          </Stack>
        </form>
      </CardContent>
    </Card>
  );
};

const AdminSettingsTab: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [allTabs, setAllTabs] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<string>(Object.keys(SETTING_TABS)[0]);
  const settingsFromServer = useSettingsFromServer();

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

  const filteredSettings = useMemo(() => {
    return settingConfigs.filter(settingConfig => {
      const settingInfo = settingsMap[settingConfig.key];

      if (!settingInfo) return false;

      // Hide settings that have dedicated custom UI in other admin tabs
      if (
        [
          'logoSettings',
          'RapidReplySettings',
          'SystemFiles',
          // What's New settings are managed in the What's New Modals tab
          'whatsNewAutomationEnabled',
          'whatsNewConfig',
          'whatsNewSyncConfig',
          // SRE Agent config has its own dedicated admin tab
          'sreAgentConfig',
          // Context Telemetry settings are managed in the Context Inspector tab
          'EnableContextTelemetry',
          'contextTelemetryAlerts',
          // SecOps Triage config has its own dedicated SecOps Triage tab
          'secopsTriageConfig',
          // Overwatch rollup sync is an internal cron-lock document, not user-configurable
          'overwatchRollupSync',
        ].includes(settingConfig.key)
      )
        return false;

      // Hide child settings when their parent setting is off
      if (settingInfo.dependsOn) {
        const parentValue = settingValueByName.get(settingInfo.dependsOn);
        const parentDefault = settingsMap[settingInfo.dependsOn as keyof typeof settingsMap]?.defaultValue;
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
          const settingInfo = settingsMap[setting.key];
          return settingInfo?.category && tabInfo.categories.includes(settingInfo.category);
        });
        return acc;
      },
      {} as Record<string, typeof settingConfigs>
    );

    // Then within each tab, group by category and group
    const grouped = Object.entries(tabGroups).reduce(
      (tabAcc, [tabId, tabSettings]) => {
        const categorized = tabSettings.reduce(
          (categoryAcc, setting) => {
            const settingInfo = settingsMap[setting.key];
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
              ungrouped: typeof settingConfigs;
              groups: Record<string, typeof settingConfigs>;
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
            ungrouped: typeof settingConfigs;
            groups: Record<string, typeof settingConfigs>;
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

  const renderSettingGroup = (settings: typeof settingConfigs, groupName?: string, groupId?: string) => {
    const groupInfo = groupId ? Object.values(API_SERVICE_GROUPS).find(g => g.id === groupId) : null;
    // Fall back to the Settings gear for a missing OR unmapped icon name so an
    // unknown key never renders <undefined /> and crashes the tree.
    const IconComponent = (groupInfo?.icon && IconMap[groupInfo.icon]) || IconMap.Settings;

    // Split settings into top-level entries and inline children.
    // A setting is an inline child when:
    //   1. It has a dependsOn that points to another setting IN this group
    //   2. It is a boolean type
    const settingKeysInGroup = new Set(settings.map(s => s.key));
    const inlineChildrenByParent = new Map<string, typeof settingConfigs>();
    const topLevelSettings: typeof settingConfigs = [];

    for (const s of settings) {
      const meta = settingsMap[s.key];
      const dep = meta.dependsOn;
      if (dep && settingKeysInGroup.has(dep) && meta.type === 'boolean') {
        // Resolve to a top-level parent: if dep is itself a child in this group
        // (its own dependsOn also points into the group), re-parent this grandchild
        // to the grandparent so the one-level subSettings render includes it.
        // Single-hop only - it resolves a grandchild (current max nesting), not a
        // 4+ level chain; a deeper chain would need a walk-to-root loop here.
        const parentMeta = settingsMap[dep as keyof typeof settingsMap];
        const grandparentDep = parentMeta?.dependsOn;
        const resolvedParent = grandparentDep && settingKeysInGroup.has(grandparentDep) ? grandparentDep : dep;
        const children = inlineChildrenByParent.get(resolvedParent) ?? [];
        children.push(s);
        inlineChildrenByParent.set(resolvedParent, children);
      } else {
        topLevelSettings.push(s);
      }
    }

    const cardHoverEffects = {
      ...(groupId === 'experimentalService' && {
        '&:hover': {
          transform: 'rotate(-1deg)',
          transition: 'transform 0.3s ease',
          animation: `${rainbow} 5s linear infinite`,
          borderColor: 'warning.400',
        },
      }),
      ...(groupId === 'openAIService' && {
        '&:hover': {
          boxShadow: (theme: Theme) => `0 0 15px ${theme.vars.palette.primary[200]}`,
          transition: 'all 0.3s ease',
          transform: 'translateY(-2px)',
        },
      }),
      ...(groupId === 'anthropicAPIService' && {
        '&:hover': {
          transform: 'scale(1.01)',
          transition: 'all 0.3s ease',
          animation: `${pulse} 2s ease infinite`,
        },
      }),
      ...(groupId === 'weatherAPIService' && {
        position: 'relative',
        overflow: 'hidden',
        '&:hover': {
          transform: 'translateY(-2px)',
          transition: 'all 0.3s ease',
          '& .weather-effect': {
            opacity: 1,
          },
        },
      }),
      ...(groupId === 'searchAPIService' && {
        '&:hover': {
          animation: `${bounce} 1s ease infinite`,
          boxShadow: (theme: Theme) => `0 0 10px ${theme.vars.palette.warning[200]}`,
        },
      }),
      ...(groupId === 'calendarAPIService' && {
        '&:hover': {
          animation: `${gentleTilt} 3s ease-in-out infinite`,
          boxShadow: (theme: Theme) => `0 0 8px ${theme.vars.palette.primary[200]}`,
          transition: 'all 0.5s ease',
        },
      }),
    };

    return (
      <Card
        key={groupId || 'ungrouped'}
        variant="outlined"
        sx={{
          mb: 2,
          ...cardHoverEffects,
          transition: 'all 0.3s ease',
        }}
      >
        {groupId === 'weatherAPIService' && (
          <Box
            className="weather-effect"
            sx={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              opacity: 0,
              transition: 'opacity 0.3s ease',
              pointerEvents: 'none',
              ...getRandomWeatherEffect(),
            }}
          />
        )}
        {groupName && (
          <CardOverflow>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              alignItems={{ xs: 'flex-start', sm: 'center' }}
              spacing={1}
              sx={{ p: 2 }}
            >
              <Stack direction="row" alignItems="center" spacing={1}>
                <IconComponent />
                <Typography
                  level="title-lg"
                  sx={{
                    ...(groupId === 'experimentalService' && {
                      '&:hover': {
                        color: 'warning.400',
                        transition: 'color 0.3s ease',
                        cursor: 'default',
                      },
                    }),
                  }}
                >
                  {groupName}
                </Typography>
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
          </CardOverflow>
        )}
        <CardContent>
          <Stack spacing={1}>
            {topLevelSettings.map((setting, index) => {
              const children = inlineChildrenByParent.get(setting.key);
              const subSettings = children?.map(child => ({
                setting: child,
                defaultValue: settingValueByName.get(child.key) ?? child.defaultValue,
              }));
              return (
                <AdminSettingInputField
                  key={`${setting.key}-${groupId || 'ungrouped'}-${setting.name}-${index}`}
                  index={index}
                  setting={setting}
                  defaultValue={settingValueByName.get(setting.key) ?? setting.defaultValue}
                  subSettings={subSettings}
                />
              );
            })}
          </Stack>
        </CardContent>
      </Card>
    );
  };

  const renderCategory = (
    category: string,
    data: { ungrouped: typeof settingConfigs; groups: Record<string, typeof settingConfigs> }
  ) => {
    const { ungrouped, groups } = data;
    const CategoryIconComponent = IconMap[CATEGORY_ICONS[category as keyof typeof CATEGORY_ICONS]] || IconMap.Settings;
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

        {/* Logo Upload for the Branding category - shown when there's no
            search or the search matches the logoSettings definition */}
        {category === 'Branding' && (!searchTerm || logoMatchesSearch) && <AdminLogoUpload />}

        {/* Render grouped settings */}
        {Object.entries(groups).map(([groupId, groupSettings]) => {
          const groupInfo = Object.values(API_SERVICE_GROUPS).find(g => g.id === groupId);
          return renderSettingGroup(
            groupSettings.sort((a, b) => (settingsMap[a.key].order || 0) - (settingsMap[b.key].order || 0)),
            groupInfo?.name || groupId,
            groupId
          );
        })}

        {/* Render ungrouped settings */}
        {ungrouped.length > 0 && renderSettingGroup(ungrouped, undefined, `ungrouped-${category}`)}
      </Stack>
    );
  };

  const renderMcpContent = () => {
    if (activeTab !== 'MCP') return null;

    return (
      <Stack spacing={2}>
        <Typography level="h2" color="primary">
          MCP Servers
        </Typography>
        <McpServerForm />
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
              <Typography level="h4">Admin Settings</Typography>
              <ContextHelpButton helpId="admin/admin-settings" tooltipText="Admin Settings Help" />
            </Stack>
            <FormControl sx={{ width: { xs: '100%', md: '40vw' } }}>
              <Input
                placeholder="Search by name, description, or non-sensitive value"
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                fullWidth
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

          {allTabs ? (
            <Stack
              spacing={3}
              sx={{ overflowY: 'auto', height: `calc(100vh - ${HEADER_HEIGHT} - 100px)`, p: '1rem' }}
              data-testid="admin-settings-all-tabs-results"
            >
              {Object.entries(groupedSettings).flatMap(([tabId, tabCategories]) =>
                tabId === 'MCP'
                  ? []
                  : Object.entries(tabCategories).map(([category, data]) => renderCategory(category, data))
              )}
            </Stack>
          ) : (
            <Tabs
              value={activeTab}
              onChange={(_, value) => setActiveTab(value as string)}
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
                  const TabIcon = IconMap[tabInfo.icon] || IconMap.Settings;
                  return (
                    <Tab
                      key={tabId}
                      value={tabId}
                      variant={activeTab === tabId ? 'soft' : 'plain'}
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
                    {tabId === 'MCP'
                      ? renderMcpContent()
                      : Object.entries(tabCategories).map(([category, data]) => renderCategory(category, data))}
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

export default AdminSettingsTab;
