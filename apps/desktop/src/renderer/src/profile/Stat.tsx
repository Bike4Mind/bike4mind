import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';

export function Stat({
  label,
  value,
  caption,
  testId,
}: {
  label: string;
  value: string;
  caption?: string;
  testId?: string;
}) {
  return (
    <Stack sx={{ flex: 1, minWidth: 110 }} data-testid={testId}>
      <Typography level="body-xs" textColor="text.tertiary" noWrap>
        {label}
      </Typography>
      <Typography level="title-md" noWrap>
        {value}
      </Typography>
      {caption && (
        <Typography level="body-xs" textColor="text.tertiary" noWrap>
          {caption}
        </Typography>
      )}
    </Stack>
  );
}
