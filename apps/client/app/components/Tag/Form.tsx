import { ITag } from '@bike4mind/common';
import { colorPalettes, emojis, shades } from '@client/app/constants/tools';
import { zodResolver } from '@hookform/resolvers/zod';
import { Casino } from '@mui/icons-material';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import ColorLensIcon from '@mui/icons-material/ColorLens';
import EmojiEmotionsIcon from '@mui/icons-material/EmojiEmotions';
import TagIcon from '@mui/icons-material/Tag';
import { Box, Button, FormControl, FormLabel, IconButton, Input, Typography } from '@mui/joy';
import colors from '@mui/joy/colors';
import { FC, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import ColorPicker from '../common/fields/ColorPicker';
import EmojiPicker from '../common/fields/EmojiPicker';
import { z } from 'zod';

const getRandomEmoji = () => {
  const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
  return randomEmoji;
};

const getRandomColor = () => {
  const palette = colorPalettes[Math.floor(Math.random() * colorPalettes.length)];
  const shade = shades[Math.floor(Math.random() * shades.length)];
  return colors[palette.key][shade];
};

const getRandomInspirationItem = (count: number = 4) => {
  return Array.from({ length: count }, () => ({
    icon: getRandomEmoji(),
    color: getRandomColor(),
  }));
};

const getInspirationItems = () => getRandomInspirationItem();

const textStyles = {
  color: 'fileBrowser.createTag.secondaryText',
  fontSize: '14px',
  fontWeight: '400',
};

const tagSchema = z.object({
  icon: z.string().min(1, 'Icon is required'),
  name: z.string().min(1, 'Name is required').max(50, 'Name must be less than 50 characters'),
  color: z
    .string()
    .min(1, 'Color is required')
    .regex(/^#[0-9A-F]{6}$/i, 'Must be a valid hex color'),
});

type TagFormValues = z.infer<typeof tagSchema>;

const TagForm: FC<{
  data?: ITag;
  submitting?: boolean;
  onSubmit: (data: TagFormValues) => void;
}> = ({ data, submitting, onSubmit }) => {
  const [inspirationItems, setInspirationItems] = useState(() => getInspirationItems());

  // Pre-select a random inspiration item if creating a new tag
  const initialInspiration = !data ? inspirationItems[0] : null;

  const {
    control,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<TagFormValues>({
    // any: Zod v4 schema type is incompatible with @hookform/resolvers v5 Zod v3 overload signature
    resolver: zodResolver(tagSchema as any),
    defaultValues: {
      icon: data?.icon || initialInspiration?.icon || '',
      name: data?.name || '',
      color: data?.color || initialInspiration?.color || '',
    },
  });

  const handleInspirationClick = (item: (typeof inspirationItems)[0]) => {
    setValue('icon', item.icon);
    setValue('color', item.color);
  };

  const refreshInspirationItems = () => {
    setInspirationItems(getInspirationItems());
  };

  return (
    <Box
      component="form"
      onSubmit={handleSubmit(onSubmit)}
      display="flex"
      flexDirection="column"
      alignItems="center"
      width="100%"
      sx={{
        maxWidth: '440px',
        margin: '0 auto',
        overflow: 'hidden',
      }}
    >
      {/* Compact Preview */}
      <Box
        display="flex"
        flexDirection="row"
        gap="16px"
        alignItems="center"
        justifyContent="flex-start"
        sx={{
          borderRadius: '8px',
          width: '100%',
          maxWidth: '360px',
          height: '60px',
          margin: '12px 0px',
          padding: '12px',
          backgroundColor: 'fileBrowser.createTag.previewBackgroundColor',
          border: '1px solid',
          borderColor: 'fileBrowser.createTag.previewBorderColor',
        }}
      >
        {/* Icon */}
        <Box
          display="flex"
          alignItems="center"
          justifyContent="center"
          sx={{
            width: '32px',
            height: '32px',
            backgroundColor: watch('color') || colors.blue[500],
            borderRadius: '4px',
            flexShrink: 0,
          }}
        >
          <Box sx={{ fontSize: '18px' }}>{watch('icon') || '📁'}</Box>
        </Box>

        {/* Name */}
        <Box display="flex" flexDirection="column" sx={{ minWidth: 0, flex: 1 }}>
          <Typography
            sx={{
              fontWeight: '500',
              fontSize: '14px',
              color: 'text.primary',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {watch('name') || 'Tag Name'}
          </Typography>
          <Typography
            level="body-xs"
            sx={{
              color: 'fileBrowser.createTag.previewTextSecondaryColor',
              fontWeight: '400',
              fontSize: '11px',
            }}
          >
            📁 0 files
          </Typography>
        </Box>
      </Box>

      {/* Single Column Form */}
      <Box display="flex" flexDirection="column" gap="16px" sx={{ marginTop: '8px', width: '100%', maxWidth: '360px' }}>
        {/* Tag Name */}
        <Controller
          name="name"
          control={control}
          render={({ field }) => (
            <FormControl error={!!errors.name}>
              <FormLabel sx={textStyles}>
                <TagIcon
                  sx={{
                    width: '16px',
                    height: '16px',
                    marginRight: '6px',
                    color: 'fileBrowser.createTag.iconColor',
                  }}
                />
                Tag Name
              </FormLabel>
              <Input
                {...field}
                placeholder="Enter a tag name and press Enter"
                autoFocus
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (!submitting) {
                      handleSubmit(onSubmit)();
                    }
                  }
                }}
                sx={{
                  borderRadius: '10px',
                  width: '100%',
                  height: '40px',
                  marginTop: '4px',
                  backgroundColor: 'fileBrowser.createTag.backgroundColor',
                }}
                slotProps={{
                  input: {
                    sx: {
                      '&::placeholder': {
                        ...textStyles,
                      },
                    },
                  },
                }}
              />
              {errors.name && <FormLabel sx={{ color: 'danger.500' }}>{errors.name.message}</FormLabel>}
            </FormControl>
          )}
        />
        {/* Icon and Color Row */}
        <Box display="flex" flexDirection="row" gap="12px">
          <Controller
            name="icon"
            control={control}
            render={({ field }) => (
              <FormControl error={!!errors.icon}>
                <FormLabel sx={textStyles}>
                  <EmojiEmotionsIcon
                    sx={{
                      width: '16px',
                      height: '16px',
                      marginRight: '6px',
                      color: 'fileBrowser.createTag.iconColor',
                    }}
                  />
                  Icon
                </FormLabel>
                <EmojiPicker {...field} />
                {errors.icon && <FormLabel sx={{ color: 'danger.500' }}>{errors.icon.message}</FormLabel>}
              </FormControl>
            )}
          />
          <Controller
            name="color"
            control={control}
            render={({ field }) => (
              <FormControl error={!!errors.color}>
                <FormLabel sx={textStyles}>
                  <ColorLensIcon
                    sx={{
                      width: '16px',
                      height: '16px',
                      marginRight: '6px',
                      color: 'fileBrowser.createTag.iconColor',
                    }}
                  />
                  Color
                </FormLabel>
                <ColorPicker {...field} />
                {errors.color && <FormLabel sx={{ color: 'danger.500' }}>{errors.color.message}</FormLabel>}
              </FormControl>
            )}
          />
        </Box>

        {/* Compact Inspiration Section */}
        <Box display="flex" flexDirection="column" gap="8px">
          <Box display="flex" alignItems="center" justifyContent="space-between">
            <FormLabel sx={textStyles}>
              <AutoFixHighIcon
                sx={{
                  width: '16px',
                  height: '16px',
                  marginRight: '6px',
                  color: 'fileBrowser.createTag.iconColor',
                }}
              />
              Quick Ideas
            </FormLabel>
            <IconButton
              onClick={refreshInspirationItems}
              variant="outlined"
              size="sm"
              sx={{
                width: '24px',
                height: '24px',
                minWidth: '24px',
                minHeight: '24px',
                borderRadius: '6px',
                p: '0px',
                border: '1px solid',
                borderColor: 'border.solid',
              }}
            >
              <Casino sx={{ width: '14px', height: '14px', color: 'text.primary' }} />
            </IconButton>
          </Box>

          {/* Compact Inspiration Grid */}
          <Box
            display="grid"
            gridTemplateColumns="repeat(4, 1fr)"
            gap="6px"
            sx={{
              width: '100%',
              border: '1px solid',
              borderColor: 'border.solid',
              borderRadius: '8px',
              backgroundColor: 'fileBrowser.createTag.backgroundColor',
              padding: '8px',
            }}
          >
            {inspirationItems.map((item, index) => {
              const isSelected = watch('icon') === item.icon && watch('color') === item.color;
              return (
                <Box
                  key={index}
                  sx={{
                    borderRadius: '6px',
                    backgroundColor: isSelected ? `${item.color}26` : 'background.level1',
                    border: isSelected ? `2px solid ${item.color}` : '1px solid transparent',
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                    '&:hover': {
                      backgroundColor: `${item.color}26`,
                      border: `1px solid ${item.color}`,
                    },
                    width: '50px',
                    height: '50px',
                    padding: '8px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  onClick={() => handleInspirationClick(item)}
                >
                  <Box
                    sx={{
                      width: '32px',
                      height: '32px',
                      borderRadius: '4px',
                      backgroundColor: item.color,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '14px',
                    }}
                  >
                    {item.icon}
                  </Box>
                </Box>
              );
            })}
          </Box>
        </Box>
      </Box>

      {/* Submit Button */}
      <Box display="flex" justifyContent="center" alignItems="center" gap="12px" sx={{ margin: '20px 0px 16px 0px' }}>
        <Button
          type="submit"
          loading={submitting}
          size="lg"
          sx={{
            px: 6,
            width: '200px',
            height: '40px',
            fontSize: '16px',
            fontWeight: '600',
          }}
        >
          {data ? 'Update Tag' : 'Create Tag'}
        </Button>
        <Typography level="body-xs" sx={{ color: 'text.secondary', fontStyle: 'italic' }}>
          Press Enter to create quickly
        </Typography>
      </Box>
    </Box>
  );
};

export default TagForm;
