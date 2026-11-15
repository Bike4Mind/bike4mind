import { FC, useState } from 'react';
import { Avatar, AvatarProps } from '@mui/joy';
import { IOrganizationDocument } from '@bike4mind/common';
import { useGetAppFileUrl } from '@client/app/utils/s3';

type OrganizationAvatarProps = {
  organization: Pick<IOrganizationDocument, 'name' | 'logo'>;
} & Omit<AvatarProps, 'src' | 'alt' | 'children'>;

/** The team's logo, or its initial when it has none or the image fails to load. */
const OrganizationAvatar: FC<OrganizationAvatarProps> = ({ organization, ...avatarProps }) => {
  const getAppFileUrl = useGetAppFileUrl();
  const logoPath = organization.logo?.path;
  // Keyed by path: a new upload lands at a new path, so it gets a fresh attempt.
  const [failedPath, setFailedPath] = useState<string | null>(null);

  const src = logoPath && logoPath !== failedPath ? getAppFileUrl({ key: logoPath }) : undefined;

  return (
    <Avatar
      {...avatarProps}
      src={src}
      alt={src ? `${organization.name} logo` : undefined}
      slotProps={{ img: { onError: () => setFailedPath(logoPath ?? null) } }}
      data-testid="organization-avatar"
    >
      {organization.name.charAt(0).toUpperCase()}
    </Avatar>
  );
};

export default OrganizationAvatar;
