import type { ComponentType } from 'react';
import { Box } from '@mui/joy';
import type { SvgIconComponent } from '@mui/icons-material';
import type { IntegrationLogoKey } from '@bike4mind/common';
import SiGoogledrive, { defaultColor as SiGoogledriveHex } from '@icons-pack/react-simple-icons/icons/SiGoogledrive';
import SiGithub, { defaultColor as SiGithubHex } from '@icons-pack/react-simple-icons/icons/SiGithub';
import SiAtlassian, { defaultColor as SiAtlassianHex } from '@icons-pack/react-simple-icons/icons/SiAtlassian';
import SiNotion, { defaultColor as SiNotionHex } from '@icons-pack/react-simple-icons/icons/SiNotion';
import SiSlack, { defaultColor as SiSlackHex } from '@icons-pack/react-simple-icons/icons/SiSlack';
import SiLinkedin, { defaultColor as SiLinkedinHex } from '@icons-pack/react-simple-icons/icons/SiLinkedin';
import SiJupyter, { defaultColor as SiJupyterHex } from '@icons-pack/react-simple-icons/icons/SiJupyter';
import SiGooglecalendar, {
  defaultColor as SiGooglecalendarHex,
} from '@icons-pack/react-simple-icons/icons/SiGooglecalendar';
import SiOkta, { defaultColor as SiOktaHex } from '@icons-pack/react-simple-icons/icons/SiOkta';
import SiHubspot, { defaultColor as SiHubspotHex } from '@icons-pack/react-simple-icons/icons/SiHubspot';
import SiSalesforce, { defaultColor as SiSalesforceHex } from '@icons-pack/react-simple-icons/icons/SiSalesforce';
import SiGmail, { defaultColor as SiGmailHex } from '@icons-pack/react-simple-icons/icons/SiGmail';
import SiDropbox, { defaultColor as SiDropboxHex } from '@icons-pack/react-simple-icons/icons/SiDropbox';
import SiBox, { defaultColor as SiBoxHex } from '@icons-pack/react-simple-icons/icons/SiBox';
import SiGoogledocs, { defaultColor as SiGoogledocsHex } from '@icons-pack/react-simple-icons/icons/SiGoogledocs';
import SiLinear, { defaultColor as SiLinearHex } from '@icons-pack/react-simple-icons/icons/SiLinear';
import SiAsana, { defaultColor as SiAsanaHex } from '@icons-pack/react-simple-icons/icons/SiAsana';
import SiTrello, { defaultColor as SiTrelloHex } from '@icons-pack/react-simple-icons/icons/SiTrello';
import SiDiscord, { defaultColor as SiDiscordHex } from '@icons-pack/react-simple-icons/icons/SiDiscord';
import SiTelegram, { defaultColor as SiTelegramHex } from '@icons-pack/react-simple-icons/icons/SiTelegram';
import SiAirtable, { defaultColor as SiAirtableHex } from '@icons-pack/react-simple-icons/icons/SiAirtable';
import SiZapier, { defaultColor as SiZapierHex } from '@icons-pack/react-simple-icons/icons/SiZapier';
import SiGitlab, { defaultColor as SiGitlabHex } from '@icons-pack/react-simple-icons/icons/SiGitlab';
import SiBitbucket, { defaultColor as SiBitbucketHex } from '@icons-pack/react-simple-icons/icons/SiBitbucket';
import SiOpenai, { defaultColor as SiOpenaiHex } from '@icons-pack/react-simple-icons/icons/SiOpenai';
import SiAnthropic, { defaultColor as SiAnthropicHex } from '@icons-pack/react-simple-icons/icons/SiAnthropic';
import SiGooglegemini, { defaultColor as SiGooglegeminiHex } from '@icons-pack/react-simple-icons/icons/SiGooglegemini';
import SiAmazonwebservices, {
  defaultColor as SiAmazonwebservicesHex,
} from '@icons-pack/react-simple-icons/icons/SiAmazonwebservices';
import SiOllama, { defaultColor as SiOllamaHex } from '@icons-pack/react-simple-icons/icons/SiOllama';
import SiElevenlabs, { defaultColor as SiElevenlabsHex } from '@icons-pack/react-simple-icons/icons/SiElevenlabs';
import MailOutlineIcon from '@mui/icons-material/MailOutline';
import ArticleOutlinedIcon from '@mui/icons-material/ArticleOutlined';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import TerminalOutlinedIcon from '@mui/icons-material/TerminalOutlined';
import { gray } from '@client/app/utils/themes/colors';

type BrandIcon = ComponentType<{ color?: string; size?: string | number; title?: string }>;

type LogoSpec =
  | { kind: 'brand'; Icon: BrandIcon; color: string }
  | { kind: 'glyph'; Icon: SvgIconComponent }
  | { kind: 'monogram'; text: string };

