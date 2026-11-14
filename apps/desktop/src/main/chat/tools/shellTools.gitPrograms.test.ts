import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { permissionProtectedLocations } from '../protectedLocations';
import { compileRule, parseRule, PermissionRuleSet, type CompiledRule } from '../permissions/rules';
import { resolveSubject } from '../permissions/resolveSubject';
import { permissionSubject } from '../permissions/subject';
import { runsCheckedInAuto, runsCheckedInFull } from './shellApproval.testHelper';
import { isAbsoluteGitPath } from './shellScan';
import { shellApproval } from './shellTools';
import type { ToolContext } from './types';

vi.mock('./userPath', async importOriginal => ({
  ...(await importOriginal<typeof import('./userPath')>()),
  resolveUserPath: vi.fn(async () => process.env.PATH ?? ''),
}));

const queried = vi.hoisted(() => ({ envs: [] as Record<string, string>[] }));

vi.mock('./shellWrites', async importOriginal => {
  const actual = await importOriginal<typeof import('./shellWrites')>();
  return {
    ...actual,
    gitSigningConfig: (...args: Parameters<typeof actual.gitSigningConfig>) => {
      queried.envs.push(args[1].env as Record<string, string>);
      return actual.gitSigningConfig(...args);
    },
  };
});

const inWsl = vi.hoisted(() => ({ on: false }));

vi.mock('../../wsl/wslPath', async importOriginal => {
  const actual = await importOriginal<typeof import('../../wsl/wslPath')>();
  return {
    ...actual,
    wslLocation: (...args: Parameters<typeof actual.wslLocation>) =>
      inWsl.on ? { host: 'wsl.localhost' as const, distro: 'Debian', linuxPath: args[0] } : actual.wslLocation(...args),
  };
});

