import { Button } from '@mui/joy';

/** The Models page's "Run discovery" header action: the same Run now as the Discovery section. Placeholder. */
export function RunDiscoveryButton({ 'data-testid': testId }: { 'data-testid'?: string }) {
  return (
    <Button size="sm" variant="outlined" color="neutral" disabled data-testid={testId}>
      Run discovery
    </Button>
  );
}
