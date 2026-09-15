import React from 'react';
import { Box, Card, CardContent, Typography, Grid, Button, Chip } from '@mui/joy';
import { Security, Web, Code, VpnKey, CloudQueue, Shield, CheckCircle, WarningAmber } from '@mui/icons-material';
import { useSecurityDashboardOverview } from '@client/app/hooks/data/admin';
import { APP_NAME } from '@client/config/general'; // brand externalized

const SecurityDashboardOverview: React.FC = () => {
  const { data, isLoading, error } = useSecurityDashboardOverview();

  if (isLoading) {
    return (
      <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5 }}>
        <Typography level="body-sm" color="neutral">
          Loading security overview…
        </Typography>
      </Box>
    );
  }

  if (!data || error) {
    return (
      <Box sx={{ p: 3, textAlign: 'center' }}>
        <Typography level="h4" sx={{ mb: 1 }}>
          Security Dashboard
        </Typography>
        <Typography level="body-sm" color="danger">
          We couldn&apos;t load the security overview. Please try again or check the server logs.
        </Typography>
      </Box>
    );
  }

  const { overallScore, totalChecks, passedChecks, lastUpdated, nextScanInMinutes, checks } = data;

  const getCheck = (id: 'web' | 'code' | 'packages' | 'secrets' | 'cloud' | 'waf') =>
    checks.find(check => check.id === id);

  const web = getCheck('web');
  const code = getCheck('code');
  const packages = getCheck('packages');
  const secrets = getCheck('secrets');
  const cloud = getCheck('cloud');
  const waf = getCheck('waf');

  const scoreLabel =
    overallScore >= 90
      ? 'Excellent'
      : overallScore >= 75
        ? 'Strong'
        : overallScore >= 50
          ? 'Moderate'
          : 'Needs attention';

  return (
    <Box sx={{ p: { xs: 2, md: 3 }, display: 'flex', flexDirection: 'column', gap: 3 }}>
      {/* Header */}
      <Card sx={{ px: 3, py: 2.5, borderRadius: 2, boxShadow: 'sm' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <Security sx={{ fontSize: 32, color: 'primary.500' }} />
            <Box>
              <Typography level="h3">Security Dashboard</Typography>
              <Typography level="body-sm" color="neutral">
                Overview of website, code, dependencies, secrets, cloud infrastructure, and firewall posture.
              </Typography>
            </Box>
          </Box>
          <Chip
            size="sm"
            variant="soft"
            color={overallScore >= 80 ? 'success' : overallScore >= 50 ? 'warning' : 'danger'}
          >
            {scoreLabel}
          </Chip>
        </Box>
      </Card>

      {/* Top row: score + AI assessment */}
      <Grid container spacing={2}>
        {/* Score card */}
        <Grid xs={12} md={4}>
          <Card
            sx={{
              height: '100%',
              borderRadius: 2,
              boxShadow: 'sm',
              p: 2.5,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
            }}
          >
            <Typography level="body-sm" color="neutral" sx={{ mb: 1 }}>
              Overall Security Score
            </Typography>
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5, flexGrow: 1 }}>
              <Box
                sx={{
                  width: 120,
                  height: 120,
                  borderRadius: '50%',
                  background: `conic-gradient(${
                    overallScore >= 80 ? '#48bb78' : overallScore >= 50 ? '#f6ad55' : '#f56565'
                  } ${overallScore * 3.6}deg, #e2e8f0 0)`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 6px 16px rgba(15,23,42,0.25)',
                }}
              >
                <Box
                  sx={{
                    width: 96,
                    height: 96,
                    borderRadius: '50%',
                    backgroundColor: 'background.surface',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Typography level="h2" sx={{ fontSize: 32, fontWeight: 'lg' }}>
                    {overallScore}
                  </Typography>
                  <Typography level="body-xs" color="neutral">
                    / 100
                  </Typography>
                </Box>
              </Box>
              <Typography level="title-md">{scoreLabel}</Typography>
              <Typography level="body-xs" color="neutral">
                {passedChecks}/{totalChecks} checks currently passing
              </Typography>
            </Box>
            <Box
              sx={{
                mt: 2,
                borderTop: '1px solid',
                borderColor: 'divider',
                pt: 1.25,
                fontSize: 12,
                color: 'neutral.600',
              }}
            >
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                <span>Last updated</span>
                <span style={{ fontWeight: 500 }}>{new Date(lastUpdated).toLocaleString()}</span>
              </Box>
              <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Next scan</span>
                <span style={{ fontWeight: 500 }}>
                  {typeof nextScanInMinutes === 'number' ? `${Math.round(nextScanInMinutes / 60)} hours` : 'Scheduled'}
                </span>
              </Box>
            </Box>
          </Card>
        </Grid>

        {/* AI Assessment card */}
        <Grid xs={12} md={8}>
          <Card
            sx={{
              height: '100%',
              borderRadius: 2,
              position: 'relative',
              overflow: 'hidden',
              boxShadow: 'md',
              bgcolor: 'transparent',
            }}
          >
            <Box
              sx={{
                position: 'absolute',
                inset: 0,
                background: 'linear-gradient(135deg, #667eea 0%, #764ba2 50%, #ed64a6 100%)',
              }}
            />
            <CardContent sx={{ position: 'relative', color: 'common.white' }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1.5 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                  <Box
                    sx={{
                      width: 36,
                      height: 36,
                      borderRadius: 1.5,
                      bgcolor: 'rgba(255,255,255,0.2)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Security fontSize="small" />
                  </Box>
                  <Box>
                    <Typography level="title-lg">AI Security Assessment (mock)</Typography>
                    <Typography level="body-xs" sx={{ opacity: 0.9 }}>
                      High-level guidance based on system-wide security signals.
                    </Typography>
                  </Box>
                </Box>
                <Chip
                  size="sm"
                  variant="soft"
                  sx={{ bgcolor: 'rgba(15,23,42,0.4)', color: 'white', borderRadius: 'full' }}
                >
                  Powered by{APP_NAME ? ` ${APP_NAME}` : ''}
                </Chip>
              </Box>

              <Typography level="body-sm" sx={{ mb: 2, opacity: 0.92 }}>
                The AI agent analyzes login anomalies, dependency risk, infrastructure posture and WAF activity to
                highlight a small set of high-impact actions for your team.
              </Typography>

              <Grid container spacing={1.5}>
                <Grid xs={12} md={4}>
                  <Card
                    variant="soft"
                    sx={{
                      bgcolor: 'rgba(15,23,42,0.45)',
                      borderColor: 'rgba(255,255,255,0.25)',
                      color: 'white',
                      borderRadius: 1.5,
                      height: '100%',
                    }}
                  >
                    <CardContent sx={{ p: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
                      <Typography level="body-sm" sx={{ fontWeight: 'lg' }}>
                        Enable DB encryption at rest
                      </Typography>
                      <Typography level="body-xs" sx={{ opacity: 0.9 }}>
                        Hardening encryption for session and analytics stores limits the impact of data exfiltration.
                      </Typography>
                      <Typography level="body-xs" sx={{ opacity: 0.85 }}>
                        Priority: <strong>High</strong>
                      </Typography>
                      <Button
                        size="sm"
                        variant="soft"
                        color="neutral"
                        sx={{ mt: 'auto', alignSelf: 'flex-start' }}
                        data-testid="security-ai-suggestion-encryption-btn"
                      >
                        View guidance
                      </Button>
                    </CardContent>
                  </Card>
                </Grid>
                <Grid xs={12} md={4}>
                  <Card
                    variant="soft"
                    sx={{
                      bgcolor: 'rgba(15,23,42,0.45)',
                      borderColor: 'rgba(255,255,255,0.25)',
                      color: 'white',
                      borderRadius: 1.5,
                      height: '100%',
                    }}
                  >
                    <CardContent sx={{ p: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
                      <Typography level="body-sm" sx={{ fontWeight: 'lg' }}>
                        Patch vulnerable dependencies
                      </Typography>
                      <Typography level="body-xs" sx={{ opacity: 0.9 }}>
                        A few npm packages include moderate CVEs with available upgrades.
                      </Typography>
                      <Typography level="body-xs" sx={{ opacity: 0.85 }}>
                        Priority: <strong>Medium</strong>
                      </Typography>
                      <Button
                        size="sm"
                        variant="soft"
                        color="neutral"
                        sx={{ mt: 'auto', alignSelf: 'flex-start' }}
                        data-testid="security-ai-suggestion-packages-btn"
                      >
                        See affected packages
                      </Button>
                    </CardContent>
                  </Card>
                </Grid>
                <Grid xs={12} md={4}>
                  <Card
                    variant="soft"
                    sx={{
                      bgcolor: 'rgba(15,23,42,0.45)',
                      borderColor: 'rgba(255,255,255,0.25)',
                      color: 'white',
                      borderRadius: 1.5,
                      height: '100%',
                    }}
                  >
                    <CardContent sx={{ p: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
                      <Typography level="body-sm" sx={{ fontWeight: 'lg' }}>
                        Tune WAF bot controls
                      </Typography>
                      <Typography level="body-xs" sx={{ opacity: 0.9 }}>
                        Spikes of automated traffic suggest opportunities to tighten rate limits and bot filters.
                      </Typography>
                      <Typography level="body-xs" sx={{ opacity: 0.85 }}>
                        Priority: <strong>Medium</strong>
                      </Typography>
                      <Button
                        size="sm"
                        variant="soft"
                        color="neutral"
                        sx={{ mt: 'auto', alignSelf: 'flex-start' }}
                        data-testid="security-ai-suggestion-waf-btn"
                      >
                        Review WAF policies
                      </Button>
                    </CardContent>
                  </Card>
                </Grid>
              </Grid>

              <Box sx={{ mt: 2, display: 'flex', alignItems: 'center', gap: 1, fontSize: 12, opacity: 0.85 }}>
                <CheckCircle fontSize="small" />
                <span>
                  AI assessments are currently static mock content and will later pull from real
                  SecurityDashboardSnapshot data.
                </span>
              </Box>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Quick stats row */}
      <Grid container spacing={2}>
        <Grid xs={12} sm={6} md={4}>
          <Card
            sx={{
              borderRadius: 2,
              background:
                web?.status === 'pass'
                  ? 'linear-gradient(135deg, #c6f6d5 0%, #9ae6b4 100%)'
                  : 'linear-gradient(135deg, #fed7d7 0%, #feb2b2 100%)',
              boxShadow: 'sm',
            }}
          >
            <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
              <Box
                sx={{
                  width: 42,
                  height: 42,
                  borderRadius: 1.5,
                  bgcolor: 'rgba(255,255,255,0.9)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: 'sm',
                }}
              >
                <Web color="success" />
              </Box>
              <Box>
                <Typography level="body-xs" sx={{ fontWeight: 'lg', color: 'rgba(45,55,72,0.9)' }}>
                  Website Security
                </Typography>
                <Typography level="body-sm" sx={{ fontWeight: 'lg' }}>
                  {web?.status === 'pass' ? 'Passed' : 'Review required'}
                </Typography>
                <Typography level="body-xs" sx={{ color: 'rgba(74,85,104,0.9)' }}>
                  {web?.summary}
                </Typography>
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid xs={12} sm={6} md={4}>
          <Card
            sx={{
              borderRadius: 2,
              background:
                code?.status === 'pass'
                  ? 'linear-gradient(135deg, #c6f6d5 0%, #9ae6b4 100%)'
                  : 'linear-gradient(135deg, #fed7d7 0%, #feb2b2 100%)',
              boxShadow: 'sm',
            }}
          >
            <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
              <Box
                sx={{
                  width: 42,
                  height: 42,
                  borderRadius: 1.5,
                  bgcolor: 'rgba(255,255,255,0.9)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: 'sm',
                }}
              >
                <Code color="success" />
              </Box>
              <Box>
                <Typography level="body-xs" sx={{ fontWeight: 'lg', color: 'rgba(45,55,72,0.9)' }}>
                  Code Analysis
                </Typography>
                <Typography level="body-sm" sx={{ fontWeight: 'lg' }}>
                  {code?.status === 'pass' ? 'Passed' : 'Review required'}
                </Typography>
                <Typography level="body-xs" sx={{ color: 'rgba(74,85,104,0.9)' }}>
                  {code?.summary}
                </Typography>
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid xs={12} sm={6} md={4}>
          <Card
            sx={{
              borderRadius: 2,
              background:
                packages?.status === 'warning'
                  ? 'linear-gradient(135deg, #feebc8 0%, #fbd38d 100%)'
                  : 'linear-gradient(135deg, #c6f6d5 0%, #9ae6b4 100%)',
              boxShadow: 'sm',
            }}
          >
            <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
              <Box
                sx={{
                  width: 42,
                  height: 42,
                  borderRadius: 1.5,
                  bgcolor: 'rgba(255,255,255,0.9)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: 'sm',
                }}
              >
                {packages?.status === 'warning' ? <WarningAmber color="warning" /> : <CheckCircle color="success" />}
              </Box>
              <Box>
                <Typography level="body-xs" sx={{ fontWeight: 'lg', color: 'rgba(120,53,15,0.9)' }}>
                  Package Security
                </Typography>
                <Typography level="h4">{packages?.score ?? 0}</Typography>
                <Typography level="body-xs" sx={{ color: 'rgba(120,53,15,0.9)' }}>
                  {packages?.summary}
                </Typography>
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid xs={12} sm={6} md={4}>
          <Card
            sx={{
              borderRadius: 2,
              background: 'linear-gradient(135deg, #c6f6d5 0%, #9ae6b4 100%)',
              boxShadow: 'sm',
            }}
          >
            <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
              <Box
                sx={{
                  width: 42,
                  height: 42,
                  borderRadius: 1.5,
                  bgcolor: 'rgba(255,255,255,0.9)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: 'sm',
                }}
              >
                <VpnKey color="success" />
              </Box>
              <Box>
                <Typography level="body-xs" sx={{ fontWeight: 'lg', color: 'rgba(22,101,52,0.9)' }}>
                  Secrets Protection
                </Typography>
                <Typography level="body-sm" sx={{ fontWeight: 'lg' }}>
                  {secrets?.status === 'pass' ? 'Clean' : 'Review required'}
                </Typography>
                <Typography level="body-xs" sx={{ color: 'rgba(22,101,52,0.9)' }}>
                  {secrets?.summary}
                </Typography>
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid xs={12} sm={6} md={4}>
          <Card
            sx={{
              borderRadius: 2,
              background: 'linear-gradient(135deg, #c6f6d5 0%, #9ae6b4 100%)',
              boxShadow: 'sm',
            }}
          >
            <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
              <Box
                sx={{
                  width: 42,
                  height: 42,
                  borderRadius: 1.5,
                  bgcolor: 'rgba(255,255,255,0.9)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: 'sm',
                }}
              >
                <CloudQueue color="primary" />
              </Box>
              <Box>
                <Typography level="body-xs" sx={{ fontWeight: 'lg', color: 'rgba(30,64,175,0.9)' }}>
                  Cloud Security
                </Typography>
                <Typography level="h4">{cloud?.score ?? 0}%</Typography>
                <Typography level="body-xs" sx={{ color: 'rgba(30,64,175,0.9)' }}>
                  {cloud?.summary}
                </Typography>
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid xs={12} sm={6} md={4}>
          <Card
            sx={{
              borderRadius: 2,
              background: 'linear-gradient(135deg, #c6f6d5 0%, #9ae6b4 100%)',
              boxShadow: 'sm',
            }}
          >
            <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
              <Box
                sx={{
                  width: 42,
                  height: 42,
                  borderRadius: 1.5,
                  bgcolor: 'rgba(255,255,255,0.9)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: 'sm',
                }}
              >
                <Shield color="primary" />
              </Box>
              <Box>
                <Typography level="body-xs" sx={{ fontWeight: 'lg', color: 'rgba(30,64,175,0.9)' }}>
                  Firewall
                </Typography>
                <Typography level="body-sm" sx={{ fontWeight: 'lg' }}>
                  {waf?.status === 'pass' ? 'Active' : 'Review rules'}
                </Typography>
                <Typography level="body-xs" sx={{ color: 'rgba(30,64,175,0.9)' }}>
                  {waf?.summary}
                </Typography>
              </Box>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
};

export default SecurityDashboardOverview;