// Each row's cells: a rule `Bash(<program>:*)` covers it, then auto mode, auto mode with a session, full mode (r runs, a asks).
const ROWS: [string, string, string][] = [
  ['source ./env5.sh && rm -rf dist', '', 'aaaa'],
  ['source ./env6.sh && rm -rf dist', '', 'aaaa'],
  ['source $PWD/env5.sh && rm -rf dist', '', 'aaaa'],
  ['source ./env5.sh && rm -rf .ssh', '', 'aaaa'],
  ['source ./env5.sh && echo x > .bashrc', '', 'aaaa'],
  ['. ./env5.sh && rm -rf dist', '', 'aaaa'],
  ['source ./env7.sh && rm -rf dist', '', 'aaaa'],
  ['source .venv/bin/activate && rm -rf dist', '', 'aaaa'],
  ['source .venv/bin/activate && git st', '', 'aaaa'],
  ['. .venv/bin/activate && git st', '', 'aaaa'],
  ['source .uvenv/bin/activate && git st', '', 'aaaa'],
  ['source env1.sh && git st', '', 'aaaa'],
  ['source env3.sh && git st', '', 'aaaa'],
  ['source env1.sh && git status', '', 'rrrr'],
  ['source ./env1.sh && npm test', '', 'rrrr'],
  ['. ./env3.sh && ls', '', 'rrrr'],
  ['git clone ../origin.git cl', 'src', 'rrrr'],
  ['git clone ../origin.git', 'src', 'rrrr'],
  ['git clone ../origin.git cl && cd cl && ls', 'src', 'rrrr'],
  ['git clone ../origin.git cl && cd cl && npm install', 'src', 'rrrr'],
  ['git clone ../origin.git cl && cd cl && git status', 'src', 'rrrr'],
  ['git clone ../origin.git cl && git -C cl status', 'src', 'rrrr'],
  ['git clone blay/.bare cl3 && cd cl3 && ls', '', 'rrrr'],
  ['git worktree add wt3 -b z && cd wt3 && git st', '', 'rrrr'],
  ['git init newrepo && git -C newrepo st', '', 'aaaa'],
  ['git clone origin.git cl4 && git -C cl4 st', '', 'aaaa'],
  ['git clone ../origin.git cl && git -C cl st', 'src', 'aaaa'],
  ['git clone --template=tpl2 origin.git cl5 && git -C cl5 st', '', 'aaaa'],
  ['git init --template=tpl2 newr2 && git -C newr2 st', '', 'aaaa'],
  ['git -c init.templateDir=tpl2 init newr3 && git -C newr3 st', '', 'aaaa'],
  ['git init --separate-git-dir=sg newr4 && git -C newr4 st', '', 'aaaa'],
  ['git clone -c alias.st=status origin.git cl6 && git -C cl6 st', '', 'aaaa'],
  ['rsync -a --exclude node_modules src/ dist/ && git st', '', 'rrrr'],
  ['cp -r src/* dist/ && git st', '', 'rrrr'],
  ['cp -r src dist && git st', '', 'rrrr'],
  ['rsync -a src/ dist/ && git st', '', 'rrrr'],
  ['cp -r tpl2/. dist/ && git st', '', 'rrrr'],
  ['rsync -a -e ssh src/ dist/ && git st', '', 'aaaa'],
  ['cp -r -t dist src && git st', '', 'rrrr'],
  ['cp -r lrepo dist2 && git st', '', 'rrrr'],
  ['cp -r lrepo/* dist2/ && git st', '', 'rrrr'],
  ['cp -r lrepo/. dist2/ && git st', '', 'rrrr'],
  ['cp -r evil/.git sub/ && git -C sub st', '', 'aaaa'],
  ['mv tpl/.git src/ && git -C src st', '', 'aaaa'],
  ['cp -r tpl/.git . && git st', '', 'aaaa'],
  ['cp -r lrepo dist && git -C dist/lrepo st', '', 'aaaa'],
  ['cp -r tpl/. src && git -C src st', '', 'aaaa'],
  ['rsync -a --exclude .git lrepo/ dist3/ && git -C dist3 st', '', 'rrrr'],
  ['rsync -a --exclude=.git lrepo/ dist3/ && git -C dist3 st', '', 'rrrr'],
  ['rsync -a --exclude=.git/ lrepo/ dist3/ && git -C dist3 st', '', 'aaaa'],
  ["rsync -a --exclude='.git' lrepo/ dist3/ && git -C dist3 st", '', 'rrrr'],
  ['rsync -aC lrepo/ dist3/ && git -C dist3 st', '', 'aaaa'],
  ['rsync -a --cvs-exclude lrepo/ dist3/ && git -C dist3 st', '', 'aaaa'],
  ['rsync -a --exclude=.git/ gf/ sub/ && git -C sub st', '', 'aaaa'],
  ['rsync -aC gf/ d10/ && git -C d10 st', '', 'aaaa'],
  ['rsync -a --cvs-exclude gf/ d10/ && git -C d10 st', '', 'aaaa'],
  ['rsync -a --exclude=.git gf/ d10/ && git -C d10 st', '', 'rrrr'],
  ['rsync -a --exclude .git --include .git lrepo/ dist3/ && git -C dist3 st', '', 'aaaa'],
  ['rsync -a --exclude node_modules lrepo/ dist3/ && git -C dist3 st', '', 'aaaa'],
  ['git init && git st', '', 'rrrr'],
  ['mkdir nr && cd nr && git init && git st', '', 'aaaa'],
  ['cd src && git init && git st', '', 'aaaa'],
  ['git clone origin.git cl && cd cl && pnpm install && git st', '', 'aaaa'],
  ['git clone origin.git cl && cd cl && npm test && git st', '', 'aaaa'],
  ['git worktree add wt4 -b y4 && cd wt4 && pnpm install && git st', '', 'rrrr'],
  ['export PATH="$PWD/newtools:$PATH" && git clone srcrepo newtools && git hello', '', 'aaaa'],
  ['git clone srcrepo ctools && git hello', '', 'aaaa'],
  ["eval 'echo hi' && git st", '', 'aaaa'],
  ['cd nosuchdir; git st', '', 'aaaa'],
  ['git bang', '', 'aaaa'],
  ['source ./env1.sh && git bang', '', 'aaaa'],
  ['cd nosuchdir; git bang', '', 'aaaa'],
  ['git constructor -x', '', 'aaaa'],
  ['git toString -q', '', 'aaaa'],
  ['git __proto__ -q', '', 'aaaa'],
  ['git -c safe.bareRepository=all -C origin.git log', '', 'aaaa'],
  ['git -c SAFE.BareRepository=explicit log', '', 'aaaa'],
  ['git --config-env=safe.bareRepository=X log', '', 'aaaa'],
  ['git --config-env safe.bareRepository=X log', '', 'aaaa'],
  ['git -c core.abbrev=8 log', '', 'arrr'],
  ['env -i PATH="$PATH" git -C origin.git log', '', 'aaaa'],
  ['env - git log', '', 'aaaa'],
  ['env --ignore-environment git log', '', 'aaaa'],
  ['env -u GIT_CONFIG_PARAMETERS git log', '', 'aaaa'],
  ['env -u GIT_CONFIG_COUNT git log', '', 'aaaa'],
  ['env -u GIT_CONFIG_KEY_0 git log', '', 'aaaa'],
  ['env -u FOO git log', '', 'arrr'],
  ['env -i PATH="$PATH" node x.js', '', 'arrr'],
  ['cp -r lrepo/* dist2/ && git -C dist2 st', '', 'rrrr'],
  ['git merge -s foo other', '', 'aaaa'],
  ['git pull -s foo origin main', '', 'aaaa'],
  ['git rebase --strategy=foo main', '', 'aaaa'],
  ['git cherry-pick --strategy=foo other', '', 'aaaa'],
  ['git revert --strategy foo HEAD', '', 'aaaa'],
  ['git pull -s ort origin main', '', 'rrrr'],
  ['git pull --rebase origin main', '', 'rrrr'],
  ['git rebase -s recursive main', '', 'rrrr'],
  ['git cherry-pick -s other', '', 'rrrr'],
  ['git merge -s ours other', '', 'rrrr'],
  ['git pull -sfoo origin main', '', 'aaaa'],
  ['git rebase -s foo main', '', 'aaaa'],
  ['git status', '', 'rrrr'],
  ['git log --oneline -5', '', 'rrrr'],
  ['git diff', '', 'rrrr'],
  ['git add -A', '', 'rrrr'],
  ['git add src/a.ts', '', 'rrrr'],
  ['git commit -m x', '', 'rrrr'],
  ['git switch other', '', 'rrrr'],
  ['git checkout other', '', 'rrrr'],
  ['git checkout -b feat', '', 'rrrr'],
  ['git stash', '', 'rrrr'],
  ['git stash pop', '', 'aaaa'],
  ['git rebase main', '', 'rrrr'],
  ['git rebase -i main', '', 'aaaa'],
  ['git fetch', '', 'rrrr'],
  ['git fetch origin', '', 'rrrr'],
  ['git pull', '', 'rrrr'],
  ['git pull origin main', '', 'rrrr'],
  ['git push', '', 'rrrr'],
  ['git push origin main', '', 'rrrr'],
  ['git push -u origin main', '', 'rrrr'],
  ['git st', '', 'rrrr'],
  ['git lg -3', '', 'rrrr'],
  ['git co other', '', 'rrrr'],
  ['git p', '', 'rrrr'],
  ['git st && git lg', '', 'rrrr'],
  ['git add -A && git commit -m x && git p', '', 'rrrr'],
  ['git commit -am x && git st', '', 'rrrr'],
  ['git switch other && git st', '', 'rrrr'],
  ['git co other && git st', '', 'rrrr'],
  ['git pull && git st', '', 'rrrr'],
  ['git rm a.ts && git st', '', 'rrrr'],
  ['git mv a.ts b.ts && git st', '', 'rrrr'],
  ['git reset --hard', '', 'rrrr'],
  ['git restore a.ts', '', 'rrrr'],
  ['git branch -d feat', '', 'rrrr'],
  ['git tag v1', '', 'rrrr'],
  ['git clean -fd', '', 'rrrr'],
  ['pnpm test', '', 'rrrr'],
  ['pnpm lint', '', 'rrrr'],
  ['pnpm build', '', 'rrrr'],
  ['pnpm install', '', 'rrrr'],
  ['pnpm --filter x test', '', 'rrrr'],
  ['npm test', '', 'rrrr'],
  ['npm ci', '', 'rrrr'],
  ['npm run build', '', 'rrrr'],
  ['npx vitest run', '', 'rrrr'],
  ['npx tsc --noEmit', '', 'rrrr'],
  ['npx eslint .', '', 'rrrr'],
  ['npx prettier --check .', '', 'rrrr'],
  ['vitest run', '', 'rrrr'],
  ['tsc --noEmit', '', 'rrrr'],
  ['eslint src', '', 'rrrr'],
  ['prettier --write src', '', 'rrrr'],
  ['mkdir -p build/out', '', 'rrrr'],
  ['touch a.txt', '', 'rrrr'],
  ['cp a.ts b.ts', '', 'rrrr'],
  ['cp -r src build', '', 'rrrr'],
  ['mv a.ts c.ts', '', 'rrrr'],
  ['ln -s a.ts l', '', 'rrrr'],
  ['ln a.ts hard', '', 'rrrr'],
  ['rsync -a src/ build/', '', 'rrrr'],
  ['rm -rf dist', '', 'rrrr'],
  ['rm a.ts', '', 'rrrr'],
  ['ls -la', '', 'rrrr'],
  ['cat a.ts', '', 'rrrr'],
  ['echo hi > out.txt', '', 'arrr'],
  ['export PATH="$HOME/.cargo/bin:$PATH" && git st', '', 'arrr'],
  ['export PATH="$PWD/node_modules/.bin:$PATH" && pnpm test', '', 'arrr'],
  ['PATH=./tools:$PATH git st', '', 'arrr'],
  ['export PATH="$HOME/x:$PATH"; git st', '', 'arrr'],
  ['cd src && git st', '', 'rrrr'],
  ['cd src && git status && cd .. && git lg', '', 'rrrr'],
  ['mkdir x && cd x && git st', '', 'rrrr'],
  ['mkdir -p tmp/a && cd tmp/a && git status', '', 'rrrr'],
  ['git status && pnpm test && git st', '', 'rrrr'],
  ['pnpm build && git add -A && git commit -m build && git p', '', 'rrrr'],
  ['git fetch && git rebase origin/main && pnpm test && git p', '', 'aaaa'],
  ['cd lrepo && git st && cd ..', '', 'rrrr'],
  ['git -C lrepo st', '', 'rrrr'],
  ['git -C src st', '', 'rrrr'],
  ['for d in src lrepo; do git -C "$d" st; done', '', 'arrr'],
  ['git init np2 && cd np2 && touch a && git st', '', 'aaaa'],
  ['git init np2 && cd np2 && echo x > README.md && git st', '', 'aaaa'],
  ['git clone origin.git cl8 && cd cl8 && echo x > notes.md && git st', '', 'aaaa'],
  ['mkdir np3 && cd np3 && git init && touch a && git st', '', 'aaaa'],
  ['git worktree add wt6 -b w6 && cd wt6 && touch a && git st', '', 'rrrr'],
  ['git init np2 && cd np2 && touch a && git add a && git commit -m x && git lg', '', 'aaaa'],
  ['pnpm build && cp -r out pub && git st', '', 'rrrr'],
  ['mkdir -p out && cp -r out pub && git st', '', 'rrrr'],
  ['npm run build && cp -r out/ ../deploy/ && git st', '', 'rrrr'],
  ['cp -r evil/.git out/ && cp -r out pub && git -C pub st', '', 'aaaa'],
  ['cp -r vend dist6 && git -C dist6/lib st', '', 'aaaa'],
  ['cp -r vend dist6 && cd dist6/lib && git st', '', 'aaaa'],
  ['cp -r vend dist && git -C dist/vend/lib st', '', 'aaaa'],
  ['rsync -a vend/ dist6/ && git -C dist6/lib st', '', 'aaaa'],
  ['cp -r evil/.git sub/ && git -C sublink st', '', 'aaaa'],
  ['cp -r evil/.git sub/ && git -C sublink/deep st', '', 'aaaa'],
  ['cp -r tpl/. sub && git -C sublink st', '', 'aaaa'],
  ['ln -s ../evil/.git sub/.git && git -C sublink st', '', 'aaaa'],
  ['cp evil/.git/config .git/config; cd nosuchdir; git st', '', 'aaaa'],
  ['cp -r evil/.git sub/; cd nosuchdir; git -C ~/proj/sub st', '', 'aaaa'],
  ['cp evil/.git/config .git/config && source ./env1.sh && git st', '', 'aaaa'],
  ['rsync -aR --exclude .git evil/./.git/config evil/./.git/HEAD evil/./.git/refs d7/ && git -C d7 st', '', 'aaaa'],
  ['rsync -a --exclude .git -f "+ .git" lrepo/ d8/ && git -C d8 st', '', 'aaaa'],
  ['rsync -a --exclude .git --filter="+ .git" lrepo/ d8/ && git -C d8 st', '', 'aaaa'],
  ['rsync -a --exclude .git -F lrepo/ d8/ && git -C d8 st', '', 'aaaa'],
  ['rsync -a --exclude .git --exclude-from=ex.txt lrepo/ d8/ && git -C d8 st', '', 'aaaa'],
  ['rsync -a --exclude .git --include-from=in.txt lrepo/ d8/ && git -C d8 st', '', 'aaaa'],
  ['rsync -a --exclude .git --relative lrepo d8/ && git -C d8 st', '', 'aaaa'],
  ['rsync -a --exclude .git --files-from=list.txt lrepo d8/ && git -C d8 st', '', 'aaaa'],
  ['rsync -a --exclude .git lrepo/.git/ d9/ && git -C d9 st', '', 'aaaa'],
  ['unset GIT_CONFIG_COUNT; git log', '', 'aaaa'],
  ['unset GIT_CONFIG_COUNT; cp -r evil/.git/. bare/ && git -C bare log', '', 'aaaa'],
  ['export -n GIT_CONFIG_COUNT; git log', '', 'aaaa'],
  ['env --unset=GIT_CONFIG_COUNT git log', '', 'aaaa'],
  ['env -uGIT_CONFIG_COUNT git log', '', 'aaaa'],
  ['pnpm exec env -i git log', '', 'aaaa'],
  ['find . -maxdepth 0 -exec env -i git log \\;', '', 'aaaa'],
  ['pnpm exec env -i node x.js', '', 'rrrr'],
  ['cd nosuchdir; git merge-foo', '', 'aaaa'],
  ['rm -rf lrepo && mv bad lrepo && git -C lrepo st', '', 'aaaa'],
  ['mv lrepo x && mv bad lrepo && cd lrepo && git st', '', 'aaaa'],
  ['mv src src.old && mv bad src && git -C src st', '', 'aaaa'],
  ['mv a.ts b.ts && git st', '', 'rrrr'],
  ['rm -rf dist && git st', '', 'rrrr'],
  ['rm -rf build && mkdir build && cd build && git st', '', 'aaaa'],
  ['rm -rf build && mkdir -p build && git -C build st', '', 'aaaa'],
  ['rm -rf tmp && mkdir tmp && cd tmp && git st', '', 'aaaa'],
  ['rm -rf dist && mkdir dist && cd dist && git lg -3', '', 'aaaa'],
  ['rm -rf cl && git clone origin.git cl && cd cl && git st', '', 'aaaa'],
  ['rm -rf lib && mv bad lib && git -C lib st', '', 'aaaa'],
  ['rm -rf lib && mkdir lib && mv bad/.git lib/ && git -C lib st', '', 'aaaa'],
  ['rm -rf lib && mkdir lib && cp -r bad/. lib && git -C lib st', '', 'aaaa'],
  ['rm -rf lib && mkdir lib && mv -T bad lib && git -C lib st', '', 'aaaa'],
  ['rm -rf dist/* && git st', '', 'rrrr'],
  ['rm -rf *.log && git st', '', 'rrrr'],
  ['rm -rf {dist,build} && git st', '', 'rrrr'],
  ['rm -rf **/node_modules && git st', '', 'rrrr'],
  ['rm -rf **/lib && mv bad d3/x/lib && git -C d3/x/lib st', '', 'rrrr'],
  ['rm -rf */lib && git st', '', 'rrrr'],
  ['rmdir -p tmp/x && git st', '', 'aaaa'],
  ['rmdir elib && mv bad elib && git -C elib st', '', 'aaaa'],
  ['cp -r bad stage && rmdir elib && mv stage elib && git -C elib st', '', 'aaaa'],
  ['rmdir -p pa/elib && mv bad pa/elib && git -C pa/elib st', '', 'aaaa'],
  ['rm -rf outer/lib && mkdir outer/lib && git -C outer/lib st', '', 'aaaa'],
  ['cd outer && rm -rf lib && mkdir lib && cd lib && git st', '', 'aaaa'],
  ['rm -rf outer/lib && mkdir -p outer/lib/sub && git -C outer/lib/sub st', '', 'aaaa'],
  ['rm -rf lib && mkdir lib && git -C lib init && git -C lib st', '', 'aaaa'],
  ['git fetch HTTP::x', '', 'aaaa'],
  ['git fetch HTTPS::x', '', 'aaaa'],
  ['git fetch https://github.com/a/b', '', 'rrrr'],
  ['rm -rf node_modules && pnpm i && git st', '', 'rrrr'],
  ['rm -rf dist/* && git st', '', 'rrrr'],
  ['rm -f *.log && git st', '', 'rrrr'],
  ['rm -rf coverage/* && git st', '', 'rrrr'],
  ['rm -rf dist/*.map && git lg -3', '', 'rrrr'],
  ['rm -f src/*.orig && git co a.ts', '', 'rrrr'],
  ['rm -rf dist/* && pnpm build && git st', '', 'rrrr'],
  ['rm -rf .g* && git st', '', 'aaaa'],
  ['shopt -s dotglob; rm -rf * && git st', '', 'aaaa'],
  ['rm -rf lrepo/* && mv bad/. lrepo && git -C lrepo st', '', 'aaaa'],
  ['rm -rf * && git st', '', 'aaaa'],
  ['cp -r vend dist6 && pnpm exec git -C dist6/lib st', '', 'aaaa'],
  ['cp -r vend dist6 && npx git -C dist6/lib st', '', 'aaaa'],
  ['cp -r vend dist6 && npm exec -- git -C dist6/lib st', '', 'aaaa'],
  ['pnpm exec git bang', '', 'aaaa'],
  ['echo st | xargs git -C bad', '', 'aaaa'],
  ['find . -maxdepth 0 -exec git bang \\;', '', 'aaaa'],
  ['find . -maxdepth 0 -exec git -C {} st \\;', '', 'aaaa'],
  ['echo bad | xargs -I{} git -C {} st', '', 'aaaa'],
  ['echo st | xargs git', '', 'aaaa'],
  ['pnpm exec git merge -s foo other', '', 'aaaa'],
  ['npx git pull -s foo origin main', '', 'aaaa'],
  ['find . -maxdepth 0 -exec git merge -s foo other \\;', '', 'aaaa'],
  ['pnpm exec git status', '', 'rrrr'],
  ['npx git log -1', '', 'rrrr'],
  ['pnpm --filter x exec git bang', '', 'aaaa'],
  ['pnpm -F x exec git bang', '', 'aaaa'],
  ['pnpm --filter=x exec git bang', '', 'aaaa'],
  ['pnpm -C . exec git bang', '', 'aaaa'],
  ['pnpm --dir . exec git bang', '', 'aaaa'],
  ['pnpm -w exec git bang', '', 'aaaa'],
  ['pnpm -r exec git bang', '', 'aaaa'],
  ['pnpm -rw exec git bang', '', 'aaaa'],
  ['pnpm recursive exec git bang', '', 'aaaa'],
  ['pnpm --filter x --filter y exec git bang', '', 'aaaa'],
  ['pnpm --unknown-option exec git bang', '', 'aaaa'],
  ['pnpm -Z x exec git bang', '', 'aaaa'],
  ['npm x git bang', '', 'aaaa'],
  ['npm x -- git bang', '', 'aaaa'],
  ['npm --prefix . exec git bang', '', 'aaaa'],
  ['npm --prefix . x git bang', '', 'aaaa'],
  ['npm -w a exec -- git bang', '', 'aaaa'],
  ['npm --workspace=a exec -- git bang', '', 'aaaa'],
  ['npm --unknown-option exec -- git bang', '', 'aaaa'],
  ['yarn --cwd . exec git bang', '', 'aaaa'],
  ['pnpm --filter x exec git fetch --upload-pack="touch M" origin', '', 'aaaa'],
  ['pnpm -C . exec git fetch --upload-pack="touch M" origin', '', 'aaaa'],
  ['npm x git fetch --upload-pack="touch M" origin', '', 'aaaa'],
  ['pnpm --filter x exec git merge -s foo other', '', 'aaaa'],
  ['pnpm --filter x exec git status', '', 'rrrr'],
  ['pnpm -C . exec git log -1', '', 'rrrr'],
  ['npm x git status', '', 'rrrr'],
  ['npm -w a exec -- git status', '', 'arrr'],
  ['npm --prefix . exec -- git status', '', 'aaaa'],
  ['git branch --unset-upstream "$B"', '', 'aaaa'],
  ['git log --grep=unset "$X"', '', 'aaaa'],
  ['export GIT_EXTERNAL_DIFF=./x.sh; git log -1 -p "$X"', '', 'aaaa'],
  ['git log --format="%H unset $x"', '', 'aaaa'],
  ['unset -v GIT_CONFIG_COUNT; git log', '', 'aaaa'],
  ['unset GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0; git log', '', 'aaaa'],
  ['unset "$X"; git log', '', 'aaaa'],
  ['export -n GIT_CONFIG_PARAMETERS; git log', '', 'aaaa'],
  ['export -n "$X"; git log', '', 'aaaa'],
  ['command unset GIT_CONFIG_COUNT; git log', '', 'aaaa'],
  ['builtin unset GIT_CONFIG_COUNT; git log', '', 'aaaa'],
  ['f() { unset GIT_CONFIG_COUNT; }; f; git log', '', 'aaaa'],
  ['( unset GIT_CONFIG_COUNT ); git log', '', 'aaaa'],
  ['if true; then unset GIT_CONFIG_COUNT; fi; git log', '', 'aaaa'],
  ['eval "unset GIT_CONFIG_COUNT"; git log', '', 'aaaa'],
  ["eval 'export -n GIT_CONFIG_COUNT'; git log", '', 'aaaa'],
  ['pnpm exec git fetch --upload-pack="touch M" origin', '', 'aaaa'],
  ['builtin -- unset GIT_CONFIG_PARAMETERS; git -C origin.git log', '', 'aaaa'],
  ['builtin -- unset GIT_CONFIG_COUNT; git log', '', 'aaaa'],
  ['builtin -- export -n GIT_CONFIG_PARAMETERS; git log', '', 'aaaa'],
  ["builtin -- source /dev/stdin <<< 'unset GIT_CONFIG_COUNT'; git log", '', 'aaaa'],
  ['builtin -- source <(echo unset GIT_CONFIG_COUNT); git log', '', 'aaaa'],
  ['command -- unset GIT_CONFIG_COUNT; git log', '', 'aaaa'],
  ['command -p unset GIT_CONFIG_COUNT; git log', '', 'aaaa'],
  ['source env1.sh && git ext', '', 'aaaa'],
  ['cd nosuchdir; git ext', '', 'aaaa'],
  ['source env2.sh && git subtree', '', 'aaaa'],
  ['source env2.sh && git quiltimport', '', 'aaaa'],
  ['source env2.sh && git merge-octopus', '', 'aaaa'],
  ['cd nosuchdir; git subtree', '', 'aaaa'],
  ['cd nosuchdir; git quiltimport', '', 'aaaa'],
  ['source env1.sh && git lfs version', '', 'aaaa'],
  ['cd nosuchdir; git lfs version', '', 'aaaa'],
  ['pnpm --workspace-packages install exec git bang', '', 'aaaa'],
  ['git stage a.ts', '', 'rrrr'],
  ['source env1.sh && git stage a.ts', '', 'rrrr'],
  ['cd nosuchdir; git stage a.ts', '', 'rrrr'],
  ['source env1.sh && git sparse-checkout list', '', 'rrrr'],
  ['cd nosuchdir; git sparse-checkout list', '', 'rrrr'],
  ['source env1.sh && git bang', '', 'aaaa'],
  ['source env1.sh && git nosuchprogram', '', 'aaaa'],
  ["find . -name '*.ts' -exec git add {} +", '', 'arrr'],
  ['git pull -ts foo origin main', '', 'aaaa'],
  ['git pull -ps foo origin main', '', 'aaaa'],
  ['git pull -as foo origin main', '', 'aaaa'],
  ['git pull -ks foo origin main', '', 'aaaa'],
  ['git pull -4s foo origin main', '', 'aaaa'],
  ['git pull -tsfoo origin main', '', 'aaaa'],
  ['git merge -qs foo other', '', 'aaaa'],
  ['git rebase -ks foo main', '', 'aaaa'],
  ['git pull -ts ort origin main', '', 'rrrr'],
  ['git pull -Xs origin main', '', 'rrrr'],
  ['git cherry-pick -ns other', '', 'rrrr'],
  ['git fetch foo::x', '', 'aaaa'],
  ['git ls-remote foo::x', '', 'aaaa'],
  ['git pull foo::x main', '', 'aaaa'],
  ['git remote add r foo::x && git fetch r', '', 'aaaa'],
  ['git remote set-url origin foo::x', '', 'aaaa'],
  ['git clone foo::x cl9', '', 'aaaa'],
  ['git submodule add foo::x sm', '', 'aaaa'],
  ['git push foo::x main', '', 'aaaa'],
  ['git fetch bar::x', '', 'aaaa'],
  ['git fetch https::x', '', 'aaaa'],
  ['exec -c git -C origin.git log', '', 'aaaa'],
  ['cp -r evil/.git/. bare/ && exec -c git -C bare log', '', 'aaaa'],
  ['export PATH="$PWD/nt6//:$PATH" && mkdir nt6 && cp srcx/git-hello nt6/ && git hello', '', 'aaaa'],
  ['git -C rem/helper fetch origin', '', 'aaaa'],
  ['git -C rem/helper fetch', '', 'aaaa'],
  ['git -C rem/helper pull', '', 'aaaa'],
  ['git -C rem/helper ls-remote origin', '', 'aaaa'],
  ['git -C rem/helper remote show origin', '', 'aaaa'],
  ['git -C rem/helper remote show -n origin', '', 'rrrr'],
  ['git -C rem/helper log -1', '', 'rrrr'],
  ['git fetch origin', 'rem/helper', 'aaaa'],
  ['git -C rem/rewrite fetch origin', '', 'aaaa'],
  ['git -C rem/rewrite fetch https://example.com/r.git', '', 'aaaa'],
  ['git -C rem/vcs fetch origin', '', 'rrrr'],
  ['git -C rem/vcs fetch upstream', '', 'aaaa'],
  ['git -C rem/vcs fetch --all', '', 'aaaa'],
  ['git -C rem/pushurl fetch origin', '', 'rrrr'],
  ['git -C rem/pushurl push origin main', '', 'aaaa'],
  ['git -C rem/plain fetch origin', '', 'rrrr'],
  ['git -C rem/plain fetch --all', '', 'rrrr'],
  ['git -C rem/vcs fetch https://example.com/r.git', '', 'aaaa'],
  ['git -C rem/vcs clone https://example.com/r.git cl10', '', 'aaaa'],
  ['git -C rem/group fetch --multiple grp', '', 'aaaa'],
  ['git -C rem/group remote update grp', '', 'aaaa'],
  ['git -C rem/group fetch grp', '', 'aaaa'],
  ['git -C rem/group fetch origin', '', 'rrrr'],
  ['git -C rem/branch fetch', '', 'aaaa'],
  ['git -C rem/branch pull', '', 'aaaa'],
  ['git -C rem/branch fetch origin', '', 'rrrr'],
  ['git -C rem/pushdefault push', '', 'aaaa'],
  ['git -C rem/tracked fetch', '', 'rrrr'],
  ['git -C rem/tracked pull', '', 'rrrr'],
  ['git -C rem/tracked push', '', 'rrrr'],
  ['echo foo::x | xargs git fetch', '', 'aaaa'],
  ['git -c remote.origin.url=foo::x fetch origin', '', 'aaaa'],
  ['git config url.foo::x.insteadOf https://example.com/ && git fetch https://example.com/r.git', '', 'aaaa'],
  ['git archive --remote=foo::x HEAD', '', 'aaaa'],
  ['git push --repo=foo::x', '', 'aaaa'],
  ['cp rem/helper/.git/config rem/plain/.git/config && git -C rem/plain fetch origin', '', 'aaaa'],
  ['export PATH="$PWD/ptools:$PATH" && git fetch origin', '', 'aaaa'],
  ['export PATH="$PWD/ptools:$PATH" && git submodule update --init', '', 'aaaa'],
  ['export PATH="$PWD/ptools:$PATH" && git log --format=%G? -1', '', 'aaaa'],
  ['export PATH="$PWD/ptools:$PATH" && git log -1 "$X"', '', 'aaaa'],
  ['export PATH="$PWD/ptools:$PATH" && git help commit', '', 'aaaa'],
  ['export PATH="$PWD/ptools:$PATH" && git log -1', '', 'arrr'],
  ['export PATH="$PWD/ptools:$PATH" && git help -a', '', 'arrr'],
  ['HOME=hm git status', '', 'aaaa'],
  ['HOME=hm2 git status', '', 'arrr'],
  ['XDG_CONFIG_HOME=xdg git log -1', '', 'aaaa'],
  ['XDG_CONFIG_HOME=xdg2 git log -1', '', 'aaaa'],
  ['export HOME=hm; git status', '', 'aaaa'],
  ['git status; export HOME=hm', '', 'arrr'],
  ['echo x > hm4/.gitconfig && HOME=hm4 git status', '', 'aaaa'],
  ['HOME="$(mktemp -d)" git status', '', 'aaaa'],
  ['HOME=hm2 git log --format=%G? -1', '', 'aaaa'],
  ['git status; export EDITOR=nano', '', 'arrr'],
  ['export GIT_EDITOR=nano; git commit -m x', '', 'arrr'],
  ['export GIT_EDITOR=nano; git commit --allow-empty', '', 'aaaa'],
  ['GIT_PAGER=./x.sh git log', '', 'arrr'],
  ['GIT_PAGER=./x.sh unbuffer git log', '', 'aaaa'],
  ['GIT_EDITOR=./x.sh git commit -- -mx', '', 'aaaa'],
  ['export GIT_EDITOR=./x.sh; git commit -- -mx', '', 'aaaa'],
  ['EDITOR=./x.sh git commit -- -mx', '', 'aaaa'],
  ['GIT_EDITOR=./x.sh git commit -a --trailer -mx', '', 'aaaa'],
  ['GIT_EDITOR=./x.sh git tag -a --trailer -mx v9', '', 'aaaa'],
  ['GIT_EDITOR=./x.sh git commit -a -m [+-]*', '', 'aaaa'],
  ['GIT_EDITOR=./x.sh git commit -a -m *', '', 'aaaa'],
  ['GIT_EDITOR=./x.sh git branch -*', '', 'aaaa'],
  ['GIT_EDITOR=./x.sh git add -*', '', 'aaaa'],
  ['GIT_EDITOR=./x.sh git commit -a -m x', '', 'arrr'],
  ['GIT_PAGER=./x.sh git log > /dev/ttys003', '', 'aaaa'],
  ['GIT_PAGER=./x.sh git log > /dev/ttyS0', '', 'aaaa'],
  ['GIT_PAGER=./x.sh git log > /dev/tty1', '', 'aaaa'],
  ['GIT_PAGER=./x.sh git log > o', 'ttr', 'aaaa'],
  ['GIT_PAGER=./x.sh git log > ./o', 'ttr', 'aaaa'],
  ['GIT_PAGER=./x.sh git log >> o', 'ttr', 'aaaa'],
  ['GIT_PAGER=./x.sh git log >| o', 'ttr', 'aaaa'],
  ['GIT_PAGER=./x.sh git log &> o', 'ttr', 'aaaa'],
  ['GIT_PAGER=./x.sh git log 1> o', 'ttr', 'aaaa'],
  ['git log > o', 'ttr', 'arar'],
  ['GIT_PAGER=./x.sh git log 01> o', 'ttr', 'aaaa'],
  ['GIT_PAGER=./x.sh git log 001> o', 'ttr', 'aaaa'],
  ['GIT_PAGER=./x.sh git log 02> o', 'ttr', 'aaaa'],
  ['git -C rem/shadow fetch origin', '', 'aaaa'],
  ['git -C rem/shadow fetch --all', '', 'aaaa'],
  ['git -C rem/nest fetch a', '', 'aaaa'],
  ['git -C rem/nest fetch origin', '', 'rrrr'],
  ['git -C rem/mixed fetch A.grp', '', 'aaaa'],
  ['git -C rem/mixed fetch a.grp', '', 'aaaa'],
  ['git -C rem/mixed fetch origin', '', 'rrrr'],
  ['git -C rem/group fetch GRP', '', 'aaaa'],
  ['GIT_PAGER=./x.sh git log >&2', '', 'aaaa'],
  ['export GIT_PAGER=./x.sh; exec > o; git log', 'ttr', 'aaaa'],
  ['{ GIT_PAGER=./x.sh git log; } > o', 'ttr', 'aaaa'],
  ['GIT_PAGER=./x.sh git log > /dev/null', '', 'arrr'],
  ['GIT_PAGER=./x.sh git log | head', '', 'arrr'],
  ['HOME+=/proj/hm git status', '', 'aaaa'],
  ['export HOME+=/proj/hm; git status', '', 'aaaa'],
  ['XDG_CONFIG_HOME+=/proj/xdg git status', '', 'aaaa'],
];

