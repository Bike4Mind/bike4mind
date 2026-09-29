import { Typography } from '@mui/joy';

/**
 * What a Drive connection can read, shown next to every control that leads to Google's consent
 * screen. The grant is `drive.readonly` (server/integrations/google/drive/common.ts), which covers
 * the connecting account's whole Drive: `drive.file` would only cover items picked in the Picker,
 * and picking a folder does not grant the files inside it. Ingest itself is confined to the folder
 * (the full walk starts there and the changes feed is filtered by isUnderRoot), so the honest
 * narrowing advice is about WHICH account connects.
 */
export default function DriveAccessDisclosure() {
  return (
    <Typography level="body-xs" data-testid="drive-access-disclosure" sx={{ color: 'text.tertiary', maxWidth: 360 }}>
      Connecting grants read access to the whole Google Drive of the account you sign in with. Only the folder you pick
      is ingested. For the tightest setup, connect with an account that can see only that folder.
    </Typography>
  );
}
