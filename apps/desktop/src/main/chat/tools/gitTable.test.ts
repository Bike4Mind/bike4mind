import { describe, expect, it } from 'vitest';
import {
  configKey,
  configTrue,
  formatShowsSignatures,
  gitListed,
  prettyShowsSignatures,
  settingsOn,
  type GitWord,
} from './gitTable';

// A word holding `$` is filled from there at run time (`$$` also splits into more words); `*` starts a glob.
const words = (line: string): GitWord[] =>
  line
    .split(' ')
    .filter(Boolean)
    .map(token => {
      const at = token.search(/[$*]/);
      if (at === -1) return { text: token, whole: true, splits: false };
      const glob = token[at] === '*' ? { glob: true } : {};
      return { text: token.slice(0, at), whole: false, splits: token.slice(at).startsWith('$$'), ...glob };
    });

const listed = (line: string): boolean => gitListed(words(line)).listed;

const reason = (line: string): string | null => {
  const listing = gitListed(words(line));
  return listing.listed ? null : listing.reason;
};

describe('gitListed', () => {
  it.each([
    'log --oneline',
    'status --short',
    'diff --name-only main',
    'fetch --prune origin',
    'stage .',
    'log --no-decorate',
    'branch --no-merged main',
  ])('lists the exact spelling in %s', line => {
    expect(listed(line)).toBe(true);
  });

  it.each([
    ['log --onelin', 'git log --onelin'],
    ['fetch --upl x origin', 'git fetch --upl'],
    ['fetch --upload-pack=x origin', 'git fetch --upload-pack'],
    ['log --show-signature', 'git log --show-signature'],
    ['diff --ext-diff', 'git diff --ext-diff'],
    ['diff --textconv', 'git diff --textconv'],
    ['diff -O order', 'git diff -O'],
    ['log --no-follow-ish', 'git log --no-follow-ish'],
    ['log --oneline=x', 'git log --oneline='],
    ['STATUS', 'git STATUS'],
  ])('refuses %s', (line, expected) => {
    expect(reason(line)).toBe(expected);
  });

  it.each([
    'log -n5',
    'log -n 5',
    'log --max-count=5',
    'log --max-count 5',
    'commit -mfix',
    'commit -am fix',
    'commit -m $',
    'commit --message=$',
    'log --format=$',
    'merge -sours other',
    'merge -s ours other',
    'merge --strategy=ours other',
    'merge --strategy recursive -X theirs other',
    'status --porcelain=v2',
    'pull -r',
    'pull --rebase',
    'pull --rebase=merges',
    'add --chmod=+x a.sh',
    'add --chmod -x a.sh',
    'diff -U0 a.ts',
    'blame -L 1,10 a.ts',
  ])('reads a glued, `=` or next-word value in %s', line => {
    expect(listed(line)).toBe(true);
  });

  it.each([
    ['merge -s evil other', 'git merge -s evil'],
    ['merge -sevil other', 'git merge -s evil'],
    ['merge --strategy=evil other', 'git merge --strategy evil'],
    ['merge -s $ other', 'git merge -s with a value filled at run time'],
    ['pull --rebase=interactive', 'git pull --rebase interactive'],
    ['pull -ri', 'git pull -r i'],
    ['add --chmod=777 a.sh', 'git add --chmod 777'],
    ['archive --format=evil HEAD', 'git archive --format evil'],
  ])('checks the value of %s', (line, expected) => {
    expect(reason(line)).toBe(expected);
  });

  it('takes a last-argument value only when a word follows', () => {
    const contains = gitListed(words('branch --contains HEAD'));
    expect(contains.listed && contains.operands).toEqual([]);
    expect(listed('branch --contains')).toBe(true);
  });

  it.each([
    ['checkout -- a.ts', true],
    ['commit -m x -- $', true],
    ['add -- -p', true],
    ['add -- $$', true],
    ['commit -m x $', false],
    ['rm $', false],
    ['add -p', false],
  ])('reads every word after `--` as an operand: %s', (line, expected) => {
    expect(listed(line)).toBe(expected);
  });

  it.each([
    ['grep -n parse $', true],
    ['grep -n parse $$ src', true],
    ['grep parse -O', true],
    ['grep -e $ src', true],
    ['grep -eO a', true],
    ['grep -n src/$ a', true],
    ['grep -n $ src', false],
    ['grep -e x $', false],
    ['grep -O parse', false],
    ['grep -Ovim parse', false],
    ['grep --open-files-in-pager=vim parse', false],
  ])('stops reading grep options at its first operand: %s', (line, expected) => {
    expect(listed(line)).toBe(expected);
  });

  it('keeps every grep word after the first operand as an operand', () => {
    const grep = gitListed(words('grep -n parse -O src'));
    expect(grep.listed && grep.operands.map(word => word.text)).toEqual(['parse', '-O', 'src']);
  });

  it.each([
    ['log -5', true],
    ['log -1 --format=%H', true],
    ['grep -3 parse', true],
    ['archive -9 HEAD', true],
    ['format-patch -1 HEAD', true],
    ['status -5', false],
    ['archive -9$ HEAD', false],
  ])('reads -<n> where the subcommand takes a count: %s', (line, expected) => {
    expect(listed(line)).toBe(expected);
  });

  it.each([
    ['stash', true],
    ['stash -u', true],
    ['stash push -m wip', true],
    ['stash pop', true],
    ['stash pop stash@{1}', true],
    ['stash show -p', true],
    ['stash list --oneline', true],
    ['stash pop a b', false],
    ['stash -p', false],
    ['stash push -p', false],
    ['stash export --print', false],
    ['worktree list', true],
    ['worktree add ../wt -b wt', true],
    ['worktree', false],
    ['worktree frob', false],
    ['remote', true],
    ['remote -v', true],
    ['remote -v show origin', true],
    ['remote get-url origin', true],
    ['remote set-branches origin main', false],
    ['submodule', true],
    ['submodule update --init --recursive', true],
    ['submodule --quiet status', true],
    ['submodule foreach make', false],
    ['submodule add https://example.com/r.git', false],
    ['reflog', true],
    ['reflog -n 10', true],
    ['reflog show main', true],
    ['reflog expire --all', false],
    ['sparse-checkout list', true],
    ['sparse-checkout set src', false],
    ['config edit', false],
    ['config rename-section a b', false],
  ])('reads the verb of %s', (line, expected) => {
    expect(listed(line)).toBe(expected);
  });

  it.each([
    ['-c core.hooksPath=/dev/null status', true],
    ['-c core.fsmonitor=false status', true],
    ['-c commit.gpgsign=false commit -m x', true],
    ['-c credential.helper= fetch', true],
    ['-c core.editor=: commit --amend', true],
    ['-c core.pager=cat log', true],
    ['-c pager.log=false log', true],
    ['-c gpg.format=ssh log -1', true],
    ['-c diff.tool=meld log -1', true],
    ['-c COLOR.UI=never status', true],
    ['-c color.diff.meta=blue diff', true],
    ['-c user.name=$ commit -m x', true],
    ['--config-env=color.ui=COLOR status', true],
    ['--config-env color.ui=COLOR status', true],
    ['-c core.hooksPath=hooks status', false],
    ['-c core.hooksPath status', false],
    ['-c commit.gpgsign status', false],
    ['-c core.sshCommand=x fetch', false],
    ['-c core.editor=vim commit', false],
    ['-c core.editor=true commit --amend', false],
    ['-c core.pager=$ log', false],
    ['-c pager.log=less log', false],
    ['-c alias.st=status st', false],
    ['-c remote.x.vcs=svn log -1', false],
    ['-c url.x.insteadOf=y fetch', false],
    ['-c $ status', false],
    ['-c $$ status', false],
    ['-ccolor.ui=never status', false],
    ['--config-env=core.pager=PAGER log', false],
  ])('checks the -c setting in %s', (line, expected) => {
    expect(listed(line)).toBe(expected);
  });

  it.each([
    ['', true],
    ['--no-pager log', true],
    ['-P log', true],
    ['-p log', true],
    ['--no-optional-locks status', true],
    ['--literal-pathspecs --no-replace-objects --no-lazy-fetch status', true],
    ['-C src status', true],
    ['-C $ status', true],
    ['--git-dir=$ log -1', true],
    ['--work-tree ../wt status', true],
    ['--exec-path', true],
    ['--exec-path status', true],
    ['--version clean -fdx', true],
    ['-v clean -fdx', true],
    ['--list-cmds=main', true],
    ['--help clean', true],
    ['-h clean', true],
    ['--help clean -fdx', true],
    ['-h clean -fdx', true],
    ['-C $$ status', false],
    ['-Csrc status', false],
    ['--exec-path=bin status', false],
    ['--bare status', false],
    ['--namespace=x log', false],
    ['--shallow-file x log', false],
    ['--super-prefix=x status', false],
    ['--attr-source=HEAD status', false],
    ['--help -w clean', false],
    ['$ status', false],
    ['--no-pager $', false],
  ])('reads the global options of git %s', (line, expected) => {
    expect(listed(line)).toBe(expected);
  });

  it.each([
    ['log $', true],
    ['diff $$', true],
    ['status $', true],
    ['show --stat $', true],
    ['rev-parse $', true],
    ['range-diff $', true],
    ['diff-tree -r $', true],
    ['reflog show $', true],
    ['stash show $', true],
    ['stash list $', true],
    ['shortlog -s $', true],
    ['rev-list --count $', true],
    ['blame $', true],
    ['ls-files $$', true],
    ['ls-tree --name-only $', true],
    ['push origin feature/$', true],
    ['checkout src/*', true],
    ['branch --unset-upstream $', true],
    ['add *', true],
    ['add $ src/a.ts', true],
    ['worktree add --detach $ main', true],
    ['worktree remove --force $', true],
    ['cat-file -e $', true],
    ['cat-file -e $$', false],
    ['rm *', false],
    ['commit --amend --no-edit $', false],
    ['archive $ HEAD', false],
    ['checkout $', false],
    ['rebase $', false],
    ['fetch origin $', false],
    ['fetch $', false],
    ['ls-remote origin $', false],
    ['push origin --$', false],
    ['config user.name $', false],
    ['commit -m $$', false],
  ])('places a word the shell fills in %s', (line, expected) => {
    expect(listed(line)).toBe(expected);
  });

  it.each(['branch -D -$', 'branch --sort $$ -a', 'cat-file -$ HEAD', 'log -1 -$', 'log -n $$', 'diff -U $$'])(
    'reads %s as a call any option of its form may stand in',
    line => {
      const listing = gitListed(words(line));
      expect(listing.listed && listing.open).toBe(true);
    }
  );

  it.each(['commit -m x -$', 'commit -m $$', 'grep -e $$ x'])(
    'refuses %s, where a word bash fills may become an option that starts a program',
    line => {
      expect(listed(line)).toBe(false);
    }
  );

  it.each([
    ['fetch origin -o *', false],
    ['fetch -o * origin', false],
    ['commit -m *', false],
    ['log -n *', false],
    ['-C * status', false],
    ['commit -m x *', false],
    ['commit -m x -*', false],
    ['log --grep=fix*', true],
    ['add -A *.md', true],
    ['add src/*', true],
    ['status -- *', true],
    ['commit -m x -- *', true],
    ['commit -m* -- -e', false],
    ['commit -m* -- -S', false],
    ['log -n* -- -S', false],
    ['grep -e* -- -S', false],
    ['commit -mmsg -- -S', true],
    ['commit -m msg', true],
    ['log -n5', true],
  ])('reads a glob as the names bash may expand it to in %s', (line, expected) => {
    expect(listed(line)).toBe(expected);
  });

  it.each([
    ['lfs version', 'git lfs'],
    ['constructor -x', 'git constructor'],
    ['toString -q', 'git toString'],
    ['__proto__ -q', 'git __proto__'],
    ['hello', 'git hello'],
  ])('refuses the unlisted subcommand in %s', (line, expected) => {
    expect(reason(line)).toBe(expected);
  });

  it.each([
    ['fetch https://example.com/r.git', true],
    ['fetch git@example.com:r.git', true],
    ['fetch ../r', true],
    ['fetch --all', true],
    ['clone https://example.com/r.git d', true],
    ['remote add fork git@example.com:r.git', true],
    ['push -u origin topic', true],
    ['fetch bar::x', false],
    ['fetch https::x', false],
    ['fetch HTTPS://example.com/r.git', false],
    ['fetch ext::sh', false],
    ['fetch --multiple origin foo::x', false],
    ['pull foo::x main', false],
    ['push foo::x main', false],
    ['ls-remote foo::x', false],
    ['clone foo::x d', false],
    ['clone https://example.com/r.git d e', false],
    ['remote add r foo::x', false],
    ['remote set-url origin foo::x', false],
    ['remote show foo::x', false],
    ['fetch -- $', false],
  ])('checks the remote a network form names in %s', (line, expected) => {
    expect(listed(line)).toBe(expected);
  });

  it.each([
    ['fetch', 'all'],
    ['fetch origin', ['origin']],
    ['fetch --all', 'all'],
    ['fetch --multiple origin upstream', 'all'],
    ['pull --rebase', 'all'],
    ['pull origin main', ['origin']],
    ['push', 'all'],
    ['push -u origin topic', ['origin']],
    ['ls-remote https://example.com/r.git', ['https://example.com/r.git']],
    ['clone ../r d', ['../r']],
    ['remote add -f fork ../r', ['../r']],
    ['remote set-head origin -a', ['origin']],
    ['remote show origin upstream', ['origin', 'upstream']],
    ['remote prune origin', ['origin']],
    ['remote update', 'all'],
  ])('names the remotes git %s contacts', (line, expected) => {
    const listing = gitListed(words(line));
    expect(listing.listed && listing.contacts?.remotes).toEqual(expected);
  });

  it.each(['log -1', 'remote -v', 'remote add fork ../r', 'remote show -n origin', 'remote set-head origin main'])(
    'contacts no remote for %s',
    line => {
      const listing = gitListed(words(line));
      expect(listing.listed && listing.contacts).toBeUndefined();
    }
  );

  it.each([
    ['push origin', true],
    ['fetch origin', false],
  ])('says whether %s pushes', (line, expected) => {
    const listing = gitListed(words(line));
    expect(listing.listed && listing.contacts?.push).toBe(expected);
  });

  const SIGNERS = ['gpg', 'gpgsm', 'ssh-keygen'];
  it.each([
    ['log -1', []],
    ['log --format=%G? -1', SIGNERS],
    ['show --pretty=format:%GS HEAD', SIGNERS],
    ['for-each-ref --format=%(signature)', SIGNERS],
    ['log --format=$', SIGNERS],
    ['log -1 $', SIGNERS],
    ['log -n $$', SIGNERS],
    ['for-each-ref $', SIGNERS],
    ['branch -D $', SIGNERS],
    ['help commit', ['man']],
    ['help -a', []],
    ['help -g', []],
    ['help', []],
    ['submodule update --init', ['ssh']],
    ['status $', []],
  ])('names the programs git %s looks up on PATH', (line, expected) => {
    const listing = gitListed(words(line));
    expect(listing.listed && listing.programs).toEqual(expected);
  });

  it.each([
    ['config user.name', true],
    ['config --get remote.origin.url', true],
    ['config --get-regexp alias', true],
    ['config -l --show-origin', true],
    ['config user.email t@example.com', true],
    ['config --global init.defaultBranch main', true],
    ['config core.hooksPath /dev/null', true],
    ['config --unset user.email', true],
    ['config get user.name', true],
    ['config set user.name x', true],
    ['config core.sshCommand x', false],
    ['config alias.st status', false],
    ['config core.hooksPath hooks', false],
    ['config --unset core.sshCommand', false],
    ['config --add user.name x', false],
    ['config -e', false],
    ['config set core.pager less', false],
    ['config unset alias.st', false],
  ])('reads git config %s', (line, expected) => {
    expect(listed(line)).toBe(expected);
  });

  it.each([
    ['rebase main', true],
    ['rebase --onto main other', true],
    ['rebase --abort', true],
    ['rebase -i main', false],
    ['rebase -x make main', false],
    ['rebase --exec=make main', false],
    ['rebase --continue', false],
    ['rebase --skip', false],
    ['rebase --edit-todo', false],
    ['commit -e', false],
    ['commit -c HEAD', false],
    ['commit -t tpl', false],
    ['commit -S', false],
    ['commit -p', false],
    ['commit --interactive', false],
    ['archive --format=zip HEAD', true],
    ['archive --remote=x HEAD', false],
    ['archive --exec=x HEAD', false],
    ['help commit', true],
    ['help -w commit', false],
    ['help a b', false],
    ['help clean -fdx', true],
    ['help clean -x -w', true],
    ['help -w clean -x', false],
    ['help -wi clean', false],
    ['help --foo clean', false],
    ['difftool --tool-help', true],
    ['difftool', false],
    ['difftool -x vim', false],
    ['cat-file -p HEAD', true],
    ['cat-file blob HEAD:a.ts', true],
    ['cat-file --batch', false],
    ['cat-file -p a b c', false],
    ['init -q y', true],
    ['init a b', false],
    ['init --template=tpl', false],
    ['clone --template=tpl https://example.com/r.git', false],
    ['clone -c core.sshCommand=x https://example.com/r.git', false],
    ['tag -s v1', false],
    ['send-email --to=a@example.com x.patch', true],
    ['send-email --compose x.patch', false],
    ['send-email --smtp-server=./x x.patch', false],
    ['send-email --to-cmd=./x x.patch', false],
    ['pack-redundant --all', true],
    ['branch --edit-description', false],
  ])('decides %s', (line, expected) => {
    expect(listed(line)).toBe(expected);
  });

  it.each(['commit -h', 'stash pop -h', 'rebase -h', 'config edit -h'])('lists the usage form %s', line => {
    expect(listed(line)).toBe(true);
  });

  const COMMIT = ['commit.gpgsign'];
  const MERGE = ['commit.gpgsign', 'merge.verifysignatures'];
  const LOG = ['log.showsignature'];

  it.each([
    ['commit -m x', COMMIT],
    ['commit --amend --no-edit', COMMIT],
    ['commit --no-gpg-sign -m x', []],
    ['commit -m x --no-gpg-sign', []],
    ['commit-tree -m x HEAD^{tree}', []],
    ['commit-tree --no-gpg-sign -m x HEAD^{tree}', []],
    ['merge other', MERGE],
    ['merge --no-gpg-sign other', ['merge.verifysignatures']],
    ['merge --no-verify-signatures other', COMMIT],
    ['merge --no-gpg-sign --no-verify-signatures other', []],
    ['merge --abort', []],
    ['merge --quit', []],
    ['merge --continue', MERGE],
    ['pull origin main', MERGE],
    ['pull --rebase origin main', MERGE],
    ['pull --no-gpg-sign --no-verify-signatures origin main', []],
    ['rebase main', COMMIT],
    ['rebase --no-gpg-sign main', []],
    ['rebase --abort', []],
    ['rebase --quit', []],
    ['rebase --show-current-patch', []],
    ['cherry-pick other', COMMIT],
    ['cherry-pick --abort', []],
    ['cherry-pick --continue', COMMIT],
    ['cherry-pick --no-gpg-sign other', []],
    ['revert HEAD', COMMIT],
    ['revert --no-gpg-sign HEAD', []],
    ['revert --quit', []],
    ['tag v1', ['tag.gpgsign']],
    ['tag v1 HEAD', ['tag.gpgsign']],
    ['tag -f v1', ['tag.gpgsign']],
    ['tag -a v1', ['tag.gpgsign']],
    ['tag --annotate v1', ['tag.gpgsign']],
    ['tag -a -m x v1', ['tag.gpgsign']],
    ['tag -am x v1', ['tag.gpgsign']],
    ['tag --annotate --message=x v1', ['tag.gpgsign']],
    ['tag -a -F msg v1', ['tag.gpgsign']],
    ['tag -m x -a v1', ['tag.gpgsign']],
    ['tag -a -m x --no-annotate v1', ['tag.gpgsign', 'tag.forcesignannotated']],
    ['tag --no-annotate -m x v1', ['tag.gpgsign', 'tag.forcesignannotated']],
    ['tag -m x v1', ['tag.gpgsign', 'tag.forcesignannotated']],
    ['tag --message=x v1', ['tag.gpgsign', 'tag.forcesignannotated']],
    ['tag -F msg v1', ['tag.gpgsign', 'tag.forcesignannotated']],
    ['tag --file msg v1', ['tag.gpgsign', 'tag.forcesignannotated']],
    ['tag --trailer=a:b v1', ['tag.gpgsign', 'tag.forcesignannotated']],
    ['tag --trailer a:b v1', ['tag.gpgsign', 'tag.forcesignannotated']],
    ['tag -a --trailer a:b v1', ['tag.gpgsign']],
    ['tag --trailer a:b --no-annotate v1', ['tag.gpgsign', 'tag.forcesignannotated']],
    ['tag --cleanup=strip v1', ['tag.gpgsign']],
    ['tag --create-reflog v1', ['tag.gpgsign']],
    ['tag', []],
    ['tag -l', []],
    ['tag -l v*', []],
    ['tag --list v1', []],
    ['tag -d v1', []],
    ['tag --delete v1', []],
    ['tag -n v1', []],
    ['tag --contains HEAD', []],
    ['tag --points-at HEAD v1', []],
    ['push', ['push.gpgsign']],
    ['push origin main', ['push.gpgsign']],
    ['push --no-signed origin main', []],
    ['log', LOG],
    ['log --oneline -5', LOG],
    ['log --format=%h', LOG],
    ['show HEAD', LOG],
    ['show --stat', LOG],
    ['reflog', LOG],
    ['reflog show', LOG],
    ['range-diff a...b', LOG],
    ['reflog exists HEAD', []],
    ['status', []],
    ['diff', []],
    ['stash', []],
    ['stash list', LOG],
    ['shortlog -s', []],
    ['format-patch -1', []],
    ['branch -v', []],
    ['--version', []],
    ['commit -h', []],
  ])('names the settings under which git %s signs or verifies', (line, expected) => {
    const listing = gitListed(words(line));
    expect(listing.listed && listing.signs).toEqual(expected);
  });

  it.each([
    'commit -S -m x',
    'commit --gpg-sign -m x',
    'commit --gpg-sign=KEY -m x',
    'merge -S other',
    'merge --gpg-sign other',
    'merge --verify-signatures other',
    'pull -S origin main',
    'pull --verify-signatures origin main',
    'rebase -S main',
    'rebase --gpg-sign main',
    'cherry-pick -S other',
    'revert -S HEAD',
    'commit-tree -S -m x HEAD^{tree}',
    'tag -s v1',
    'tag -e v1',
    'tag --edit v1',
    'tag --sign v1',
    'tag -u KEY v1',
    'tag --local-user=KEY v1',
    'tag -v v1',
    'tag --verify v1',
    'tag --no-sign v1',
    'push --signed origin main',
    'push --signed=if-asked origin main',
    'log --show-signature',
    'log --no-show-signature',
    'show --show-signature',
    'verify-commit HEAD',
    'verify-tag v1',
    'am x.patch',
    'whatchanged',
  ])('leaves %s to ask', line => {
    expect(listed(line)).toBe(false);
  });

  it.each([
    ['-c commit.gpgsign=false commit -m x', true],
    ['-c commit.gpgSign=no commit -m x', true],
    ['-c commit.gpgsign= commit -m x', true],
    ['-c commit.gpgsign=true commit -m x', false],
    ['-c commit.gpgsign commit -m x', false],
    ['-c tag.gpgsign=off tag v1', true],
    ['-c tag.gpgsign=1 tag v1', false],
    ['-c tag.forceSignAnnotated=false tag -m x v1', false],
    ['-c push.gpgsign=false push', false],
    ['-c log.showSignature=false log', false],
    ['-c merge.verifySignatures=false merge other', false],
    ['-c gpg.program=x commit -m x', false],
    ['-c gpg.ssh.program=x commit -m x', false],
    ['--config-env=commit.gpgsign=V commit -m x', false],
  ])('reads the signing setting in %s as listed: %s', (line, expected) => {
    expect(listed(line)).toBe(expected);
  });
});

