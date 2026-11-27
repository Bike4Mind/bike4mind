import { join } from 'node:path';
import type { ChatServiceLogger } from '../main/chat/ChatService';
import { ClaudeCodeSettings } from '../main/chat/permissions/ClaudeCodeSettings';
import { PermissionRuleStore } from '../main/chat/permissions/PermissionRuleStore';
import { PermissionService } from '../main/chat/permissions/PermissionService';
import { appWorktreeMainCheckout } from '../main/chat/project/workspace';
import { accountSkillsProvider } from '../main/chat/skills/accountSkills';
import { ProjectTrustStore } from '../main/chat/skills/ProjectTrustStore';
import { SkillCatalog } from '../main/chat/skills/SkillCatalog';
import { mainCheckoutOf } from '../main/chat/tools/shellTools';
import type { HostAuth, HostEnvironment, HostProtection } from './ports';

export type HostPermissionStack = {
  projectTrust: ProjectTrustStore;
  skills: SkillCatalog;
  permissions: PermissionService;
};

export type HostPermissionStackOptions = {
  environment: Pick<HostEnvironment, 'dataDirectory' | 'homeDirectory'>;
  protection: HostProtection;
  auth: HostAuth;
  logger: ChatServiceLogger;
};

/**
 * The approval rules, project trust and skills of one host, built the same way by Desktop and
 * the headless host so both decide a tool call alike. Starts loading the rules; a failure there
 * is logged and the service answers from what it has.
 */
export function createHostPermissionStack(options: HostPermissionStackOptions): HostPermissionStack {
  const { environment, protection, auth, logger } = options;
  const dataDirectory = environment.dataDirectory;
  // The trust file is its own file beside the permission rules, and for the same reason: both record
  // a consent the user gave once and should not be asked for again on every launch.
  const projectTrust = new ProjectTrustStore(join(dataDirectory, 'project-skill-trust.json'), directory =>
    appWorktreeMainCheckout(directory, mainCheckoutOf)
  );
  const skills = new SkillCatalog(projectTrust, accountSkillsProvider(auth, dataDirectory), logger);
  // App-wide like the approval mode. Claude Code's files are only ever read; the protected roots
  // are folders no allow rule may cover, since a call writing there would grant itself more.
  const home = environment.homeDirectory;
  const claudeCode = new ClaudeCodeSettings({ home, logger, onChange: () => permissions.invalidate() });
  const permissions: PermissionService = new PermissionService({
    store: new PermissionRuleStore(permissionRulesPath(dataDirectory)),
    claudeCode,
    isTrusted: directory => projectTrust.isTrusted(directory),
    home,
    protectedRoots: () => protection.permission.paths(),
    unresolvedProtected: () => protection.permission.unresolved(),
    mainCheckoutOf,
    logger,
  });
  void permissions.start().catch(error => logger.warn(`PERMISSIONS: could not load rules: ${String(error)}`));
  return { projectTrust, skills, permissions };
}

export function permissionRulesPath(dataDirectory: string): string {
  return join(dataDirectory, 'permission-rules.json');
}