describe('shell approval of git programs, sourced files and fresh folders', () => {
  let base: string;
  let proj: string;
  let userData: string;
  let rules: PermissionRuleSet;
  let roots: readonly string[];

  const file = (path: string, text: string, mode = 0o644): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    chmodSync(path, mode);
  };

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'b4m-gitprog-')));
    const home = join(base, 'home');
    proj = join(home, 'proj');
    userData = join(home, '.config', 'Bike4Mind');
    mkdirSync(userData, { recursive: true });
    mkdirSync(join(proj, 'src'), { recursive: true });
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    };
    const git = (repo: string, ...args: string[]): void => {
      execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
        env,
      });
    };
    vi.stubEnv('HOME', home);
    vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));
    const repository = (dir: string, files: Record<string, string>): void => {
      for (const [name, text] of Object.entries(files)) file(join(dir, name), text);
      git(dir, 'init', '-q', '-b', 'main');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-qm', 'first');
      for (const [name, value] of [
        ['st', 'status'],
        ['lg', 'log --oneline'],
        ['co', 'checkout'],
        ['p', 'push'],
        ['bang', '!echo hi'],
      ]) {
        git(dir, 'config', `alias.${name}`, value);
      }
    };
    repository(proj, { 'src/a.ts': 'a', 'a.ts': 'a', '.gitignore': 'node_modules\ndist\n', 'dist/x.js': 'x' });
    git(proj, 'branch', 'other');
    repository(join(proj, 'lrepo'), { 'x.ts': 'x' });
    repository(join(proj, 'tpl'), { 'x.ts': 'x' });
    repository(join(proj, 'evil'), { 'x.ts': 'x' });
    repository(join(proj, 'srcrepo'), { 'git-st': '#!/bin/sh\n', 'git-hello': '#!/bin/sh\n' });
    repository(join(proj, 'srcrepo2'), { 'git-st': '#!/bin/sh\n', 'git-hello': '#!/bin/sh\n' });
    repository(join(proj, 'vend', 'lib'), { 'x.ts': 'x' });
    git(join(proj, 'vend', 'lib'), 'config', 'alias.st', '!touch MARK');
    repository(join(proj, 'bad'), { 'x.ts': 'x' });
    git(join(proj, 'bad'), 'config', 'alias.st', '!touch MARK');
    repository(join(proj, 'lib'), { 'x.ts': 'x' });
    repository(join(proj, 'd3', 'x', 'lib'), { 'x.ts': 'x' });
    mkdirSync(join(proj, 'elib'));
    mkdirSync(join(proj, 'pa', 'elib'), { recursive: true });
    repository(join(proj, 'outer'), { 'x.ts': 'x' });
    git(join(proj, 'outer'), 'config', 'alias.st', '!touch MARK');
    repository(join(proj, 'outer', 'lib'), { 'x.ts': 'x' });
    file(join(proj, 'evil', '.bin', 'git-st'), '#!/bin/sh\ntouch MARK\n', 0o755);
    file(join(proj, 'evil', '.bin', 'git-foo'), '#!/bin/sh\ntouch MARK\n', 0o755);
    file(join(proj, 'srcx', 'git-hello'), '#!/bin/sh\n', 0o755);
    mkdirSync(join(proj, 'sub', 'deep'), { recursive: true });
    symlinkSync('sub', join(proj, 'sublink'));
    file(join(proj, 'env1.sh'), 'export FOO=1\n');
    file(join(proj, 'env2.sh'), 'export GIT_EXEC_PATH="$PWD/xbin"\n');
    file(join(proj, 'env3.sh'), 'X=1\nY=2\n');
    file(join(proj, 'env5.sh'), 'X=1\n\\cd ..\n');
    file(join(proj, 'env6.sh'), "X=1\nc''d ..\n");
    file(join(proj, 'env7.sh'), 'export PATH="./pbin:$PATH"\n');
    file(join(proj, 'pbin', 'rm'), '#!/bin/sh\nexit 0\n', 0o755);
    file(
      join(proj, '.venv', 'bin', 'activate'),
      '# source bin/activate\nVIRTUAL_ENV=/x\nexport VIRTUAL_ENV\nPATH="$VIRTUAL_ENV/bin:$PATH"\nexport PATH\nhash -r 2> /dev/null\n'
    );
    file(
      join(proj, '.uvenv', 'bin', 'activate'),
      'deactivate () { :; }\nVIRTUAL_ENV=/x\nexport VIRTUAL_ENV\n_OLD_VIRTUAL_PATH="$PATH"\nPATH="$VIRTUAL_ENV/bin:$PATH"\nexport PATH\nhash -r 2> /dev/null\n'
    );
    file(join(proj, 'nbin', 'git-merge-foo'), '#!/bin/sh\nexit 1\n', 0o755);
    file(join(proj, 'nbin', 'git-remote-foo'), '#!/bin/sh\nexit 1\n', 0o755);
    file(join(proj, 'nbin', 'git-remote-HTTP'), '#!/bin/sh\nexit 1\n', 0o755);
    file(join(proj, 'nbin', 'git-remote-HTTPS'), '#!/bin/sh\nexit 1\n', 0o755);
    const ambient = (process.env.PATH ?? '').split(':').filter(entry => !entry.endsWith('node_modules/.bin'));
    const extbin = join(base, 'extbin');
    for (const name of ['git-ext', 'git-lfs']) file(join(extbin, name), '#!/bin/sh\nexit 0\n', 0o755);
    vi.stubEnv('PATH', ['nbin', extbin, ...ambient].join(':'));
    execFileSync('git', ['clone', '-q', '--bare', proj, join(proj, 'origin.git')], { env });
    execFileSync('git', ['clone', '-q', '--bare', proj, join(proj, 'blay', '.bare')], { env });
    file(join(proj, 'blay', '.git'), 'gitdir: ./.bare\n');
    execFileSync('git', ['clone', '-q', '--bare', proj, join(proj, 'gf', '.bare')], { env });
    git(join(proj, 'gf', '.bare'), 'config', 'alias.st', '!touch MARK');
    file(join(proj, 'gf', '.git'), 'gitdir: ./.bare\n');
    file(join(proj, 'tpl2', 'f'), 'f');
    for (const [name, settings] of Object.entries({
      helper: [['remote', 'add', 'origin', 'foo::x']],
      rewrite: [['config', 'url.foo::x.insteadOf', 'https://example.com/']],
      vcs: [['config', 'remote.upstream.vcs', 'svn']],
      pushurl: [['config', 'remote.origin.pushurl', 'foo::x']],
      plain: [['config', 'url.https://mirror.example.com/.insteadOf', 'https://example.com/']],
      group: [['config', 'remotes.grp', 'foo::x']],
      shadow: [['config', 'remotes.origin', 'origin foo::x']],
      nest: [
        ['config', 'remotes.a', 'b c'],
        ['config', 'remotes.b', 'foo::x foo::y'],
      ],
      mixed: [['config', 'remotes.A.grp', 'x foo::y']],
      branch: [['config', 'branch.main.remote', 'foo::x']],
      pushdefault: [['config', 'remote.pushDefault', 'foo::x']],
      tracked: [
        ['config', 'branch.main.remote', 'origin'],
        ['config', 'branch.main.merge', 'refs/heads/main'],
      ],
    })) {
      const dir = join(proj, 'rem', name);
      repository(dir, { 'x.ts': 'x' });
      if (name !== 'helper') git(dir, 'remote', 'add', 'origin', 'https://example.com/r.git');
      for (const args of settings) git(dir, ...args);
    }
    for (const name of ['ssh', 'gpg', 'man']) file(join(proj, 'ptools', name), '#!/bin/sh\nexit 0\n', 0o755);
    repository(join(proj, 'ttr'), { 'x.ts': 'x' });
    symlinkSync('/dev/tty', join(proj, 'ttr', 'o'));
    file(join(proj, 'hm', '.gitconfig'), '[core]\n\tfsmonitor = ./x.sh\n');
    file(join(proj, 'hm2', '.gitconfig'), '[user]\n\tname = x\n[color]\n\tui = never\n');
    file(join(proj, 'xdg', 'git', 'config'), '[core]\n\tpager = ./x.sh\n');
    file(join(proj, 'xdg2', 'git', 'config'), '[core]\n\tpager = cat\n');
    roots = permissionProtectedLocations(userData, home, join(base, 'managed'), { warn: () => {} }).paths();
    const compiled: CompiledRule[] = [];
    for (const program of [
      'git',
      'cp',
      'printf',
      'mkdir',
      'echo',
      'rsync',
      'mv',
      'rm',
      'ls',
      'cat',
      'source',
      '.',
      'npm',
      'pnpm',
      'npx',
      'touch',
      'ln',
      'vitest',
      'tsc',
      'eslint',
      'prettier',
    ]) {
      const parsed = parseRule(`Bash(${program}:*)`, { native: program === 'git' });
      if (!parsed.ok) throw new Error(parsed.reason);
      const rule = compileRule(parsed.rule, 'allow', { id: 't', label: 'T' }, { home, root: proj, cwd: proj });
      if (rule) compiled.push(rule);
    }
    rules = new PermissionRuleSet(compiled, () => roots);
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(base, { recursive: true, force: true });
  });

  let sessions = 0;
  const cells = async (command: string, folder: string): Promise<string> => {
    const cwd = join(proj, folder);
    const context = (sessionId?: string): ToolContext =>
      ({
        roots: [proj],
        workingDirectory: cwd,
        signal: new AbortController().signal,
        protectedPaths: [userData],
        uncoverablePaths: roots,
        ...(sessionId ? { sessionId } : {}),
      }) as ToolContext;
    const prompt = await shellApproval('bash_execute', { command, cwd }, context());
    // A session of its own per command, as one that wrote a `.git` makes git ask in every later command of it.
    const withSession = await shellApproval('bash_execute', { command, cwd }, context(`s${++sessions}`));
    const subject = await resolveSubject(
      permissionSubject({ name: 'bash_execute', input: { command } }, prompt, context())
    ).catch(() => null);
    const covered = subject !== null && rules.evaluate(subject).decision === 'allow';
    return [
      covered,
      runsCheckedInAuto(prompt),
      runsCheckedInAuto(withSession) && (withSession.always?.directories ?? []).length === 0,
      runsCheckedInFull(prompt),
    ]
      .map(run => (run ? 'r' : 'a'))
      .join('');
  };

  it.each(ROWS)('decides %s (in proj/%s) as %s', async (command, folder, expected) => {
    expect(await cells(command, folder)).toBe(expected);
  });

  // GIT_CELLS=<file> appends every row's current cells to that file, to compare two versions of the scan.
  it.runIf(Boolean(process.env.GIT_CELLS))('writes the cells of every row to GIT_CELLS', async () => {
    const lines: string[] = [];
    for (const [command, folder] of ROWS) lines.push([await cells(command, folder), folder, command].join('\t'));
    appendFileSync(process.env.GIT_CELLS as string, lines.map(line => `${JSON.stringify(line)}\n`).join(''));
  });

  describe('with globstar set in the shell environment', () => {
    beforeAll(() => {
      vi.stubEnv('BASHOPTS', 'globstar');
    });
    afterAll(() => {
      vi.stubEnv('BASHOPTS', undefined);
    });

    it.each(['rm -rf **/lib && mv bad d3/x/lib && git -C d3/x/lib st', 'rm -rf */lib && git st'])(
      'asks in every mode for %s',
      async command => {
        expect(await cells(command, '')).toBe('aaaa');
      }
    );
  });

  describe('with a relative node_modules/.bin folder on PATH', () => {
    let before: string | undefined;
    beforeAll(() => {
      before = process.env.PATH;
      vi.stubEnv('PATH', `./node_modules/.bin:${before}`);
    });
    afterAll(() => {
      vi.stubEnv('PATH', before);
    });

    it.each([
      ['rm -rf node_modules && git st', 'aaaa'],
      ['rm -rf node_modules && pnpm i && git st', 'aaaa'],
      ['mv node_modules nm.old && git st', 'aaaa'],
      ['rm -rf node_modules && mv evil node_modules && git st', 'aaaa'],
      ['mv node_modules nm.old && mv evil node_modules && git foo', 'aaaa'],
      ['rm -rf node_modules && ln -s evil node_modules && git st', 'aaaa'],
      ['rm -rf node_modules && mkdir -p node_modules/.bin && cp x node_modules/.bin/git-st && git st', 'aaaa'],
    ])('decides %s as %s', async (command, expected) => {
      expect(await cells(command, '')).toBe(expected);
    });
  });

  describe('with a project folder on PATH that the command fills', () => {
    let before: string | undefined;
    beforeAll(() => {
      before = process.env.PATH;
      vi.stubEnv('PATH', `ntools:${before}`);
    });
    afterAll(() => {
      vi.stubEnv('PATH', before);
    });

    it.each([
      'git clone srcrepo ntools && git hello',
      'git worktree add ntools -b y5 && git hello',
      'git clone srcrepo ntools && cd ntools && git st',
    ])('asks in every mode for %s', async command => {
      expect(await cells(command, '')).toBe('aaaa');
    });
  });

  describe.each([
    ['ntools2/bin', ['git clone srcrepo2 ntools2 && git hello', 'git worktree add ntools2 -b q2 && git hello']],
    ['ntools2/bin', ['cp -r srcrepo2 ntools2 && git hello']],
    [
      'ntools3/',
      [
        'git clone srcrepo ntools3 && git hello',
        'cp -r srcrepo ntools3 && git hello',
        'mv srcrepo ntools3 && git hello',
      ],
    ],
  ])('with PATH holding %s', (entry, commands) => {
    let before: string | undefined;
    beforeAll(() => {
      before = process.env.PATH;
      vi.stubEnv('PATH', `${join(proj, entry)}:${before}`);
    });
    afterAll(() => {
      vi.stubEnv('PATH', before);
    });

    it.each(commands)('asks in every mode for %s', async command => {
      expect(await cells(command, '')).toBe('aaaa');
    });
  });

  describe('with a process PATH entry ending in a doubled slash', () => {
    let before: string | undefined;
    beforeAll(() => {
      before = process.env.PATH;
      vi.stubEnv('PATH', `${proj}/ntools5//:${before}`);
    });
    afterAll(() => {
      vi.stubEnv('PATH', before);
    });

    it('asks in every mode for a program copied into the folder', async () => {
      expect(await cells('mkdir ntools5 && cp srcx/git-hello ntools5/ && git hello', '')).toBe('aaaa');
    });
  });

  describe('outside a repository', () => {
    const globalConfig = (): string => join(dirname(proj), '.gitconfig');

    it.each([
      ['git -C .. ls-remote https://example.com/r.git', '', 'rrrr'],
      ['git -C .. ls-remote up', '[remote "up"]\n\turl = foo::x\n', 'aaaa'],
      ['git -C .. ls-remote https://example.com/r.git', '[remote "origin"]\n\tvcs = svn\n', 'aaaa'],
    ])('decides %s with a user config of %j as %s', async (command, config, expected) => {
      file(globalConfig(), config);
      try {
        expect(await cells(command, '')).toBe(expected);
      } finally {
        rmSync(globalConfig(), { force: true });
      }
    });
  });

  describe('with a global init.templateDir', () => {
    const globalConfig = (): string => join(dirname(proj), '.gitconfig');

    const withTemplate = async (
      setting: string,
      files: Record<string, string>,
      command: string,
      folder = ''
    ): Promise<string> => {
      const template = join(base, 'template-files');
      rmSync(template, { recursive: true, force: true });
      for (const [name, text] of Object.entries(files)) file(join(template, name), text);
      file(globalConfig(), `[init]\n\ttemplateDir = ${setting.replaceAll('TEMPLATE', template)}\n`);
      try {
        return await cells(command, folder);
      } finally {
        rmSync(globalConfig(), { force: true });
        rmSync(template, { recursive: true, force: true });
      }
    };

    it.each([
      ['an included file holding a ! alias', '[include]\n\tpath = TEMPLATE/inc\n', 'aaaa'],
      ['an included file holding a plain alias', '[include]\n\tpath = TEMPLATE/inc2\n', 'rrrr'],
      ['a relative include of a file the template lacks', '[include]\n\tpath = elsewhere\n', 'aaaa'],
    ])('decides a clone then git st with a template config with %s as %s', async (_name, config, expected) => {
      const text = config.replaceAll('TEMPLATE', join(base, 'template-files'));
      const files = { config: text, inc: '[alias]\n\tst = !touch MARK\n', inc2: '[alias]\n\tst = status\n' };
      expect(await withTemplate('TEMPLATE', files, 'git clone origin.git clt && git -C clt st')).toBe(expected);
    });

    it.each([
      ['~/ with a ! alias', '~/tplhome', '[alias]\n\tst = !touch MARK\n', 'aaaa'],
      ['~/ with a plain alias', '~/tplhome', '[alias]\n\tst = status\n', 'rrrr'],
      ['~user/', '~someone/tplhome', '[alias]\n\tst = status\n', 'aaaa'],
    ])('decides a clone then git st with a templateDir of %s as %s', async (_name, setting, config, expected) => {
      const home = dirname(proj);
      rmSync(join(home, 'tplhome'), { recursive: true, force: true });
      file(join(home, 'tplhome', 'config'), config);
      try {
        expect(await withTemplate(setting, {}, 'git clone origin.git clt && git -C clt st')).toBe(expected);
      } finally {
        rmSync(join(home, 'tplhome'), { recursive: true, force: true });
      }
    });

    it('reads a relative templateDir from the folder git runs in', async () => {
      const inProj = join(proj, 'rel-template');
      file(join(inProj, 'config'), '[alias]\n\tst = !touch MARK\n');
      try {
        expect(await withTemplate('rel-template', {}, 'git clone origin.git sub/clt2 && git -C sub/clt2 st')).toBe(
          'aaaa'
        );
        expect(await withTemplate('rel-template', {}, 'git clone ../origin.git clt3 && git -C clt3 st', 'src')).toBe(
          'aaaa'
        );
      } finally {
        rmSync(inProj, { recursive: true, force: true });
      }
    });

    it.each([
      ['a template config holding a ! alias', '[alias]\n\tst = !touch MARK\n', 'aaaa'],
      ['a template config holding a plain alias', '[alias]\n\tst = status\n', 'rrrr'],
      ['a template config without aliases', '[core]\n\tfilemode = true\n', 'aaaa'],
      ['no template config', null, 'aaaa'],
    ])('decides a clone then git st with %s as %s', async (_name, config, expected) => {
      const template = join(base, 'template');
      rmSync(template, { recursive: true, force: true });
      mkdirSync(template, { recursive: true });
      if (config !== null) file(join(template, 'config'), config);
      file(globalConfig(), `[init]\n\ttemplateDir = ${template}\n`);
      try {
        expect(await cells('git clone origin.git clt && git -C clt st', '')).toBe(expected);
      } finally {
        rmSync(globalConfig(), { force: true });
      }
    });

    it.skipIf(process.getuid?.() === 0)('asks for a template config it cannot read', async () => {
      const template = join(base, 'template-locked');
      mkdirSync(template, { recursive: true });
      file(join(template, 'config'), '[core]\n\tfilemode = true\n', 0o000);
      file(globalConfig(), `[init]\n\ttemplateDir = ${template}\n`);
      try {
        expect(await cells('git clone origin.git clt && git -C clt st', '')).toBe('aaaa');
      } finally {
        rmSync(globalConfig(), { force: true });
      }
    });
  });

  describe('with signing or verifying config', () => {
    type Place = 'system' | 'global' | 'xdg' | 'repo' | 'worktree' | 'other' | 'inc';
    const placed: Record<Place, () => string> = {
      inc: () => join(dirname(proj), 'sign.inc'),
      system: () => join(base, 'system-gitconfig'),
      global: () => join(dirname(proj), '.gitconfig'),
      xdg: () => join(dirname(proj), '.config', 'git', 'config'),
      repo: () => join(proj, '.git', 'config'),
      worktree: () => join(proj, '.git', 'config.worktree'),
      other: () => join(proj, 'signrepo', '.git', 'config'),
    };

    beforeAll(() => {
      mkdirSync(join(proj, 'signrepo'), { recursive: true });
      execFileSync('git', ['-C', join(proj, 'signrepo'), 'init', '-q', '-b', 'main']);
    });

    afterAll(() => {
      rmSync(join(proj, 'signrepo'), { recursive: true, force: true });
    });

    /** `run` with each config text appended to its file, and `env` set; every file restored after. */
    const withConfigs = async <T>(
      configs: Partial<Record<Place, string>>,
      env: Record<string, string>,
      run: () => Promise<T>
    ): Promise<T> => {
      const saved = new Map<string, string | null>();
      for (const [place, text] of Object.entries(configs)) {
        const path = placed[place as Place]();
        const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
        saved.set(path, before);
        file(path, `${before ?? ''}${text}`);
      }
      if (configs.system !== undefined && env.GIT_CONFIG_SYSTEM === undefined) {
        env = { ...env, GIT_CONFIG_SYSTEM: placed.system() };
      }
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
      try {
        return await run();
      } finally {
        for (const name of Object.keys(env)) vi.stubEnv(name, undefined);
        for (const [path, before] of saved) {
          if (before === null) rmSync(path, { force: true });
          else file(path, before);
        }
      }
    };

    /** The cells of `command` under `withConfigs`. */
    const configured = (
      configs: Partial<Record<Place, string>>,
      command: string,
      env: Record<string, string> = {}
    ): Promise<string> => withConfigs(configs, env, () => cells(command, ''));

    it.each([
      ['git stash list', '[log]\nshowSignature = true\n'],
      ["git log --format='%+G?'", '[log]\nshowSignature = false\n[gpg]\nprogram = /test-only-verifier\n'],
      ["git for-each-ref --format='%(*signature:grade)'", ''],
      ['git log --pretty=SIG.foo', '[pretty "SIG"]\nfoo = format:%G?\n[pretty "sig"]\nfoo = format:%h\n'],
      ['git log --pretty=alias', '[pretty]\nalias = other\nother = format:%-GS\n'],
    ])('requires a real whole-script signing approval for %s', async (command, config) => {
      await withConfigs({ repo: config }, {}, async () => {
        const context = { roots: [proj], workingDirectory: proj, signal: new AbortController().signal };
        const prompt = await shellApproval('bash_execute', { command, cwd: proj }, context);
        expect(prompt.askInAuto).toBe(true);
        expect(prompt.askInFull).toBe(true);
        expect(prompt.byPart).not.toBe(true);
        expect(prompt.allowOnce).toBe(true);
        const subject = await resolveSubject(
          permissionSubject({ name: 'bash_execute', input: { command } }, prompt, context)
        );
        expect(rules.evaluate(subject).decision).not.toBe('allow');
      });
    });

    it.each([
      'git log --pretty=oneline',
      'git log --format=%h',
      'git log --pretty=%G? --format=%h',
      "git log --format='%%G?'",
      "git log --format='%%%%G?'",
      "git log --format='%x25G?'",
      "git for-each-ref --format='%%(*signature:grade)'",
      "git for-each-ref --format='%(contents:signature)'",
      'git stash list',
    ])('keeps an explicit literal or built-in safe format available: %s', async command => {
      await withConfigs(
        { repo: '[log]\nshowSignature = false\n[format]\npretty = %G?\n[pretty]\noneline = format:%G?\n' },
        {},
        async () => {
          const prompt = await shellApproval(
            'bash_execute',
            { command, cwd: proj },
            { roots: [proj], workingDirectory: proj, signal: new AbortController().signal }
          );
          expect(prompt.askInFull).not.toBe(true);
          expect(prompt.allowOnce).not.toBe(true);
        }
      );
    });

    const SIGN = '[commit]\n\tgpgsign = true\n';
    const UNSIGN = '[commit]\n\tgpgsign = false\n';
    // The cells the command has with no signing config anywhere.
    const SAME = 'same';
    const cellsOf = async (expected: string, command: string): Promise<string> =>
      expected === SAME ? configured({}, command) : expected;

    it.each([
      ['git commit -m x', 'rrrr'],
      ['git log --oneline -5', 'rrrr'],
      ['git tag v9', 'rrrr'],
      ['git merge other', 'rrrr'],
    ])('decides %s with no signing config as %s', async (command, expected) => {
      expect(await configured({}, command)).toBe(expected);
    });

    it.each([
      ['system', { system: SIGN }],
      ['global', { global: SIGN }],
      ['xdg', { xdg: SIGN }],
      ['repo', { repo: SIGN }],
      ['worktree with the extension on', { repo: '[extensions]\n\tworktreeConfig = true\n', worktree: SIGN }],
    ] as [string, Partial<Record<Place, string>>][])(
      'asks for git commit with commit.gpgsign set in the %s config',
      async (_name, configs) => {
        expect(await configured(configs, 'git commit -m x')).toBe('aaaa');
        expect(await configured(configs, 'git status')).toBe('rrrr');
      }
    );

    it.each([
      ['worktree without the extension', { worktree: SIGN }],
      ['system with GIT_CONFIG_NOSYSTEM', { system: SIGN }, { GIT_CONFIG_NOSYSTEM: '1' }],
      ['global, turned off in the repo', { global: SIGN, repo: UNSIGN }],
      ['xdg, turned off in the global', { xdg: SIGN, global: UNSIGN }],
      ['system, turned off in the xdg', { system: SIGN, xdg: UNSIGN }],
      ['repo, turned off in the worktree', { repo: `${SIGN}[extensions]\n\tworktreeConfig\n`, worktree: UNSIGN }],
      ['a subsection', { repo: '[commit "x"]\n\tgpgsign = true\n' }],
      ['another key', { repo: '[commit]\n\tgpgsignx = true\n' }],
      ['a repository the call does not use', { other: SIGN }],
    ] as [string, Partial<Record<Place, string>>, Record<string, string>?][])(
      'runs git commit with commit.gpgsign set in the %s',
      async (_name, configs, env) => {
        expect(await configured(configs, 'git commit -m x', env)).toBe('rrrr');
      }
    );

    it.each([
      ['global, turned on in the repo', { global: UNSIGN, repo: SIGN }],
      ['global, over the xdg', { xdg: UNSIGN, global: SIGN }],
    ] as [string, Partial<Record<Place, string>>][])(
      'asks for git commit with commit.gpgsign set in the %s',
      async (_name, configs) => {
        expect(await configured(configs, 'git commit -m x')).toBe('aaaa');
      }
    );

    it.each(['true', 'TRUE', 'yes', 'On', '1', '"true"', 'tr\\"ue'])(
      'asks for git commit with commit.gpgsign = %s',
      async value => {
        expect(await configured({ repo: `[commit]\n\tgpgsign = ${value}\n` }, 'git commit -m x')).toBe('aaaa');
      }
    );

    it.each(['false', 'FALSE', 'no', 'Off', '0', '""', ''])('runs git commit with commit.gpgsign = %j', async value => {
      expect(await configured({ repo: `[commit]\n\tgpgsign = ${value}\n` }, 'git commit -m x')).toBe('rrrr');
    });

    it.each([
      ['a bare key', '[commit]\n\tgpgsign\n'],
      ['any letter case', '[COMMIT]\n\tGpgSign = yes\n'],
      ['a trailing comment', '[commit]\n\tgpgsign = true # signed\n'],
      ['a continued line', '[commit]\n\tgpgsign = tr\\\nue\n'],
    ])('asks for git commit with commit.gpgsign set by %s', async (_name, text) => {
      expect(await configured({ global: text }, 'git commit -m x')).toBe('aaaa');
    });

    it.each([
      ['git commit --no-gpg-sign -m x', SAME],
      ['git -c commit.gpgsign=false commit -m x', SAME],
      ['git -c commit.gpgsign=no -c commit.gpgsign=off commit -m x', SAME],
      ['git -c commit.gpgsign= commit -m x', SAME],
      ['git -c commit.gpgsign=false -c commit.gpgsign=true commit -m x', 'aaaa'],
      ['git merge other', 'aaaa'],
      ['git merge --no-gpg-sign other', SAME],
      ['git merge --abort', SAME],
      ['git rebase main', 'aaaa'],
      ['git rebase --no-gpg-sign main', SAME],
      ['git rebase --abort', SAME],
      ['git cherry-pick other', 'aaaa'],
      ['git revert --no-edit HEAD', 'aaaa'],
      ['git pull origin main', 'aaaa'],
      ['git pull --no-gpg-sign origin main', SAME],
      ['git commit-tree -m x HEAD^{tree}', SAME],
      ['git commit-tree -S -m x HEAD^{tree}', 'aaaa'],
      ['git commit-tree --no-gpg-sign -m x HEAD^{tree}', SAME],
      ['git -C signrepo commit -m x', SAME],
      ['git --git-dir=signrepo/.git commit -m x', SAME],
      ['git status', SAME],
      ['git log --oneline -5', SAME],
      ['git stash', SAME],
    ])('with commit.gpgsign on in the repo, decides %s as %s', async (command, expected) => {
      expect(await configured({ repo: SIGN }, command)).toBe(await cellsOf(expected, command));
    });

    it.each([
      ['git -C signrepo commit -m x', 'aaaa'],
      ['git -C signrepo log -1', 'rrrr'],
      ['git --git-dir=signrepo/.git commit -m x', 'aaaa'],
      ['git --git-dir signrepo/.git commit -m x', 'aaaa'],
      ['git -C src --git-dir=../signrepo/.git commit -m x', 'aaaa'],
      ['git commit -m x', 'rrrr'],
    ])('with commit.gpgsign on in another repository, decides %s as %s', async (command, expected) => {
      expect(await configured({ other: SIGN }, command)).toBe(expected);
    });

    it.each([
      ['[tag]\n\tgpgSign = true\n', 'git tag v9', 'aaaa'],
      ['[tag]\n\tgpgSign = true\n', 'git tag -m x v9', 'aaaa'],
      ['[tag]\n\tgpgSign = true\n', 'git tag', 'rrrr'],
      ['[tag]\n\tgpgSign = true\n', 'git tag -l', 'rrrr'],
      ['[tag]\n\tgpgSign = true\n', 'git tag -d v9', 'rrrr'],
      ['[tag]\n\tgpgSign = true\n', 'git -c tag.gpgsign=false tag v9', SAME],
      ['[tag]\n\tforceSignAnnotated = true\n', 'git tag -m x v9', 'aaaa'],
      ['[tag]\n\tforceSignAnnotated = true\n', 'git tag --message=x v9', 'aaaa'],
      ['[tag]\n\tforceSignAnnotated = true\n', 'git tag -F msg v9', 'aaaa'],
      ['[tag]\n\tforceSignAnnotated = true\n', 'git tag --no-annotate -m x v9', 'aaaa'],
      ['[tag]\n\tforceSignAnnotated = true\n', 'git tag -a -m x v9', 'rrrr'],
      ['[tag]\n\tforceSignAnnotated = true\n', 'git tag -a v9', 'rrrr'],
      ['[tag]\n\tforceSignAnnotated = true\n', 'git tag --annotate -m x v9', 'rrrr'],
      ['[tag]\n\tforceSignAnnotated = true\n', 'git tag --trailer a:b v9', 'aaaa'],
      ['[tag]\n\tforceSignAnnotated = true\n', 'git tag --trailer=a:b v9', 'aaaa'],
      ['[tag]\n\tforceSignAnnotated = true\n', 'git tag -e v9', 'aaaa'],
      ['[tag]\n\tforceSignAnnotated = true\n', 'git tag --edit v9', 'aaaa'],
      ['[tag]\n\tforceSignAnnotated = true\n', 'git tag -a --trailer a:b v9', 'rrrr'],
      ['[tag]\n\tforceSignAnnotated = true\n', 'git tag --annotate --trailer=a:b v9', 'rrrr'],
      ['[tag]\n\tforceSignAnnotated = true\n', 'git tag -a --no-annotate --trailer a:b v9', 'aaaa'],
      ['[tag]\n\tforceSignAnnotated = true\n', 'git tag --trailer a:b --no-annotate v9', 'aaaa'],
      ['[tag]\n\tforceSignAnnotated = true\n', 'git tag --cleanup=strip v9', 'rrrr'],
      ['[tag]\n\tforceSignAnnotated = true\n', 'git tag --create-reflog v9', 'rrrr'],
      ['[tag]\n\tgpgSign = true\n', 'git tag -a --trailer a:b v9', 'aaaa'],
      ['[tag]\n\tforceSignAnnotated = true\n', 'git tag -s -m x v9', 'aaaa'],
      ['[tag]\n\tforceSignAnnotated = true\n', 'git tag v9', 'rrrr'],
      ['[tag]\n\tgpgSign = true\n', 'git tag -a v9', 'aaaa'],
      ['[tag]\n\tgpgSign = true\n', 'git tag -a -m x v9', 'aaaa'],
      ['[tag]\n\tgpgSign = true\n', 'git tag -s v9', 'aaaa'],
      ['[push]\n\tgpgSign = true\n', 'git push origin main', 'aaaa'],
      ['[push]\n\tgpgSign = if-asked\n', 'git push origin main', 'aaaa'],
      ['[push]\n\tgpgSign = false\n', 'git push origin main', SAME],
      ['[push]\n\tgpgSign = if-asked\n', 'git push --no-signed origin main', SAME],
      ['[log]\n\tshowSignature = true\n', 'git log --oneline -5', 'aaaa'],
      ['[log]\n\tshowSignature = true\n', 'git show HEAD', 'aaaa'],
      ['[log]\n\tshowSignature = true\n', 'git reflog', 'aaaa'],
      ['[log]\n\tshowSignature = true\n', 'git range-diff HEAD~1 HEAD HEAD', 'aaaa'],
      ['[log]\n\tshowSignature = true\n', 'git status', 'rrrr'],
      ['[log]\n\tshowSignature = true\n', 'git diff', 'rrrr'],
      ['[log]\n\tshowSignature = true\n', 'git commit -m x', 'rrrr'],
      ['[log]\n\tshowSignature = false\n', 'git log --oneline -5', 'rrrr'],
      ['[merge]\n\tverifySignatures = true\n', 'git merge other', 'aaaa'],
      ['[merge]\n\tverifySignatures = true\n', 'git merge --no-verify-signatures other', SAME],
      ['[merge]\n\tverifySignatures = true\n', 'git pull origin main', 'aaaa'],
    ])('with %j in the global config, decides %s as %s', async (text, command, expected) => {
      expect(await configured({ global: text }, command)).toBe(await cellsOf(expected, command));
    });

    it('asks for git log with log.showSignature set in the xdg config', async () => {
      expect(await configured({ xdg: '[log]\n\tshowSignature = true\n' }, 'git log -1')).toBe('aaaa');
    });

    const INCLUDE = (): string => `[include]\n\tpath = ${placed.inc()}\n`;
    const INCLUDE_IF = (condition: () => string) => (): string =>
      `[includeIf "${condition()}"]\n\tpath = ${placed.inc()}\n`;
    const REPO_GITDIR = (): string => `gitdir:${join(proj, '.git')}`;

    it.each([
      ['an include of a file that turns it on', INCLUDE, SIGN, 'aaaa'],
      ['an include of a file that turns it off', INCLUDE, UNSIGN, 'rrrr'],
      ['an include of a file that is not there', () => `[include]\n\tpath = ${placed.inc()}.none\n`, SIGN, 'rrrr'],
      ['an includeIf gitdir that matches, turning it on', INCLUDE_IF(REPO_GITDIR), SIGN, 'aaaa'],
      ['an includeIf gitdir that matches, turning it off', INCLUDE_IF(REPO_GITDIR), UNSIGN, 'rrrr'],
      ['an includeIf gitdir that does not match', INCLUDE_IF(() => 'gitdir:/nowhere/'), SIGN, 'rrrr'],
      ['an includeIf onbranch that does not match', INCLUDE_IF(() => 'onbranch:nowhere'), SIGN, 'rrrr'],
    ])('with %s in the global config, decides git commit as %s', async (_name, text, included, expected) => {
      expect(await configured({ global: text(), inc: included }, 'git commit -m x')).toBe(expected);
      expect(await configured({ global: text(), inc: included }, 'git diff')).toBe('rrrr');
    });

    it.each(['xdg', 'repo', 'system'] as Place[])(
      'asks for git commit with an include of a signing file in the %s config',
      async place => {
        expect(await configured({ [place]: INCLUDE(), inc: SIGN }, 'git commit -m x')).toBe('aaaa');
        expect(await configured({ [place]: INCLUDE(), inc: UNSIGN }, 'git commit -m x')).toBe('rrrr');
        expect(
          await configured({ [place]: INCLUDE_IF(() => 'gitdir:/nowhere/')(), inc: SIGN }, 'git commit -m x')
        ).toBe('rrrr');
      }
    );

    it('asks for signing forms only with a parse error in the global config', async () => {
      expect(await configured({ global: '[commit\n' }, 'git commit -m x')).toBe('aaaa');
      expect(await configured({ global: '[commit\n' }, 'git log -1')).toBe('aaaa');
      expect(await configured({ global: '[commit\n' }, 'git diff')).toBe('rrrr');
    });

    it('asks for a signing form with a value git cannot read as a boolean', async () => {
      expect(await configured({ global: '[commit]\n\tgpgsign = maybe\n' }, 'git commit -m x')).toBe('aaaa');
      expect(await configured({ global: '[log]\n\tshowSignature = maybe\n' }, 'git commit -m x')).toBe('aaaa');
    });

    it.skipIf(process.getuid?.() === 0)('runs git commit with a global config git skips as unreadable', async () => {
      const global = placed.global();
      file(global, SIGN, 0o000);
      try {
        expect(await cells('git commit -m x', '')).toBe('rrrr');
      } finally {
        rmSync(global, { force: true });
      }
    });

    it.skipIf(process.getuid?.() === 0)(
      'asks for signing forms only with an included file it cannot read',
      async () => {
        const included = placed.inc();
        file(included, SIGN, 0o000);
        file(placed.global(), INCLUDE());
        try {
          expect(await cells('git commit -m x', '')).toBe('aaaa');
          expect(await cells('git log -1', '')).toBe('aaaa');
          expect(await cells('git diff', '')).toBe('rrrr');
        } finally {
          rmSync(placed.global(), { force: true });
          rmSync(included, { force: true });
        }
      }
    );

    it('asks for a commit whose included file is a folder', async () => {
      const included = placed.inc();
      mkdirSync(included);
      file(placed.global(), INCLUDE());
      try {
        expect(await cells('git commit -m x', '')).toBe('aaaa');
      } finally {
        rmSync(placed.global(), { force: true });
        rmSync(included, { recursive: true, force: true });
      }
    });

    it.each([
      'git -C newdir commit -m x',
      'git -C newdir log -1',
      'git -C ../newdir commit -m x',
      'git --git-dir=newdir/.git commit -m x',
    ])('asks for %s whose folder is not made yet, whatever the config', async command => {
      expect(await configured({}, command)).toBe('aaaa');
      expect(await configured({ global: SIGN }, command)).toBe('aaaa');
      expect(await configured({ repo: SIGN, global: UNSIGN }, command)).toBe('aaaa');
      expect(await configured({ repo: UNSIGN, global: SIGN }, command)).toBe('aaaa');
    });

    it('still runs a call whose folder is not made yet when it is no signing form', async () => {
      expect(await configured({ repo: SIGN }, 'git -C newdir status')).toBe('rrrr');
    });

    /** Whether the last command of `command` asks because the scan does not list its form, and the reason shown. */
    const lastAsked = async (command: string): Promise<{ asked: boolean; detail: string }> => {
      const context = {
        roots: [proj],
        workingDirectory: proj,
        signal: new AbortController().signal,
        protectedPaths: [userData],
        uncoverablePaths: roots,
      } as ToolContext;
      const prompt = await shellApproval('bash_execute', { command, cwd: proj }, context);
      const sub =
        command
          .split(/;|&&|&|\|/)
          .at(-1)
          ?.trim()
          .split(' ')[1] ?? '';
      const reason = new RegExp(`does not list as safe[^]*(\\(|, )git ${sub} (after|with)`);
      return { asked: Boolean(prompt.askInAuto) && reason.test(prompt.detail), detail: prompt.detail };
    };

    // Writes that ask whatever the config holds: a key under a signing or include section, or one the scan cannot read.
    const AFTER_CONFIG = [
      'git config x y',
      'git config commit.gpgsign true',
      'git config --global tag.gpgSign true',
      'git config Commit.GpgSign false',
      'git config --unset commit.gpgsign',
      'git config --unset-all merge.verifysignatures',
      'git config unset log.showSignature',
      'git config set push.gpgsign true',
      'git config --add include.path x',
      'git config --replace-all includeIf.gitdir:/a/.path x',
      'git config format.pretty %G?',
      'git config pretty.sig %G?',
      'git config gpg.program x',
      'git config gpg.ssh.program x',
      'git config remote.origin.url x',
      'git config remote.origin.pushurl x',
      'git config REMOTE.origin.URL x',
      'git config -f other.cfg user.name y',
      'git config --file other.cfg --unset x',
      'git config --blob HEAD:cfg user.name y',
      'git config --remove-section x',
      'git config --rename-section x y',
      'git config remove-section x',
      'git config rename-section x y',
      'git config -e',
      'git config --edit',
      'git config $key v',
      'git config user.name $v',
      'git config "user.$k" v',
      'git config --unset',
    ];
    // Writes of other keys leave what a signing query reads as it is.
    const AFTER_PLAIN_CONFIG = [
      'git config user.name x',
      'git config user.email a@b',
      'git config --global user.name x',
      'git config --unset user.name',
      'git config --unset-all core.hooksPath',
      'git config unset user.name',
      'git config set user.email a@b',
      'git config --add safe.directory /x',
      'git config --replace-all user.name y',
      'git config core.autocrlf false',
      'git config --local color.ui never',
      'git config user.signingkey ABC',
    ];
    const AFTER_REPO = ['git init', 'git init sub', 'git init -q sub', 'git clone origin.git cl'];
    const AFTER_BRANCH = [
      'git switch topic',
      'git switch -c n',
      'git checkout topic',
      'git checkout -b n',
      'git checkout .',
      'git checkout main -- src/a.ts',
      'git checkout HEAD~1 -- .',
      'git branch -m x',
      'git branch -M x',
      'git branch -c x',
      'git branch -C x',
      'git branch -mf x',
      'git branch --move x',
      'git branch --copy x',
      'git rebase main',
      'git bisect start',
      'git stash branch n',
      'git symbolic-ref HEAD refs/heads/x',
    ];
    // A checkout of paths leaves HEAD where it is.
    const AFTER_PATHS = [
      'git checkout -- src/a.ts',
      'git checkout -- .',
      'git checkout -q -- a.ts',
      'git checkout -f -- a.ts',
    ];
    const AFTER_OTHER = [
      'git worktree add ../w',
      'git remote add o https://example.com/r.git',
      'git remote set-url origin x',
    ];
    const AFTER_FOLDER = [
      'mkdir n && cd n',
      'mkdir -p n/m && cd n/m',
      'git clone origin.git cl && cd cl',
      'git init sub && cd sub',
    ];
    const LASTS = ['git commit -m x', 'git log -1', 'git merge other', 'git tag v9', 'git push origin main'];

    /** Whether the last command of `script` asks as a form Desktop does not list, under `withConfigs`. */
    const askedWith = (configs: Partial<Record<Place, string>>, script: string): Promise<boolean> =>
      withConfigs(configs, {}, async () => (await lastAsked(script)).asked);

    it.each(LASTS)('asks for %s after a config write it cannot rule out, a work tree or a remote added', async last => {
      for (const first of [...AFTER_CONFIG, ...AFTER_OTHER]) {
        for (const joiner of [';', '&&']) {
          const found = await lastAsked(`${first} ${joiner} ${last}`);
          expect(found.asked, `${first} ${joiner} ${last}`).toBe(true);
        }
      }
      expect((await lastAsked(last)).asked).toBe(false);
    });

    // A push asks for contacting a remote whatever precedes it.
    it.each(LASTS.slice(0, 4))(
      'does not ask for %s after a statement that leaves what it reads as it is',
      async last => {
        for (const first of [
          ...AFTER_PLAIN_CONFIG,
          ...AFTER_PATHS,
          ...AFTER_BRANCH,
          ...AFTER_REPO,
          'git switch -c feat && git add -A',
          'git checkout -b x',
          'git rebase main',
          'git clone origin.git cl && cd cl',
        ]) {
          for (const joiner of first.includes('cd ') ? ['&&'] : [';', '&&']) {
            const found = await lastAsked(`${first} ${joiner} ${last}`);
            expect(found.asked, `${first} ${joiner} ${last}`).toBe(false);
          }
        }
      }
    );

    it.each([
      'git switch -c feat && git add -A && git commit -m x',
      'git checkout -b x && git commit -m x',
      'git init && git add . && git commit -m init',
      'git checkout -- a.ts && git commit -m x',
      'git config user.email a@b && git commit -m x',
      'git rebase main && git commit -m x',
      'git clone origin.git cl && cd cl && git log -1',
    ])('runs %s with no signing config', async script => {
      expect((await lastAsked(script)).asked, script).toBe(false);
      expect((await configured({}, script))[1], script).toBe('r');
    });

    it('runs a push after a rebase with no signing config, and asks with push.gpgSign on', async () => {
      expect((await lastAsked('git rebase main && git push')).asked).toBe(false);
      expect(await askedWith({ global: '[push]\n\tgpgSign = true\n' }, 'git rebase main && git push')).toBe(true);
    });

    it.each([
      'git config --get x',
      'git config --get-all x',
      'git config x',
      'git config get x',
      'git config list',
      'git config --list',
      'git config -l',
      'git branch x',
      'git branch -d x',
      'git branch -a',
      'git branch -vv',
      'git branch --contains HEAD',
      'git worktree list',
      'git stash',
      'git status',
      'git fetch origin',
      'mkdir -p src',
      'cd src',
      'cd .',
    ])('does not ask for git commit after %s', async first => {
      for (const joiner of [';', '&&']) {
        expect((await lastAsked(`${first} ${joiner} git commit -m x`)).asked, first).toBe(false);
      }
    });

    it('does not ask for a signing form that runs before the statement that changes the config', async () => {
      expect((await lastAsked('git commit -m x; git switch topic')).asked).toBe(false);
      expect((await lastAsked('git log -1; git config x y; git status')).asked).toBe(false);
    });

    it('asks for a signing form in a loop, an if or a function body that changes the config after it', async () => {
      for (const script of [
        'for i in 1 2; do git commit -m x; git switch topic; done',
        'while true; do git log -1; git config x y; done',
        'if true; then git commit -m x; git init sub; fi',
        'f() { git commit -m x; git checkout topic; }; f',
        'git commit -m x & git switch topic',
        'git switch topic | git commit -m x',
      ]) {
        expect(await cells(script, ''), script).toMatch(/^.a.a$/);
      }
    });

    it('names the earlier change in the reason', async () => {
      expect((await lastAsked('git config x y; git commit -m x')).detail).toContain(
        'after a config, repository, branch or folder change in the same script'
      );
      expect(
        (await withConfigs({ global: ONBRANCH }, {}, () => lastAsked('git switch topic; git commit -m x'))).detail
      ).toContain('after a branch change in the same script with an includeIf onbranch config');
    });

    const ONBRANCH = '[includeIf "onbranch:topic"]\n\tpath = /dev/null\n';
    const ONGITDIR = '[includeIf "gitdir:../"]\n\tpath = /dev/null\n';

    it.each([
      ['[includeIf "onbranch:topic"]\n\tpath = PATH\n', 'git switch topic', 'git commit -m x'],
      ['[includeIf "onbranch:topic"]\n\tpath = PATH\n', 'git checkout topic', 'git log -1'],
      ['[includeIf "gitdir:../"]\n\tpath = PATH\n', 'git init sub', 'git commit -m x'],
    ])('asks after the switch or init that an includeIf in %j depends on', async (text, first, last) => {
      const global = text.replace('PATH', placed.inc());
      expect(await configured({ global, inc: SIGN }, last)).toBe('rrrr');
      expect(await configured({ global, inc: SIGN }, `${first} && ${last}`)).toBe('aaaa');
    });

    describe('after a branch change', () => {
      it.each(LASTS)('asks for %s only with an includeIf onbranch in the config', async last => {
        for (const first of AFTER_BRANCH) {
          const script = `${first} && ${last}`;
          expect(await askedWith({}, script), `${script} with none`).toBe(false);
          expect(await askedWith({ global: ONGITDIR }, script), `${script} with gitdir`).toBe(false);
          for (const configs of [
            { global: ONBRANCH },
            { xdg: ONBRANCH },
            { repo: ONBRANCH },
            { system: ONBRANCH },
            { global: `[include]\n\tpath = ${placed.inc()}\n`, inc: ONBRANCH },
            {
              global:
                '[includeIf "onbranch:never"]\n\tpath = /dev/null\n[includeIf "onbranch:*"]\n\tpath = /dev/null\n',
            },
          ] as Partial<Record<Place, string>>[]) {
            expect(await askedWith(configs, script), `${script} with ${JSON.stringify(configs)}`).toBe(true);
          }
        }
      });

      it('reads the includeIf keys of the call, not the script alone', async () => {
        const script = 'git switch topic && git -c includeIf.onbranch:x.path=/dev/null commit -m x';
        expect(await configured({}, script)).toBe('aaaa');
        expect((await lastAsked('git switch topic && git -c user.name=x commit -m x')).asked).toBe(false);
      });

      it('asks when the includeIf key cannot be read', async () => {
        expect(await configured({ global: '[includeIf "onbranch:x"\n' }, 'git switch topic && git commit -m x')).toBe(
          'aaaa'
        );
      });

      it('runs a signing form after a checkout of paths whatever the config', async () => {
        for (const script of AFTER_PATHS) {
          expect(await askedWith({ global: ONBRANCH }, `${script} && git commit -m x`), script).toBe(false);
        }
      });

      it('asks for a signing form that a branch change in a loop or background can reach', async () => {
        for (const script of ['git commit -m x & git switch topic', 'git switch topic | git commit -m x']) {
          expect(await configured({ global: ONBRANCH }, script), script).toMatch(/^.a.a$/);
        }
        // A loop or a background command is asked about whatever the config holds.
        expect(await configured({}, 'for i in 1 2; do git commit -m x; git switch topic; done')).toBe('aaaa');
        expect(await configured({}, 'git commit -m x & git switch topic')).toBe('aaaa');
      });
    });

    describe('after a repository is made or a folder entered that is not there yet', () => {
      const PLACES = [...AFTER_REPO, ...AFTER_FOLDER];
      const TEMPLATE = '[init]\n\ttemplateDir = /dev/null\n';

      it.each(['git commit -m x', 'git log -1', 'git merge other', 'git tag v9'])(
        'asks for %s only when the new repository could read other config',
        async last => {
          for (const first of PLACES) {
            const script = first.includes('cd ') ? `${first} && ${last}` : `${first}; ${last}`;
            expect(await askedWith({}, script), `${script} with none`).toBe(false);
            // The config of the repository around a new one is not read by it.
            expect(await askedWith({ repo: ONGITDIR }, script), `${script} with a repo includeIf`).toBe(false);
            for (const configs of [
              { global: ONGITDIR },
              { xdg: ONGITDIR },
              { global: ONBRANCH },
              { global: TEMPLATE },
              { xdg: TEMPLATE },
              { global: '[includeIf "hasconfig:remote.*.url:*"]\n\tpath = /dev/null\n' },
            ] as Partial<Record<Place, string>>[]) {
              expect(await askedWith(configs, script), `${script} with ${JSON.stringify(configs)}`).toBe(true);
            }
          }
        }
      );

      it('reads the signing settings of the new repository from the user and system config alone', async () => {
        const unsigned = { global: SIGN, repo: UNSIGN };
        expect(await configured(unsigned, 'git commit -m x')).toBe('rrrr');
        for (const script of [
          'git init sub && git -C sub commit -m x',
          'git init sub; git -C sub commit -m x',
          'git clone signrepo copy && cd copy && git commit -m x',
          'mkdir n && cd n && git init && git commit -m x',
          'cd newdir && git commit -m x',
        ]) {
          expect(await configured(unsigned, script), script).toMatch(/^.a/);
        }
        for (const configs of [{ system: SIGN }, { xdg: SIGN }, { global: SIGN }] as Partial<Record<Place, string>>[]) {
          expect(await configured({ ...configs, repo: UNSIGN }, 'git init sub && git -C sub commit -m x')).toMatch(
            /^.a/
          );
        }
        expect(await configured({ repo: SIGN }, 'git init sub && git -C sub commit -m x')).toMatch(/^.a/);
        expect(await configured({ global: UNSIGN, repo: SIGN }, 'mkdir n && cd n && git commit -m x')).toMatch(/^.a/);
      });

      it('runs a new repository with the user config as it is when it does not sign', async () => {
        expect(await configured({}, 'git init sub && git -C sub commit -m x')).toMatch(/^.r/);
        expect(await configured({ global: UNSIGN, repo: SIGN }, 'git init sub && git -C sub commit -m x')).toMatch(
          /^.a/
        );
        expect(await configured({ global: UNSIGN, repo: SIGN }, 'git init sub && git -C sub log -1')).toMatch(/^.r/);
        expect(await configured({ global: UNSIGN }, 'git init sub && git -C sub commit -m x')).toMatch(/^.r/);
      });

      it('asks for a template, a -c, a git dir or an environment that gives the new repository config', async () => {
        for (const script of [
          'git init --template=tpl2 sub && git -C sub commit -m x',
          'git init --template tpl2 sub && git -C sub commit -m x',
          'git clone --template=tpl2 signrepo copy && git -C copy commit -m x',
          'git clone -c commit.gpgsign=true signrepo copy && git -C copy commit -m x',
          'git clone --config commit.gpgsign=true signrepo copy && git -C copy commit -m x',
          'git clone -qc commit.gpgsign=true signrepo copy && git -C copy commit -m x',
          'git init --separate-git-dir=sg sub && git -C sub commit -m x',
          'git -c init.templateDir=tpl2 init sub && git -C sub commit -m x',
          'git --config-env=init.templateDir=T init sub && git -C sub commit -m x',
          'GIT_TEMPLATE_DIR=tpl2 git init sub && git -C sub commit -m x',
          'export GIT_TEMPLATE_DIR=tpl2; git init sub && git -C sub commit -m x',
          'env GIT_TEMPLATE_DIR=tpl2 git init sub && git -C sub commit -m x',
          'GIT_DIR=x git init sub && git -C sub commit -m x',
          'export GIT_EXEC_PATH=x; git init sub && git -C sub commit -m x',
        ]) {
          expect(await configured({}, script), script).toMatch(/^.a/);
        }
        expect(await configured({}, 'git init -q -b main sub && git -C sub commit -m x')).toMatch(/^.r/);
      });

      it.each(['GIT_TEMPLATE_DIR', 'GIT_EXEC_PATH'])('asks when this process sets %s', async name => {
        const script = 'git init sub && git -C sub commit -m x';
        expect(await configured({}, script)).toMatch(/^.r/);
        expect(await configured({}, script, { [name]: '/dev/null' })).toMatch(/^.a/);
      });

      it('asks with a git dir or work tree, which no fresh repository stands for', async () => {
        expect(await configured({}, 'git init sub && git --git-dir=sub/.git commit -m x')).toMatch(/^.a/);
        expect(await configured({}, 'git init sub && git -C sub --work-tree=. commit -m x')).toMatch(/^.a/);
      });

      it('asks for a signing form in a folder made by a statement that may not run first', async () => {
        for (const script of [
          'if true; then git init sub; fi; git -C sub commit -m x',
          'git init sub & git -C sub commit -m x',
        ]) {
          expect(await configured({ global: SIGN, repo: UNSIGN }, script), script).toMatch(/^.a/);
        }
      });
    });

    describe('with HOME or XDG_CONFIG_HOME set by the script', () => {
      beforeAll(() => {
        for (const name of ['hmsign', 'hmno']) file(join(proj, name, '.gitconfig'), name === 'hmsign' ? SIGN : UNSIGN);
        file(join(proj, 'xdgsign', 'git', 'config'), SIGN);
        file(join(proj, 'xdgno', 'git', 'config'), UNSIGN);
      });

      afterAll(() => {
        for (const name of ['hmsign', 'hmno', 'xdgsign', 'xdgno'])
          rmSync(join(proj, name), { recursive: true, force: true });
      });

      /** The cells of `command` but the first, which a script that sets HOME never has covered by a rule. */
      const ran = async (...args: Parameters<typeof configured>): Promise<string> =>
        (await configured(...args)).slice(1);

      it.each([
        ['HOME', 'hmsign', 'hmno'],
        ['XDG_CONFIG_HOME', 'xdgsign', 'xdgno'],
      ])('gives %s to the command that sets it and those after a plain assignment', async (name, signDir, noneDir) => {
        const sign = join(proj, signDir);
        const none = join(proj, noneDir);
        // No signing config in this process: the script's own value decides.
        expect(await ran({}, `${name}=${sign} git commit -m x`)).toBe('aaa');
        expect(await ran({}, `${name}=${none} git commit -m x`)).toBe('rrr');
        expect(await ran({}, `export ${name}=${sign}; git commit -m x`)).toBe('aaa');
        expect(await ran({}, `${name}=${sign}; git commit -m x`)).toBe('aaa');
        expect(await ran({}, `${name}=${sign}; export ${name}; git status; git commit -m x`)).toBe('aaa');
        // With this process signing, a value of the script's that does not sign wins for the command it reaches.
        // The file the script moves is the one git stops reading; the other still counts.
        const moved = name === 'HOME' ? 'global' : 'xdg';
        const kept = name === 'HOME' ? 'xdg' : 'global';
        expect(await ran({ [moved]: SIGN }, `${name}=${none} git commit -m x`)).toBe('rrr');
        expect(await ran({ [moved]: SIGN }, `export ${name}=${none}; git commit -m x`)).toBe('rrr');
        // The moved HOME's own `gpgsign = false` outranks the xdg file; the moved xdg one sits below the global file.
        expect(await ran({ [kept]: SIGN }, `${name}=${none} git commit -m x`)).toBe(name === 'HOME' ? 'rrr' : 'aaa');
      });

      it.each([
        ['HOME', 'hmsign', 'hmno'],
        ['XDG_CONFIG_HOME', 'xdgsign', 'xdgno'],
      ])(
        'does not give %s to a command a prefix assignment on another command did not reach',
        async (name, signDir, noneDir) => {
          const sign = join(proj, signDir);
          const none = join(proj, noneDir);
          const real = { global: SIGN, xdg: SIGN };
          for (const [first, joiner] of [
            [`${name}=VALUE git status`, ';'],
            [`${name}=VALUE git status`, '&&'],
            [`${name}=VALUE git log -1`, ';'],
            [`${name}=VALUE true`, ';'],
            [`env ${name}=VALUE git status`, ';'],
            [`${name}=VALUE git status | cat`, ';'],
          ]) {
            const script = (value: string): string => `${first.replace('VALUE', value)} ${joiner} git commit -m x`;
            expect(await ran(real, script(none)), script(none)).toBe('aaa');
            // The first command may ask for the config it is moved to; the commit must not take it on.
            expect((await lastAsked(script(sign))).asked, script(sign)).toBe(false);
          }
          const moved = name === 'HOME' ? 'global' : 'xdg';
          const kept = name === 'HOME' ? 'xdg' : 'global';
          expect(await ran({ [moved]: SIGN }, `env ${name}=${none} git commit -m x`)).toBe('rrr');
          expect(await ran({ [kept]: SIGN }, `env ${name}=${none} git commit -m x`)).toBe(
            name === 'HOME' ? 'rrr' : 'aaa'
          );
          expect(await ran({}, `env ${name}=${sign} git commit -m x`)).toBe('aaa');
        }
      );

      it('asks for a value set in a branch, a loop, a function or by expansion', async () => {
        for (const script of [
          'if true; then HOME=hmno; fi; git commit -m x',
          'for i in 1; do HOME=hmno; done; git commit -m x',
          'f() { HOME=hmno; }; f; git commit -m x',
          'f() { git commit -m x; }; HOME=hmno f',
          'HOME=$PWD/hmno git commit -m x',
          'HOME=$(echo hmno) git commit -m x',
          'HOME=hmno; HOME=hmsign; git commit -m x',
          'HOME=hmno HOME=hmsign git commit -m x',
          'read HOME; git commit -m x',
          'HOME+=x git commit -m x',
        ]) {
          expect(await ran({ global: UNSIGN }, script), script).toBe('aaa');
        }
        expect(await ran({}, 'git commit -m x; HOME=hmsign')).toBe('rrr');
      });
    });

    describe('with a relative or unset git config location', () => {
      const GIT_ENV = ['HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM'];
      const here = async (command: string, folder = ''): Promise<string> =>
        (await withConfigs({}, {}, () => cells(command, folder))).slice(1);

      it('runs a commit with no signing config and an absolute value', async () => {
        expect(await here('git commit -m x')).toBe('rrr');
        expect(await here(`HOME=${join(proj, 'hmno')} git commit -m x`)).toBe('rrr');
        expect(await here(`XDG_CONFIG_HOME=${join(proj, 'xdgno')} git commit -m x`)).toBe('rrr');
        expect(await here('env -u FOO git commit -m x')).toBe('rrr');
        expect(await here('unset FOO; git commit -m x')).toBe('rrr');
      });

      it.each(['HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM'])(
        'asks for a signing form with a relative %s from the top and a subfolder',
        async name => {
          for (const value of ['rel', './rel', '../rel', 'src/rel']) {
            for (const command of [
              `${name}=${value} git commit -m x`,
              `export ${name}=${value}; git commit -m x`,
              `${name}=${value}; git log -1`,
              `env ${name}=${value} git commit -m x`,
            ]) {
              expect(await here(command), command).toBe('aaa');
              expect(await here(command, 'src'), `src: ${command}`).toBe('aaa');
            }
          }
          if (name === 'HOME' || name === 'XDG_CONFIG_HOME') {
            expect(await here(`${name}=rel git status; git commit -m x`)).toBe('rrr');
          }
        }
      );

      it('asks for a signing form with a relative XDG_CONFIG_HOME in this process', async () => {
        expect(await withConfigs({}, { XDG_CONFIG_HOME: 'rel' }, () => cells('git commit -m x', ''))).toMatch(/^.a/);
        expect(await withConfigs({}, { XDG_CONFIG_HOME: 'rel' }, () => cells('git status', ''))).toMatch(/^.r/);
      });

      it.each(GIT_ENV)('asks for a signing form after %s is unset', async name => {
        for (const command of [
          `unset ${name}; git commit -m x`,
          `unset -v ${name}; git commit -m x`,
          `unset ${name} FOO; git commit -m x`,
          `export -n ${name}; git commit -m x`,
          `export -n ${name}=x; git commit -m x`,
          `env -u ${name} git commit -m x`,
          `env -u${name} git commit -m x`,
          `env --unset=${name} git commit -m x`,
          `env --unset ${name} git commit -m x`,
          `env -u FOO -u ${name} git commit -m x`,
          `unset "${name}"; git commit -m x`,
          `git commit -m x; unset ${name}; git commit -m y`,
          `unset ${name}; git log -1`,
        ]) {
          expect(await here(command), command).toBe('aaa');
        }
        if (name === 'HOME' || name === 'XDG_CONFIG_HOME') expect(await here(`unset ${name}; git status`)).toBe('rrr');
      });

      it('asks for a signing form after env -i, GIT_CONFIG variables and unset operands it cannot read', async () => {
        for (const command of [
          'env -i git commit -m x',
          'env -i PATH=$PATH git commit -m x',
          'env --ignore-environment git commit -m x',
          'env -iu FOO git commit -m x',
          'env -u GIT_CONFIG_COUNT git commit -m x',
          'unset GIT_CONFIG_PARAMETERS; git commit -m x',
          'unset $NAME; git commit -m x',
          'unset "${NAME}"; git commit -m x',
          'unset H*; git commit -m x',
          'export -n $NAME; git commit -m x',
          'env -u $NAME git commit -m x',
        ]) {
          expect(await here(command), command).toBe('aaa');
        }
      });

      const drops = (name: string): string[] => [
        `unset ${name}`,
        `unset -v ${name}`,
        `unset -f -v ${name}`,
        `unset FOO ${name}`,
        `unset -- ${name}`,
        `export -n ${name}`,
        `export -n ${name}=x`,
        `export -p -n FOO ${name}`,
        `declare +x ${name}`,
        `typeset +x ${name}`,
        `declare -n ${name}=other`,
        `declare -rn ${name}=other`,
        `local ${name}`,
        `local ${name}=x`,
        `env -u ${name} true`,
        `env -u${name} true`,
        `env --unset ${name} true`,
        `env --unset=${name} true`,
        `env -iu FOO true`,
        `env -vu ${name} true`,
        `env -0u${name} true`,
        `env -u FOO -u ${name} true`,
        'env -i true',
        'env --ignore-environment true',
        'env - true',
        'env -v -i true',
      ];

      it.each(GIT_ENV.slice(0, 4))('asks for a signing form after each spelling that drops %s', async name => {
        for (const drop of drops(name)) {
          for (const script of [
            `${drop}; git commit -m x`,
            `command ${drop}; git commit -m x`,
            `sudo ${drop}; git commit -m x`,
            `nice ${drop}; git commit -m x`,
            `f() { ${drop}; }; f; git commit -m x`,
            `if true; then ${drop}; fi; git commit -m x`,
            `for i in 1; do ${drop}; done; git commit -m x`,
            `true && ${drop}; git commit -m x`,
            `( ${drop} ); git commit -m x`,
            `builtin ${drop}; git commit -m x`,
          ]) {
            // env is a program, so builtin does not reach it.
            if (drop.startsWith('env ') && script.startsWith('builtin ')) continue;
            expect(await here(script), script).toBe('aaa');
          }
        }
      });

      it('asks after an env that drops the variable behind other wrappers', async () => {
        for (const script of [
          'command env -u HOME git commit -m x',
          'sudo env -i git commit -m x',
          'nice env --unset=GIT_CONFIG_GLOBAL git commit -m x',
          'command sudo env -u XDG_CONFIG_HOME git commit -m x',
          'env env -u HOME git commit -m x',
          'env FOO=1 env -i git commit -m x',
          'f() { env -i git commit -m x; }; f',
          'env -u HOME git log -1',
          'eval "unset HOME"; git commit -m x',
          "eval 'env -i true'; git commit -m x",
          "echo 'unset HOME' | xargs sh -c; git commit -m x",
        ]) {
          expect(await here(script), script).toBe('aaa');
        }
      });

      it('asks for an operand it cannot read, by an expansion or a glob', async () => {
        for (const drop of [
          'unset $NAME',
          'unset "${NAME}"',
          'unset H*',
          'unset GIT_CONFIG_*',
          'unset $(echo HOME)',
          'unset `echo HOME`',
          'export -n $NAME',
          'declare +x $NAME',
          'local $NAME',
          'env -u $NAME true',
          'env -u H* true',
          'env --unset=$NAME true',
          'env --unset $NAME true',
          'env $OPTS true',
          'export $FLAG HOME',
          'declare $FLAG HOME',
        ]) {
          for (const script of [`${drop}; git commit -m x`, `f() { ${drop}; }; f; git commit -m x`]) {
            expect(await here(script), script).toBe('aaa');
          }
        }
      });

      it('runs a signing form with no signing config for text that only mentions an unset', async () => {
        for (const script of [
          'git commit -m "fix: do unset HOME handling"',
          'git commit -m "wip; unset HOME docs"',
          "git commit -m 'wip; env -i docs'",
          'git commit -m "x" -m "unset GIT_CONFIG_GLOBAL"',
          'cat <<EOF\nunset HOME\nenv -i\nEOF\ngit commit -m x',
          "cat <<'EOF'\nunset HOME\nEOF\ngit commit -m x",
          'git commit -F - <<EOF\nunset HOME\nEOF',
          '# unset HOME\ngit commit -m x',
          'git commit -m x # unset HOME',
          'echo unset HOME; git commit -m x',
          'echo "env -i"; git commit -m x',
          'git commit -m x --author="unset HOME <a@b.c>"',
          'env git log -1 -i',
          'env git commit -m x -i',
          'env -- git log -1 -i',
          'env FOO=1 git log -1 -i',
          'env -u FOO git log -1 -i',
          'env -u FOO git log -1 -u HOME',
          'command env git log -1 -i',
          'sudo env FOO=1 git log -1 -u HOME',
          'env true -i; git commit -m x',
          'unset FOO; echo HOME; git commit -m x',
          'export -n FOO; git commit -m x',
          'declare +x FOO; git commit -m x',
          'local FOO; git commit -m x',
        ]) {
          expect(await here(script), script).toBe('rrr');
        }
      });

      const DRIVE_OR_UNC = ['C:\\x', 'C:/x', '\\\\srv\\share'];
      const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
      const shells = {
        posix: () => undefined,
        windows: () => Object.defineProperty(process, 'platform', { value: 'win32' }),
        wsl: () => {
          Object.defineProperty(process, 'platform', { value: 'win32' });
          inWsl.on = true;
        },
      };
      afterEach(() => {
        Object.defineProperty(process, 'platform', platform);
        inWsl.on = false;
      });

      it.each(['HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM'])(
        'asks for a Windows drive or UNC %s of this process on a POSIX host',
        async name => {
          const before = process.env[name];
          // withConfigs deletes what it stubs, so the suite's own value is put back after each run.
          const commit = async (env: Record<string, string>): Promise<string> => {
            try {
              return await withConfigs({}, env, () => cells('git commit -m x', ''));
            } finally {
              vi.stubEnv(name, before);
            }
          };
          for (const value of [...DRIVE_OR_UNC, 'd:\\x', 'rel', 'C:rel', '.\\x', '\\x']) {
            expect(await commit({ [name]: value }), value).toMatch(/^.a/);
          }
          for (const value of ['/x', '//x', '']) expect(await commit({ [name]: value }), value).toMatch(/^.r/);
        }
      );

      it('counts a drive or UNC value as absolute only in a native Windows shell', () => {
        for (const kind of ['posix', 'windows', 'wsl'] as const) {
          shells[kind]();
          for (const value of DRIVE_OR_UNC)
            expect(isAbsoluteGitPath(value, proj), `${kind} ${value}`).toBe(kind === 'windows');
          for (const value of ['/x', '//x']) expect(isAbsoluteGitPath(value, proj), `${kind} ${value}`).toBe(true);
          for (const value of ['', 'rel', 'C:rel', '.\\x', '\\x']) {
            expect(isAbsoluteGitPath(value, proj), `${kind} ${value}`).toBe(false);
          }
        }
      });

      it.each(['HOME', 'XDG_CONFIG_HOME'])(
        'asks for a drive or UNC form of a script %s on a POSIX host',
        async name => {
          for (const value of DRIVE_OR_UNC) {
            const quoted = value.replace(/\\/g, '\\\\');
            for (const script of [
              `${name}="${quoted}" git commit -m x`,
              `export ${name}="${quoted}"; git commit -m x`,
            ]) {
              expect(await here(script), script).toBe('aaa');
            }
          }
          for (const script of [`${name}=/x git commit -m x`, `${name}=//x git commit -m x`]) {
            expect(await here(script), script).toBe('rrr');
          }
          for (const script of [`${name}=C:rel git commit -m x`, `${name}=rel git commit -m x`]) {
            expect(await here(script), script).toBe('aaa');
          }
        }
      );
    });

    describe('with a format.pretty or pretty alias', () => {
      it.each([
        ['[format]\n\tpretty = zs\n[pretty]\n\tzsig = format:%h %G?\n', 'git log -1', 'aaaa'],
        ['[format]\n\tpretty = ZS\n[pretty]\n\tzsig = format:%h %G?\n', 'git log -1', 'aaaa'],
        ['[format]\n\tpretty = zs\n[pretty]\n\tZSig = format:%h %G?\n', 'git show HEAD', 'aaaa'],
        ['[format]\n\tpretty = zs\n[pretty]\n\tzsig = format:%h\n', 'git log -1', 'rrrr'],
        ['[format]\n\tpretty = zs\n[pretty]\n\tyzsig = format:%h %G?\n', 'git log -1', 'aaaa'],
        ['[format]\n\tpretty = z\n[pretty]\n\tza = format:%h\n\tzb = format:%G?\n', 'git log -1', 'aaaa'],
        ['[format]\n\tpretty = a\n[pretty]\n\tabc = bc\n\tbcd = %G?\n', 'git show HEAD', 'aaaa'],
        ['[format]\n\tpretty = a\n[pretty]\n\tabc = BC\n\tBCD = %G?\n', 'git log -1', 'aaaa'],
        ['[format]\n\tpretty = a\n[pretty]\n\tabc = bc\n\tbcd = format:%h\n', 'git log -1', 'rrrr'],
        ['[format]\n\tpretty = zs\n[pretty]\n\tzsig = format:%h %G?\n', 'git status', 'rrrr'],
      ])('with %j in the global config, decides %s as %s by alias prefix', async (text, command, expected) => {
        expect(await configured({ global: text }, command)).toBe(expected);
      });

      it.each([
        ['[format]\n\tpretty = %h %G?\n', 'git log -1', 'aaaa'],
        ['[format]\n\tpretty = %h %G?\n', 'git log -1', 'aaaa'],
        ['[format]\n\tpretty = format:%h %GS\n', 'git show HEAD', 'aaaa'],
        ['[format]\n\tpretty = %h %G?\n', 'git reflog', 'aaaa'],
        ['[format]\n\tpretty = %h %G?\n', 'git status', 'rrrr'],
        ['[format]\n\tpretty = %h %G?\n', 'git commit -m x', 'rrrr'],
        ['[format]\n\tpretty = oneline\n', 'git log -1', 'rrrr'],
        ['[format]\n\tpretty = %h %s\n', 'git log -1', 'rrrr'],
        ['[format]\n\tpretty = sig\n[pretty]\n\tsig = format:%h %G?\n', 'git log -1', 'aaaa'],
        ['[format]\n\tpretty = SIG\n[pretty]\n\tsig = format:%h %G?\n', 'git log -1', 'aaaa'],
        ['[format]\n\tpretty = sig\n[pretty]\n\tsig = format:%h\n', 'git log -1', 'rrrr'],
        ['[format]\n\tpretty = a\n[pretty]\n\ta = b\n\tb = %G?\n', 'git show HEAD', 'aaaa'],
        ['[pretty]\n\tsig = format:%h %G?\n', 'git log -1', 'rrrr'],
        ['[format]\n\tpretty = oneline\n[pretty]\n\tsig = %G?\n', 'git log -1', 'rrrr'],
        ['[format]\n\tpretty\n', 'git log -1', 'aaaa'],
        ['[format]\n\tpretty = a\n[pretty]\n\ta = a\n', 'git log -1', 'aaaa'],
        ['[format]\n\tpretty = %G?\n\tpretty = short\n', 'git log -1', 'rrrr'],
        ['[format]\n\tpretty = short\n\tpretty = %G?\n', 'git log -1', 'aaaa'],
        ['[format]\n\tpretty = %h %\\\nG?\n', 'git log -1', 'aaaa'],
      ])('with %j in the global config, decides %s as %s', async (text, command, expected) => {
        expect(await configured({ global: text }, command)).toBe(expected);
      });

      it('reads format.pretty from the repo config and an include', async () => {
        expect(await configured({ repo: '[format]\n\tpretty = %G?\n' }, 'git log -1')).toBe('aaaa');
        expect(
          await configured(
            { global: `[include]\n\tpath = ${placed.inc()}\n`, inc: '[format]\n\tpretty = %G?\n' },
            'git log -1'
          )
        ).toBe('aaaa');
      });

      it('asks for log with a format.pretty git cannot read', async () => {
        expect(await configured({ global: '[format\n' }, 'git log -1')).toBe('aaaa');
      });
    });

    describe('with --config-env', () => {
      it.each([
        ['GITSIGN_V=x git --config-env=user.name=GITSIGN_V commit -m x', 'arrr'],
        ['GITSIGN_V=x git --config-env user.name=GITSIGN_V commit -m x', 'arrr'],
        ['export GITSIGN_V=x; git --config-env=user.name=GITSIGN_V commit -m x', 'arrr'],
        ['GITSIGN_V=x; git --config-env=user.name=GITSIGN_V log -1', 'arrr'],
        ['GITSIGN_V=$(date) git --config-env=user.name=GITSIGN_V commit -m x', 'aaaa'],
        ['GITSIGN_V=$OTHER git --config-env=user.name=GITSIGN_V commit -m x', 'aaaa'],
        ['GITSIGN_V=~/x git --config-env=user.name=GITSIGN_V commit -m x', 'aaaa'],
        ['read GITSIGN_V; git --config-env=user.name=GITSIGN_V commit -m x', 'aaaa'],
        ['GITSIGN_V=x; GITSIGN_V=y; git --config-env=user.name=GITSIGN_V commit -m x', 'aaaa'],
        ['git --config-env=user.name=GITSIGN_V commit -m x; GITSIGN_V=x', 'aaaa'],
        ['unset GITSIGN_V; git --config-env=user.name=GITSIGN_V commit -m x', 'aaaa'],
        ['git --config-env=user.name=GITSIGN_V commit -m x', 'aaaa'],
        ['git --config-env=user.name=HOME commit -m x', 'aaaa'],
        ['git --config-env=user.name commit -m x', 'aaaa'],
        ['git --config-env=user.name=1BAD commit -m x', 'aaaa'],
      ])('decides %s as %s with the variable unset in this process', async (command, expected) => {
        expect(await configured({}, command)).toBe(expected);
      });

      it('counts a prefix assignment only for its own command', async () => {
        // No key a --config-env may set changes signing, so the value the signing query is handed shows whose it is.
        const call = 'git --config-env=user.name=GITSIGN_V commit -m x';
        const handed = (): (string | undefined)[] => queried.envs.map(env => env.GITSIGN_V);
        for (const env of [{}, { GITSIGN_V: 'proc' }] as Record<string, string>[]) {
          for (const command of [
            `GITSIGN_V=other git status; ${call}`,
            `GITSIGN_V=other true && ${call}`,
            `env GITSIGN_V=other git status; ${call}`,
            `GITSIGN_V=other git status | cat; ${call}`,
            `f() { ${call}; }; GITSIGN_V=other f`,
            `f() { ${call}; }; env GITSIGN_V=other f`,
          ]) {
            queried.envs.length = 0;
            expect(await configured({}, command, env), command).toBe('aaaa');
            expect(handed(), command).not.toContain('other');
          }
          for (const command of [`GITSIGN_V=own ${call}`, `env GITSIGN_V=own ${call}`]) {
            queried.envs.length = 0;
            expect(await configured({}, command, env), command).toBe('arrr');
            expect(handed(), command).toContain('own');
            expect(handed(), command).not.toContain('proc');
          }
        }
      });

      it('reads a variable of this process, a name that starts GIT_ too', async () => {
        for (const name of ['GITSIGN_V', 'GIT_SIGN_V']) {
          const command = `git --config-env=user.name=${name} commit -m x`;
          expect(await configured({}, command, { [name]: 'x' })).toBe('arrr');
          expect(await configured({ repo: SIGN }, command, { [name]: 'x' })).toBe('aaaa');
        }
      });

      it('lets a script assignment win over this process, and asks when it is not placed', async () => {
        const env = { GITSIGN_V: 'x' };
        expect(await configured({}, 'GITSIGN_V=y git --config-env=user.name=GITSIGN_V commit -m x', env)).toBe('arrr');
        expect(await configured({}, 'GITSIGN_V=$(date) git --config-env=user.name=GITSIGN_V commit -m x', env)).toBe(
          'aaaa'
        );
        expect(await configured({}, 'unset GITSIGN_V; git --config-env=user.name=GITSIGN_V commit -m x', env)).toBe(
          'aaaa'
        );
      });
    });

    it('asks for signing forms only with a global config that is a folder', async () => {
      const global = placed.global();
      mkdirSync(global);
      try {
        expect(await cells('git commit -m x', '')).toBe('aaaa');
        expect(await cells('git diff', '')).toBe('rrrr');
      } finally {
        rmSync(global, { recursive: true, force: true });
      }
    });

    it('reads a global config through a link, and none through a dangling one', async () => {
      const global = placed.global();
      const target = join(base, 'linked-gitconfig');
      symlinkSync(target, global);
      try {
        expect(await cells('git commit -m x', '')).toBe('rrrr');
        file(target, SIGN);
        expect(await cells('git commit -m x', '')).toBe('aaaa');
      } finally {
        rmSync(global, { force: true });
        rmSync(target, { force: true });
      }
    });

    it.each([
      [{ GIT_CONFIG_GLOBAL: '/dev/null' }, { global: SIGN }, 'rrrr'],
      [{ GIT_CONFIG_NOSYSTEM: 'false' }, { system: SIGN }, 'aaaa'],
      [{ GIT_CONFIG_NOSYSTEM: '' }, { system: SIGN }, 'aaaa'],
      [{ GIT_CONFIG_PARAMETERS: "'user.name=x'" }, {}, 'aaaa'],
      [{ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'x' }, {}, 'aaaa'],
    ] as [Record<string, string>, Partial<Record<Place, string>>, string][])(
      'with %j in this process, decides git commit with %j as %s',
      async (env, configs, expected) => {
        expect(await configured(configs, 'git commit -m x', env)).toBe(expected);
      }
    );

    it.each([
      'git commit -S -m x',
      'git commit --gpg-sign -m x',
      'git merge -S other',
      'git merge --verify-signatures other',
      'git rebase -S main',
      'git tag -s -m x v9',
      'git tag -u KEY -m x v9',
      'git push --signed origin main',
      'git log --show-signature -1',
      'git show --show-signature HEAD',
      'git -c commit.gpgsign=true commit -m x',
      'git -c log.showSignature=true log -1',
      'GIT_CONFIG_GLOBAL=x git commit -m x',
      'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=true git commit -m x',
    ])('asks for %s with no signing config', async command => {
      expect(await configured({}, command)).toBe('aaaa');
    });
  });

  describe.each(['deny', 'ask', 'allow'] as const)('with a %s rule and git aliases', list => {
    const decided = async (command: string, text = 'git push:*'): Promise<string | null> => {
      const parsed = parseRule(`Bash(${text})`, { native: true });
      if (!parsed.ok) throw new Error(parsed.reason);
      const home = dirname(proj);
      const rule = compileRule(parsed.rule, list, { id: 't', label: 'T' }, { home, root: proj, cwd: proj });
      const set = new PermissionRuleSet(rule ? [rule] : [], () => roots);
      const context = {
        roots: [proj],
        workingDirectory: proj,
        signal: new AbortController().signal,
        protectedPaths: [userData],
        uncoverablePaths: roots,
      } as ToolContext;
      const prompt = await shellApproval('bash_execute', { command, cwd: proj }, context);
      const subject = await resolveSubject(
        permissionSubject({ name: 'bash_execute', input: { command } }, prompt, context)
      );
      return set.evaluate(subject).decision;
    };

    // Rows a deny or ask rule matches by the alias as written or by its expansion.
    const matching: [string, string][] = [
      ['git lg:*', 'FOO=1 git lg -3'],
      ['git lg:*', 'git -C . lg -3 > log.txt'],
      ['git lg:*', 'git --no-pager lg -3 > log.txt'],
      ['git p:*', 'FOO=1 git p origin main'],
      ['git p:*', 'git -C . p origin main > push.log'],
      ['git st:*', 'FOO=1 git st'],
      ['git st:*', 'git -C src st > s.log'],
      ['git push:*', 'git push origin main'],
      ['git push:*', 'git push origin main > push.log'],
      ['git push:*', 'FOO=1 git push origin main'],
      ['git push:*', 'git p origin main'],
      ['git push:*', 'git p origin main > push.log'],
      ['git push:*', 'git p origin main 2> err.txt'],
      ['git push:*', 'git p origin main >> push.log 2>&1'],
      ['git push:*', 'FOO=1 git p origin main'],
      ['git push:*', 'FOO=1 git p origin main > push.log'],
      ['git push:*', 'git -C . p origin main'],
      ['git push:*', 'git p'],
    ];

    it.skipIf(list === 'allow').each(matching)('rule %s on %s', async (text, command) => {
      expect(await decided(command, text)).toBe(list);
    });

    it.skipIf(list !== 'allow').each(['git p origin main > push.log', 'FOO=1 git p origin main'])(
      'an allow rule on the expansion does not cover %s',
      async command => {
        expect(await decided(command)).toBeNull();
      }
    );

    it.each(['git st > status.log', 'FOO=1 git st', 'git st 2> err.txt', 'git lg -3 > log.txt'])(
      'does not match a push rule on %s',
      async command => {
        expect(await decided(command)).toBeNull();
      }
    );
  });
});
