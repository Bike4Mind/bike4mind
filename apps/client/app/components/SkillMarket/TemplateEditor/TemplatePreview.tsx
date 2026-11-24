import { FC } from 'react';
import { AspectRatio, Box, Button, Card, Chip, Stack, Typography } from '@mui/joy';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import { SKILL_TEMPLATE_IMAGE_HEIGHT, SKILL_TEMPLATE_IMAGE_WIDTH, type ISkillTemplateInput } from '@bike4mind/common';

type Props = {
  skillName: string;
  headline: string;
  inputs: ISkillTemplateInput[];
  examplePrompt: string;
  imageUrl: string | null;
};

/** How the public template page will look, drawn from the unsaved form. */
const TemplatePreview: FC<Props> = ({ skillName, headline, inputs, examplePrompt, imageUrl }) => {
  const labelled = inputs.filter(input => input.label.trim());
  return (
    <Card variant="outlined" sx={{ gap: 1.5 }} data-testid="template-preview">
      <Chip size="sm" variant="soft" color="primary" sx={{ alignSelf: 'flex-start' }}>
        Skill template: /{skillName}
      </Chip>
      <Typography level="h3" data-testid="template-preview-headline">
        {headline.trim() || 'Your headline'}
      </Typography>
      {labelled.length ? (
        <Box>
          <Typography level="title-sm" sx={{ mb: 0.75 }}>
            You bring
          </Typography>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {labelled.map((input, i) => (
              <Chip
                key={`${input.label}-${i}`}
                size="md"
                variant={input.required ? 'solid' : 'outlined'}
                sx={input.required ? undefined : { borderStyle: 'dashed' }}
                data-testid="template-preview-input-chip"
                data-required={input.required ? 'true' : 'false'}
              >
                {input.required ? input.label.trim() : `${input.label.trim()} (optional)`}
              </Chip>
            ))}
          </Stack>
        </Box>
      ) : null}
      <AspectRatio
        ratio={`${SKILL_TEMPLATE_IMAGE_WIDTH}/${SKILL_TEMPLATE_IMAGE_HEIGHT}`}
        variant="soft"
        sx={{ borderRadius: 'sm' }}
      >
        {imageUrl ? (
          <img src={imageUrl} alt="Template preview" data-testid="template-preview-image" />
        ) : (
          <Stack alignItems="center" justifyContent="center" spacing={0.5} data-testid="template-preview-no-image">
            <ImageOutlinedIcon />
            <Typography level="body-xs" textColor="text.tertiary">
              {SKILL_TEMPLATE_IMAGE_WIDTH} x {SKILL_TEMPLATE_IMAGE_HEIGHT} preview image
            </Typography>
          </Stack>
        )}
      </AspectRatio>
      {examplePrompt.trim() ? (
        <Box>
          <Typography level="title-sm" sx={{ mb: 0.5 }}>
            Example
          </Typography>
          <Typography
            level="body-sm"
            sx={{ whiteSpace: 'pre-wrap', fontFamily: 'code' }}
            data-testid="template-preview-example"
          >
            {examplePrompt.trim()}
          </Typography>
        </Box>
      ) : null}
      <Button disabled sx={{ alignSelf: 'flex-start' }} data-testid="template-preview-try-btn">
        Try with Bike4Mind
      </Button>
    </Card>
  );
};

export default TemplatePreview;
