import { Grid, Card, CardContent, Typography } from '@mui/joy';
import { SubscriptionStats } from '../types';

interface SubscriptionStatsCardsProps {
  stats: SubscriptionStats;
  isLoading?: boolean;
}

const SubscriptionStatsCards = ({ stats }: SubscriptionStatsCardsProps) => {
  return (
    <Grid container spacing={2} sx={{ mb: 4 }}>
      <Grid xs={6} sm={6} md={3}>
        <Card variant="outlined">
          <CardContent sx={{ p: { xs: 1.5, sm: 2 } }}>
            <Typography level="h4">{stats.total || 0}</Typography>
            <Typography level="body-sm">Total Subscriptions</Typography>
          </CardContent>
        </Card>
      </Grid>
      <Grid xs={6} sm={6} md={3}>
        <Card variant="outlined">
          <CardContent sx={{ p: { xs: 1.5, sm: 2 } }}>
            <Typography level="h4">{stats.active || 0}</Typography>
            <Typography level="body-sm">Active Subscriptions</Typography>
          </CardContent>
        </Card>
      </Grid>
      <Grid xs={6} sm={6} md={3}>
        <Card variant="outlined">
          <CardContent sx={{ p: { xs: 1.5, sm: 2 } }}>
            <Typography level="h4">{stats.expiringThisMonth || 0}</Typography>
            <Typography level="body-sm">Expiring This Month</Typography>
          </CardContent>
        </Card>
      </Grid>
      <Grid xs={6} sm={6} md={3}>
        <Card variant="outlined">
          <CardContent sx={{ p: { xs: 1.5, sm: 2 } }}>
            <Typography level="h4">{stats.canceled || 0}</Typography>
            <Typography level="body-sm">Canceled Subscriptions</Typography>
          </CardContent>
        </Card>
      </Grid>
    </Grid>
  );
};

export default SubscriptionStatsCards;
