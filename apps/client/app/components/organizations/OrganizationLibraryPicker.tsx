import { useState } from 'react';
import { Alert, Button, Option, Select, Stack, Typography } from '@mui/joy';
import type { OrganizationLibraryKind } from '@bike4mind/common';
import { useOrganizationLibrary, useReuseLibraryItem } from '@client/app/hooks/data/organizationLibrary';
import { getErrorMessage } from '@client/app/utils/error';

export default function OrganizationLibraryPicker({
  kind,
  organizationId,
}: {
  kind?: OrganizationLibraryKind;
  organizationId?: string;
}) {
  const { data: items = [], isError } = useOrganizationLibrary(kind, organizationId);
  const reuse = useReuseLibraryItem();
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <Stack spacing={1} data-testid="organization-library-picker">
      <Typography level="title-sm">Organization library</Typography>
      <Typography level="body-xs">
        Add a personal copy to your picker. The organization keeps the published original.
      </Typography>
      {isError && <Alert color="danger">Could not load the organization library.</Alert>}
      <Select
        value={selected}
        onChange={(_, value) => {
          setSelected(value);
          reuse.reset();
        }}
        placeholder="Choose a library item"
        data-testid="organization-library-picker-select"
      >
        {items.map(item => (
          <Option key={item.id} value={item.id}>
            {item.pinned ? 'Pinned: ' : ''}
            {item.name} ({item.kind})
          </Option>
        ))}
      </Select>
      <Button
        size="sm"
        disabled={!selected}
        loading={reuse.isPending}
        data-testid="organization-library-reuse-btn"
        onClick={() => selected && reuse.mutate(selected)}
      >
        Add to my picker
      </Button>
      {reuse.isSuccess && <Alert color="success">Added to your picker.</Alert>}
      {reuse.isError && <Alert color="danger">{getErrorMessage(reuse.error)}</Alert>}
    </Stack>
  );
}