describe('git config values', () => {
  it.each([
    ['commit.gpgsign', 'commit.gpgsign'],
    ['Commit.GpgSign', 'commit.gpgsign'],
    ['COMMIT.Sub.GPGSIGN', 'commit.Sub.gpgsign'],
    ['includeIf.gitdir:~/Work/.path', 'includeif.gitdir:~/Work/.path'],
    ['core', 'core'],
  ])('compares %s as %s', (key, expected) => {
    expect(configKey(key)).toBe(expected);
  });

  it.each([
    [null, true],
    ['true', true],
    ['TRUE', true],
    ['yes', true],
    ['Yes', true],
    ['on', true],
    ['1', true],
    ['2', true],
    ['-1', true],
    ['if-asked', true],
    ['maybe', true],
    ['false', false],
    ['False', false],
    ['no', false],
    ['NO', false],
    ['off', false],
    ['0', false],
    ['00', false],
    ['+0', false],
    ['', false],
  ])('reads %j as %s', (value, expected) => {
    expect(configTrue(value)).toBe(expected);
  });

  it.each([
    [[{ key: 'commit.gpgsign', value: 'true' }], ['commit.gpgsign']],
    [
      [
        { key: 'commit.gpgsign', value: 'true' },
        { key: 'commit.gpgsign', value: 'false' },
      ],
      [],
    ],
    [
      [
        { key: 'commit.gpgsign', value: 'false' },
        { key: 'Commit.GpgSign', value: null },
      ],
      ['commit.gpgsign'],
    ],
    [[{ key: 'commit.Sub.gpgsign', value: 'true' }], []],
    [[{ key: 'constructor', value: 'true' }], []],
    [[{ key: '__proto__', value: 'true' }], []],
    [[{ key: 'tag.gpgsign', value: 'true' }], []],
  ])('finds commit.gpgsign set true by %j: %j', (entries, expected) => {
    expect(settingsOn(entries, ['commit.gpgsign'])).toEqual(expected);
  });

  it.each([
    [[], false],
    [[{ key: 'format.pretty', value: 'oneline' }], false],
    [[{ key: 'format.pretty', value: '%h %G?' }], true],
    [[{ key: 'format.pretty', value: 'format:%h %GK' }], true],
    [[{ key: 'format.pretty', value: null }], true],
    [
      [
        { key: 'format.pretty', value: 'fancy' },
        { key: 'pretty.fancy', value: 'format:%h %G?' },
      ],
      true,
    ],
    [
      [
        { key: 'format.pretty', value: 'fancy' },
        { key: 'pretty.fancy', value: 'format:%h' },
      ],
      false,
    ],
    [
      [
        { key: 'format.pretty', value: 'a' },
        { key: 'pretty.a', value: 'b' },
        { key: 'pretty.b', value: '%G?' },
      ],
      true,
    ],
    [
      [
        { key: 'format.pretty', value: 'a' },
        { key: 'pretty.a', value: 'a' },
      ],
      true,
    ],
    [
      [
        { key: 'format.pretty', value: 'zs' },
        { key: 'pretty.zsig', value: 'format:%h %G?' },
      ],
      true,
    ],
    [
      [
        { key: 'format.pretty', value: 'zs' },
        { key: 'pretty.zsig', value: 'format:%h %G?' },
      ],
      true,
    ],
    [
      [
        { key: 'format.pretty', value: 'zs' },
        { key: 'pretty.zsig', value: 'format:%h' },
        { key: 'pretty.yzs', value: '%G?' },
      ],
      false,
    ],
    [
      [
        { key: 'format.pretty', value: 'z' },
        { key: 'pretty.za', value: 'format:%h' },
        { key: 'pretty.zb', value: '%G?' },
      ],
      true,
    ],
    [
      [
        { key: 'format.pretty', value: 'a' },
        { key: 'pretty.abc', value: 'bc' },
        { key: 'pretty.bcd', value: '%G?' },
      ],
      true,
    ],
    [
      [
        { key: 'format.pretty', value: 'a' },
        { key: 'pretty.abc', value: 'bc' },
        { key: 'pretty.bcd', value: 'format:%h' },
      ],
      false,
    ],
    [[{ key: 'pretty.unused', value: '%G?' }], false],
    [
      [
        { key: 'format.pretty', value: '%G?' },
        { key: 'format.pretty', value: 'short' },
      ],
      false,
    ],
    [[{ key: 'format.pretty', value: 'constructor' }], true],
    [[{ key: 'format.pretty', value: '__proto__' }], true],
    [[{ key: 'user.name', value: 'x' }], true],
  ])('reads the pretty entries %j as printing signatures: %s', (entries, expected) => {
    expect(prettyShowsSignatures(entries)).toBe(expected);
  });

  it.each([
    ['%G?', 'pretty', true],
    ['%+G?', 'pretty', true],
    ['%-GS', 'pretty', true],
    ['% G?', 'pretty', true],
    ['%Gx', 'pretty', true],
    ['%%G?', 'pretty', false],
    ['%%%G?', 'pretty', true],
    ['%%%%G?', 'pretty', false],
    ['%x25G?', 'pretty', false],
    ['%(signature:grade)', 'ref', true],
    ['%(*signature:grade)', 'ref', true],
    ['%%(*signature:grade)', 'ref', false],
    ['%(contents:signature)', 'ref', false],
  ] as const)('detects verifier input %s (%s)', (format, kind, expected) => {
    expect(formatShowsSignatures(format, kind)).toBe(expected);
  });

  it.each([
    ['log --pretty=%G? --format=%h --oneline', 'oneline'],
    ['log --format=%h --pretty=%G? --format=%s', '%s'],
    ['log --pretty=%G? --pretty HEAD', 'medium'],
    ['log --pretty=', ''],
    ['log --format=', ''],
  ])('keeps the last output selector in %s', (command, expected) => {
    const listing = gitListed(words(command));
    expect(listing.listed && listing.signatureFormat?.value?.text).toBe(expected);
  });

  it.each([
    ['oneline', [{ key: 'pretty.oneline', value: '%G?' }], false],
    ['s', [{ key: 'pretty.sig', value: '%G?' }], true],
    ['safe', [{ key: 'pretty.safe', value: 'format:%%G?' }], false],
    [
      'sig',
      [
        { key: 'pretty.sig', value: 'other' },
        { key: 'pretty.other', value: '%+G?' },
      ],
      true,
    ],
    ['oneline', [{ key: 'format.pretty', value: '%G?' }], false],
    ['format:%h', [{ key: 'format.pretty', value: '%G?' }], false],
    ['missing', [], true],
  ] as const)('resolves selected pretty format %s', (selected, entries, expected) => {
    expect(prettyShowsSignatures(entries, selected)).toBe(expected);
  });

  it('reads no key absent from the entries, Object.prototype names included', () => {
    expect(settingsOn([], ['constructor', 'toString', '__proto__', 'hasOwnProperty'])).toEqual([]);
  });
});
