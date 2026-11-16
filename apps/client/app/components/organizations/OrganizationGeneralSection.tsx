import { ChangeEvent, FC, useRef, useState } from 'react';
import {
  Box,
  Button,
  Card,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Stack,
  Textarea,
  Typography,
} from '@mui/joy';
import CloudUploadOutlinedIcon from '@mui/icons-material/CloudUploadOutlined';
import { IOrganizationDocument, isAllowedImageMimeType, WithId } from '@bike4mind/common';
import Compressor from 'compressorjs';
import { toast } from 'sonner';
import { z } from 'zod';
import { useUpdateOrganization, useUploadOrganizationLogo } from '@client/app/hooks/data/organizations';
import { useUser } from '@client/app/contexts/UserContext';
import { hasOrgUpdateAccess } from '@client/app/utils/orgAccessGate';
import OrganizationAvatar from './OrganizationAvatar';

export const MAX_TEAM_NAME_LENGTH = 100;
export const MAX_TEAM_DESCRIPTION_LENGTH = 500;
const LOGO_MAX_DIMENSION_PX = 256;

const emailSchema = z.string().email();

const compressLogo = (file: File): Promise<File | Blob> =>
  new Promise((resolve, reject) => {
    new Compressor(file, {
      quality: 0.85,
      maxWidth: LOGO_MAX_DIMENSION_PX,
      maxHeight: LOGO_MAX_DIMENSION_PX,
      success: resolve,
      error: reject,
    });
  });

/**
 * Team name, description, logo and billing contact. The fields follow their server gates:
 * - name and description: `canEditProfile`, the Settings section's mirror of organizationService.update's
 *   update access. Settings also opens to managers without it (for sharing), so they see these read-only;
 * - logo: owner, manager or platform admin (upload-logo.ts, `managePolicies`);
 * - billing contact: owner or platform admin. update.ts ignores it from a manager, and
 *   toSafeOrganization strips it from everyone else, so nobody else could see what they edit.
 */
