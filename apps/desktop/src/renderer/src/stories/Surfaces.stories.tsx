import type { Story, StoryDefault } from './ladleTypes';
import Avatar from '@mui/joy/Avatar';
import Card from '@mui/joy/Card';
import Divider from '@mui/joy/Divider';
import List from '@mui/joy/List';
import ListDivider from '@mui/joy/ListDivider';
import ListItem from '@mui/joy/ListItem';
import ListItemButton from '@mui/joy/ListItemButton';
import ListItemContent from '@mui/joy/ListItemContent';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Tab from '@mui/joy/Tab';
import Table from '@mui/joy/Table';
import TabList from '@mui/joy/TabList';
import TabPanel from '@mui/joy/TabPanel';
import Tabs from '@mui/joy/Tabs';
import Typography from '@mui/joy/Typography';
import { COLORS, Row, Section, VARIANTS, VariantMatrix } from './matrix';

export default { title: 'Surfaces' } satisfies StoryDefault;

export const Sheets: Story = () => (
  <VariantMatrix
    render={(variant, color) => (
      <Sheet variant={variant} color={color} sx={{ p: 2, borderRadius: 'md' }}>
        Sheet
      </Sheet>
    )}
  />
);

export const Cards: Story = () => (
  <Row>
    {VARIANTS.map(variant => (
      <Card key={variant} variant={variant} sx={{ width: 220 }}>
        <Typography level="title-md" textColor="inherit">
          {variant} card
        </Typography>
        <Typography level="body-sm" textColor="inherit">
          Supporting text that describes the card.
        </Typography>
      </Card>
    ))}
  </Row>
);

export const Lists: Story = () => (
  <Row>
    {VARIANTS.map(variant => (
      <List key={variant} variant={variant} sx={{ width: 200, borderRadius: 'md', flexGrow: 0 }}>
        <ListItem>
          <ListItemButton selected>
            <ListItemContent>Selected</ListItemContent>
          </ListItemButton>
        </ListItem>
        <ListItem>
          <ListItemButton>
            <ListItemContent>{variant}</ListItemContent>
          </ListItemButton>
        </ListItem>
        <ListDivider />
        <ListItem>
          <ListItemButton disabled>
            <ListItemContent>Disabled</ListItemContent>
          </ListItemButton>
        </ListItem>
      </List>
    ))}
  </Row>
);

export const TabsAndDividers: Story = () => (
  <>
    <Section title="Tabs">
      <Tabs defaultValue={0} sx={{ width: 420, borderRadius: 'md' }}>
        <TabList>
          <Tab>First</Tab>
          <Tab>Second</Tab>
          <Tab disabled>Disabled</Tab>
        </TabList>
        <TabPanel value={0}>First panel</TabPanel>
        <TabPanel value={1}>Second panel</TabPanel>
      </Tabs>
    </Section>
    <Section title="Divider">
      <Stack spacing={2} sx={{ width: 420 }}>
        <Divider />
        <Divider>with text</Divider>
      </Stack>
    </Section>
  </>
);

export const Tables: Story = () => (
  <Sheet variant="outlined" sx={{ width: 480, borderRadius: 'md' }}>
    <Table hoverRow>
      <thead>
        <tr>
          <th>Name</th>
          <th>Status</th>
          <th>Updated</th>
        </tr>
      </thead>
      <tbody>
        {['Alpha', 'Beta', 'Gamma'].map(name => (
          <tr key={name}>
            <td>{name}</td>
            <td>Ready</td>
            <td>Today</td>
          </tr>
        ))}
      </tbody>
    </Table>
  </Sheet>
);

export const Avatars: Story = () => (
  <>
    <Section title="variant by color">
      <VariantMatrix
        render={(variant, color) => (
          <Avatar variant={variant} color={color}>
            AB
          </Avatar>
        )}
      />
    </Section>
    <Section title="default">
      <Row>
        {COLORS.map(color => (
          <Avatar key={color} color={color} />
        ))}
      </Row>
    </Section>
  </>
);
