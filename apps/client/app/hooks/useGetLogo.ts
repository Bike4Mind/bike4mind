import { useTheme } from '@mui/joy/styles';
import { useMemo } from 'react';
import { useLogoSettings, useConfig } from '@client/app/hooks/data/settings';

const useGetLogo = () => {
  const { data: logoSettings } = useLogoSettings();
  const { data: config } = useConfig();

  const theme = useTheme();
  const mode = theme.palette.mode;

  const cdnUrl = config?.cdnUrl || process.env.NEXT_PUBLIC_CDN_URL || '';

  const logoSrc = useMemo(() => {
    if (!logoSettings) return mode === 'dark' ? theme.branding.logo.dark : theme.branding.logo.light;

    const { customLogoUrl, customDarkLogoUrl, useBothLogos } = logoSettings;

    // Helper to construct the full URL, handling both old (full path) and new (filename only) formats
    const buildLogoUrl = (logoPath: string) => {
      if (!logoPath) return '';
      if (logoPath.startsWith('blob:') || /^https?:\/\//.test(logoPath)) return logoPath;
      // Strip legacy full-path prefix so both stored formats resolve to the same CDN path
      const filename = logoPath.startsWith('admin/logos/') ? logoPath.slice('admin/logos/'.length) : logoPath;
      return `${cdnUrl}/admin-logos/${filename}`;
    };

    if (useBothLogos) {
      return customLogoUrl ? buildLogoUrl(customLogoUrl) : theme.branding.logo.light;
    }
    if (mode === 'dark') {
      return customDarkLogoUrl ? buildLogoUrl(customDarkLogoUrl) : theme.branding.logo.dark;
    }
    return customLogoUrl ? buildLogoUrl(customLogoUrl) : theme.branding.logo.light;
  }, [logoSettings, mode, theme, cdnUrl]);

  return logoSrc;
};

export default useGetLogo;
