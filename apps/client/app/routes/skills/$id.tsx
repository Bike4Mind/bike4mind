import { FC, useState } from 'react';
import { Box, Button, Card, Chip, CircularProgress, Stack, Typography } from '@mui/joy';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import ShareIcon from '@mui/icons-material/Share';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import StorefrontIcon from '@mui/icons-material/Storefront';
import TerminalIcon from '@mui/icons-material/Terminal';
import { useNavigate, useParams } from '@tanstack/react-router';
import { Permission } from '@bike4mind/common';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import { useDeleteSkill, useGetSkill } from '@client/app/hooks/data/skills';
import { useUser } from '@client/app/contexts/UserContext';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';
import SkillShareDialog from '@client/app/components/SkillsManagement/SkillShareDialog';
import SkillUpdatePanel from '@client/app/components/SkillMarket/SkillUpdatePanel';
import PublishDialog from '@client/app/components/SkillMarket/PublishDialog';
import MarketStatusBadge from '@client/app/components/SkillMarket/MarketStatusBadge';
import ClaudeCodeExportDialog from '@client/app/components/SkillsManagement/ClaudeCodeExportDialog';

const SkillDetailPage: FC = () => {
  const { id } = useParams({ strict: false }) as { id: string };
  const navigate = useNavigate();
  const { data: skill, isLoading } = useGetSkill(id);
  const deleteSkill = useDeleteSkill();
  const { currentUser } = useUser();
  const [shareOpen, setShareOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [claudeCodeOpen, setClaudeCodeOpen] = useState(false);

  useDocumentTitle(skill ? `/${skill.name}` : 'Skill');

  // Client-side mirrors of the server access predicates so we only show actions
  // the caller can actually perform (a read-only / global-read viewer otherwise
  // sees Edit/Delete/Share and just collects 403s). Admins and org-managers also
  // pass server-side, but those signals aren't all available client-side, so the
  // server remains the source of truth - this only hides buttons that would fail.
  const isOwner = !!skill && !!currentUser && skill.userId === currentUser.id;
  const isAdmin = !!currentUser?.isAdmin;
  const hasShare = (permission: Permission): boolean =>
    skill?.users?.some(u => u.userId === currentUser?.id && u.permissions?.includes(permission)) ?? false;

  // Share-management is owner/admin/org-admin only (a bare `share` grant no
  // longer confers it - see skillAccess.canManageSkillSharing). Org-admin isn't
  // known client-side; the server stays the source of truth.
  const canManageSharing = !!skill && !!currentUser && (isOwner || isAdmin);
  const canEdit =
    !!skill && !!currentUser && (isOwner || isAdmin || skill.isGlobalWrite === true || hasShare(Permission.update));
  const canDelete = !!skill && !!currentUser && (isOwner || isAdmin || hasShare(Permission.delete));

  const handleDelete = async () => {
    if (!skill) return;
    if (!window.confirm(`Delete skill "${skill.name}"? This cannot be undone.`)) return;
    await deleteSkill.mutateAsync(skill.id);
    await navigate({ to: '/skills' });
  };

  if (isLoading) {
    return (
      <Stack alignItems="center" sx={{ py: 8 }}>
        <CircularProgress />
      </Stack>
    );
  }

  if (!skill) {
    return (
      <Box sx={{ p: 3 }}>
        <Typography>Skill not found.</Typography>
        <Button
          sx={{ mt: 2 }}
          variant="plain"
          startDecorator={<ArrowBackIcon />}
          onClick={() => navigate({ to: '/skills' })}
        >
          Back to skills
        </Button>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        p: 3,
        overflowY: 'auto',
        ...scrollbarStyles,
      }}
      data-testid="skill-detail-page"
    >
      <Stack spacing={3} sx={{ maxWidth: 800, mx: 'auto', width: '100%' }}>
        <Button
          variant="plain"
          startDecorator={<ArrowBackIcon />}
          onClick={() => navigate({ to: '/skills' })}
          sx={{ alignSelf: 'flex-start' }}
        >
          All skills
        </Button>

        <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={2}>
          <Box>
            <Typography level="h2" component="code" data-testid="skill-detail-name">
              /{skill.name}
              {skill.argumentHint ? <span style={{ opacity: 0.6 }}> {skill.argumentHint}</span> : null}
            </Typography>
            <Typography level="body-md" textColor="text.tertiary" sx={{ mt: 1 }}>
              {skill.description}
            </Typography>
            <Stack direction="row" spacing={1} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
              {skill.disableModelInvocation ? (
                <Chip size="sm" color="warning">
                  Hidden from LLM auto-invocation
                </Chip>
              ) : null}
              <MarketStatusBadge status={skill.marketStatus} />
            </Stack>
          </Box>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap justifyContent="flex-end">
            <Button
              variant="outlined"
              startDecorator={<TerminalIcon />}
              onClick={() => setClaudeCodeOpen(true)}
              data-testid="skill-claude-code-btn"
            >
              Use in Claude Code
            </Button>
            {isOwner && !skill.importedFrom ? (
              <Button
                variant="outlined"
                startDecorator={<StorefrontIcon />}
                onClick={() => setPublishOpen(true)}
                data-testid="skill-detail-publish"
              >
                Publish to market
              </Button>
            ) : null}
            {canManageSharing ? (
              <Button
                variant="outlined"
                startDecorator={<ShareIcon />}
                onClick={() => setShareOpen(true)}
                data-testid="skill-detail-share"
              >
                Share
              </Button>
            ) : null}
            {canEdit ? (
              <Button
                variant="outlined"
                startDecorator={<EditIcon />}
                onClick={() => navigate({ to: '/skills/$id/edit', params: { id: skill.id } })}
                data-testid="skill-detail-edit"
              >
                Edit
              </Button>
            ) : null}
            {canDelete ? (
              <Button
                variant="outlined"
                color="danger"
                startDecorator={<DeleteIcon />}
                onClick={handleDelete}
                data-testid="skill-detail-delete"
              >
                Delete
              </Button>
            ) : null}
          </Stack>
        </Stack>

        {isOwner ? <SkillUpdatePanel skill={skill} /> : null}

        <Card variant="outlined" sx={{ p: 0 }}>
          <Box
            component="pre"
            sx={{
              m: 0,
              p: 2,
              fontFamily: 'code',
              fontSize: 'sm',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
            data-testid="skill-detail-body"
          >
            {skill.body}
          </Box>
        </Card>
      </Stack>

      {canManageSharing && shareOpen ? <SkillShareDialog onClose={() => setShareOpen(false)} skill={skill} /> : null}
      {publishOpen ? <PublishDialog onClose={() => setPublishOpen(false)} skill={skill} /> : null}
      {claudeCodeOpen ? (
        <ClaudeCodeExportDialog
          onClose={() => setClaudeCodeOpen(false)}
          skill={skill}
          sourcePath={`/skills/${encodeURIComponent(skill.id)}`}
          version={skill.importedFrom?.version}
          thirdParty={!!skill.importedFrom}
        />
      ) : null}
    </Box>
  );
};

export default SkillDetailPage;