const brand = (Icon: BrandIcon, color: string): LogoSpec => ({ kind: 'brand', Icon, color });
const glyph = (Icon: SvgIconComponent): LogoSpec => ({ kind: 'glyph', Icon });
const monogram = (text: string): LogoSpec => ({ kind: 'monogram', text });

/**
 * Every logo key in @bike4mind/common's INTEGRATION_LOGO_KEYS, drawn. Brand marks are the
 * simple-icons the installed package ships; a brand it does not ship gets a neutral
 * monogram rather than an invented mark, and a generic feature gets a glyph.
 */
const LOGOS: Record<IntegrationLogoKey, LogoSpec> = {
  'google-drive': brand(SiGoogledrive, SiGoogledriveHex),
  github: brand(SiGithub, SiGithubHex),
  atlassian: brand(SiAtlassian, SiAtlassianHex),
  notion: brand(SiNotion, SiNotionHex),
  slack: brand(SiSlack, SiSlackHex),
  linkedin: brand(SiLinkedin, SiLinkedinHex),
  email: glyph(MailOutlineIcon),
  jupyter: brand(SiJupyter, SiJupyterHex),
  blog: glyph(ArticleOutlinedIcon),
  'history-import': glyph(HistoryOutlinedIcon),
  'google-calendar': brand(SiGooglecalendar, SiGooglecalendarHex),
  okta: brand(SiOkta, SiOktaHex),
  'claude-code': monogram('CC'),
  'mcp-cli': glyph(TerminalOutlinedIcon),
  'b4m-oauth': monogram('B4'),
  hubspot: brand(SiHubspot, SiHubspotHex),
  salesforce: brand(SiSalesforce, SiSalesforceHex),
  gmail: brand(SiGmail, SiGmailHex),
  outlook: monogram('Ou'),
  'onedrive-sharepoint': monogram('OD'),
  dropbox: brand(SiDropbox, SiDropboxHex),
  box: brand(SiBox, SiBoxHex),
  'google-docs-sheets': brand(SiGoogledocs, SiGoogledocsHex),
  linear: brand(SiLinear, SiLinearHex),
  asana: brand(SiAsana, SiAsanaHex),
  trello: brand(SiTrello, SiTrelloHex),
  'microsoft-teams': monogram('Tm'),
  discord: brand(SiDiscord, SiDiscordHex),
  telegram: brand(SiTelegram, SiTelegramHex),
  airtable: brand(SiAirtable, SiAirtableHex),
  zapier: brand(SiZapier, SiZapierHex),
  gitlab: brand(SiGitlab, SiGitlabHex),
  bitbucket: brand(SiBitbucket, SiBitbucketHex),
  openai: brand(SiOpenai, SiOpenaiHex),
  anthropic: brand(SiAnthropic, SiAnthropicHex),
  gemini: brand(SiGooglegemini, SiGooglegeminiHex),
  xai: monogram('xAI'),
  deepseek: monogram('DS'),
  kimi: monogram('Ki'),
  bedrock: brand(SiAmazonwebservices, SiAmazonwebservicesHex),
  ollama: brand(SiOllama, SiOllamaHex),
  flux: monogram('Fx'),
  veo: monogram('Ve'),
  lyria: monogram('Ly'),
  elevenlabs: brand(SiElevenlabs, SiElevenlabsHex),
};

/**
 * A brand's logo on a light tile. The tile stays light in dark mode too: several marks
 * (GitHub, Notion, Ollama) are near-black and would vanish on a dark surface.
 */
const IntegrationLogo = ({
  logo,
  size = 28,
  muted = false,
}: {
  logo: IntegrationLogoKey;
  size?: number;
  muted?: boolean;
}) => {
  const spec = LOGOS[logo];
  const mark = Math.round(size * 0.62);
  return (
    <Box
      aria-hidden
      data-testid={`integrations-logo-${logo}`}
      sx={{
        width: `${size}px`,
        height: `${size}px`,
        flexShrink: 0,
        display: 'grid',
        placeItems: 'center',
        borderRadius: `${Math.round(size / 4.5)}px`,
        backgroundColor: gray[12],
        color: gray[650],
        opacity: muted ? 0.6 : 1,
        overflow: 'hidden',
      }}
    >
      {spec.kind === 'brand' && <spec.Icon color={spec.color} size={mark} title="" />}
      {spec.kind === 'glyph' && <spec.Icon sx={{ fontSize: `${mark}px`, color: 'inherit' }} />}
      {spec.kind === 'monogram' && (
        <Box
          component="span"
          sx={{ fontWeight: 700, fontSize: `${Math.round(size * 0.38)}px`, letterSpacing: '-0.02em' }}
        >
          {spec.text}
        </Box>
      )}
    </Box>
  );
};

export default IntegrationLogo;