const OrganizationGeneralSection: FC<{ organization: WithId<IOrganizationDocument>; canEditProfile: boolean }> = ({
  organization,
  canEditProfile,
}) => {
  const { currentUser } = useUser();
  const updateOrganization = useUpdateOrganization();
  const uploadLogo = useUploadOrganizationLogo();
  const profileDisabled = !canEditProfile || updateOrganization.isPending;
  const logoInputRef = useRef<HTMLInputElement | null>(null);

  const canEditLogo = hasOrgUpdateAccess(currentUser, organization);
  const canEditBillingContact =
    !!currentUser && (currentUser.isAdmin === true || currentUser.id === organization.userId);

  const savedName = organization.name ?? '';
  const savedDescription = organization.description ?? '';
  const savedBillingContact = organization.billingContact ?? '';

  // A null draft shows the saved value, so an untouched field follows refetches and a save.
  const [nameDraft, setName] = useState<string | null>(null);
  const [descriptionDraft, setDescription] = useState<string | null>(null);
  const [billingContactDraft, setBillingContact] = useState<string | null>(null);
  const name = nameDraft ?? savedName;
  const description = descriptionDraft ?? savedDescription;
  const billingContact = billingContactDraft ?? savedBillingContact;

  const trimmedName = name.trim();
  const trimmedDescription = description.trim();
  const trimmedBillingContact = billingContact.trim();

  const nameError = trimmedName ? null : 'The team needs a name.';
  const billingContactError =
    canEditBillingContact && !emailSchema.safeParse(trimmedBillingContact).success
      ? 'Enter an email address for billing notices.'
      : null;

  const changes: Partial<Pick<IOrganizationDocument, 'name' | 'description' | 'billingContact'>> = {};
  if (trimmedName !== savedName) changes.name = trimmedName;
  if (trimmedDescription !== savedDescription) changes.description = trimmedDescription;
  if (canEditBillingContact && trimmedBillingContact !== savedBillingContact) {
    changes.billingContact = trimmedBillingContact;
  }
  const hasChanges = Object.keys(changes).length > 0;
  // A legacy billing contact that is not an email only blocks a save that touches it.
  const blocked = !!nameError || (changes.billingContact !== undefined && !!billingContactError);

  const handleSave = async () => {
    if (profileDisabled || !hasChanges || blocked) return;
    try {
      await updateOrganization.mutateAsync({ orgId: organization.id, data: changes });
      handleReset();
    } catch {
      // useUpdateOrganization already toasted the reason; the edits stay in the form for a retry.
    }
  };

  const handleReset = () => {
    setName(null);
    setDescription(null);
    setBillingContact(null);
  };

  const handleLogoChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (logoInputRef.current) logoInputRef.current.value = '';
    if (!file) return;
    if (!isAllowedImageMimeType(file.type)) {
      toast.error('Choose a PNG, JPEG, GIF, WebP or AVIF image.');
      return;
    }
    let compressed: File | Blob;
    try {
      compressed = await compressLogo(file);
    } catch {
      toast.error('Could not read that image. Try another file.');
      return;
    }
    try {
      await uploadLogo.mutateAsync({
        organizationId: organization.id,
        // The presign binds ContentType, and compression can change it (png -> jpeg), so declare
        // the compressed bytes. Same as the admin panel's upload.
        fileInfo: { fileName: file.name, mimeType: compressed.type || file.type, fileSize: compressed.size },
        file: compressed,
      });
    } catch {
      // useUploadOrganizationLogo already toasted the reason.
    }
  };

  return (
    <Card variant="outlined" data-testid="organization-general-section">
      <Typography level="title-sm" sx={{ p: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
        General
      </Typography>
      <Stack spacing={2} sx={{ p: 2 }}>
        <Stack direction="row" spacing={2} alignItems="center">
          <OrganizationAvatar organization={organization} sx={{ '--Avatar-size': '56px' }} />
          {canEditLogo ? (
            <Stack spacing={0.5}>
              <Box>
                <Button
                  component="label"
                  variant="outlined"
                  color="neutral"
                  size="sm"
                  startDecorator={<CloudUploadOutlinedIcon />}
                  loading={uploadLogo.isPending}
                  data-testid="organization-general-logo-btn"
                >
                  {organization.logo ? 'Replace logo' : 'Upload logo'}
                  <input
                    hidden
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
                    ref={logoInputRef}
                    onChange={handleLogoChange}
                    data-testid="organization-general-logo-input"
                  />
                </Button>
              </Box>
              <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                Square images look best. Shown to everyone on the team.
              </Typography>
            </Stack>
          ) : (
            <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
              Only the owner or a manager can change the logo.
            </Typography>
          )}
        </Stack>

        <FormControl error={!!nameError} disabled={profileDisabled}>
          <FormLabel>Team name</FormLabel>
          <Input
            value={name}
            disabled={profileDisabled}
            onChange={e => setName(e.target.value)}
            slotProps={{ input: { maxLength: MAX_TEAM_NAME_LENGTH, 'data-testid': 'organization-general-name-input' } }}
          />
          {nameError && <FormHelperText>{nameError}</FormHelperText>}
        </FormControl>

        <FormControl disabled={profileDisabled}>
          <FormLabel>Description</FormLabel>
          <Textarea
            value={description}
            disabled={profileDisabled}
            onChange={e => setDescription(e.target.value)}
            minRows={2}
            maxRows={6}
            placeholder="What this team works on"
            slotProps={{
              textarea: {
                maxLength: MAX_TEAM_DESCRIPTION_LENGTH,
                'data-testid': 'organization-general-description-input',
              },
            }}
          />
          <FormHelperText>Shown under the team name at the top of this page.</FormHelperText>
        </FormControl>

        {canEditBillingContact && (
          <FormControl
            error={changes.billingContact !== undefined && !!billingContactError}
            disabled={updateOrganization.isPending}
          >
            <FormLabel>Billing contact</FormLabel>
            <Input
              type="email"
              disabled={updateOrganization.isPending}
              value={billingContact}
              onChange={e => setBillingContact(e.target.value)}
              placeholder="billing@example.com"
              slotProps={{ input: { 'data-testid': 'organization-general-billing-contact-input' } }}
            />
            <FormHelperText>
              {changes.billingContact !== undefined && billingContactError
                ? billingContactError
                : 'The email address for invoices and payment notices. Only the owner sees and edits it.'}
            </FormHelperText>
          </FormControl>
        )}

        {!canEditProfile ? (
          <Typography level="body-xs" sx={{ color: 'text.tertiary' }} data-testid="organization-general-read-only-note">
            Only the owner or someone with edit access can change the team name and description.
          </Typography>
        ) : (
          <Stack direction="row" spacing={1}>
            <Button
              onClick={handleSave}
              loading={updateOrganization.isPending}
              disabled={!hasChanges || blocked}
              data-testid="organization-general-save-btn"
            >
              Save changes
            </Button>
            {hasChanges && (
              <Button
                variant="plain"
                color="neutral"
                onClick={handleReset}
                disabled={updateOrganization.isPending}
                data-testid="organization-general-reset-btn"
              >
                Discard
              </Button>
            )}
          </Stack>
        )}
      </Stack>
    </Card>
  );
};

export default OrganizationGeneralSection;
