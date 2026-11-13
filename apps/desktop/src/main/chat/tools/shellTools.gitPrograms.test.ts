import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { permissionProtectedLocations } from '../protectedLocations';
import { compileRule, parseRule, PermissionRuleSet, type CompiledRule } from '../permissions/rules';
import { resolveSubject } from '../permissions/resolveSubject';
import { permissionSubject } from '../permissions/subject';
import { runsCheckedInFull } from './shellApproval.testHelper';
import { shellApproval } from './shellTools';
import type { ToolContext } from './types';

vi.mock('./userPath', async importOriginal => ({
  ...(await importOriginal<typeof import('./userPath')>()),
  resolveUserPath: vi.fn(async () => process.env.PATH ?? ''),
}));

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
  ['rsync -a --exclude .git lrepo/ dist3/ && git -C dist3 st', '', 'rrar'],
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
  ['git push', '', 'raar'],
  ['git push origin main', '', 'raar'],
  ['git push -u origin main', '', 'raar'],
  ['git st', '', 'rrrr'],
  ['git lg -3', '', 'rrrr'],
  ['git co other', '', 'rrrr'],
  ['git p', '', 'raar'],
  ['git st && git lg', '', 'rrrr'],
  ['git add -A && git commit -m x && git p', '', 'raar'],
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
  ['pnpm build && git add -A && git commit -m build && git p', '', 'raar'],
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
  ['git branch --unset-upstream "$B"', '', 'rrrr'],
  ['git log --grep=unset "$X"', '', 'rrrr'],
  ['export GIT_EXTERNAL_DIFF=./x.sh; git log -1 -p "$X"', '', 'aaaa'],
  ['git log --format="%H unset $x"', '', 'rrrr'],
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
  ['git -C rem/tracked push', '', 'raar'],
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
  ['XDG_CONFIG_HOME=xdg2 git log -1', '', 'arrr'],
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
      !prompt.askInAuto,
      !withSession.askInAuto && (withSession.always?.directories ?? []).length === 0,
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
