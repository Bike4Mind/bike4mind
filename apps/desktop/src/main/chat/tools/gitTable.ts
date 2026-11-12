/**
 * The git forms Desktop runs without asking: global options, subcommands and their options spelled exactly as git
 * lists them, `-c` settings that start no program, and the places a word the shell fills at run time may stand.
 */

/** A word of a git call as bash passes it. */
export interface GitWord {
  /** The word up to its first expansion, glob or brace; all of it when `whole`. */
  text: string;
  whole: boolean;
  /** Whether bash may pass words in its place that do not start with `text`, as an unquoted expansion splits. */
  splits: boolean;
  /** Whether the word holds a glob bash expands, which may stand for several words. */
  glob?: boolean;
}

/** The options a call gives, each with the values it took. */
type Given = ReadonlyMap<string, readonly GitWord[]>;

/** The remotes a call contacts, by the words naming them (a remote, URL or path), or `all` for the default or a group. */
export interface GitContacts {
  remotes: readonly string[] | 'all';
  push: boolean;
}

export type GitListing =
  | {
      listed: true;
      form: string;
      given: Given;
      operands: readonly GitWord[];
      /** Whether a word the shell fills stands where git reads options, so it may be any option of the form. */
      open: boolean;
      contacts?: GitContacts;
      /** Programs git looks up on PATH for the call. */
      programs: readonly string[];
    }
  | { listed: false; reason: string };

interface Call {
  given: Given;
  operands: readonly GitWord[];
  open: boolean;
}

type Kind = 'flag' | 'valued' | 'optional' | 'lastArg';

interface Options {
  long: ReadonlyMap<string, Kind>;
  short: ReadonlyMap<string, Kind>;
  numeric: boolean;
}

interface FormSpec {
  options?: string;
  /** The values an option may take, by each of its spellings. */
  values?: Readonly<Record<string, (value: string) => boolean>>;
  /** Where a word the shell fills may stand before `--`: anywhere, or once git stops reading options at the first operand. */
  open?: 'any' | 'afterOperand';
  maxOperands?: number;
  /** The operands git reads as a remote or URL. */
  remotes?: (operands: readonly GitWord[], given: Given) => readonly GitWord[];
  /** The remotes the call contacts: those `remotes` gives, every one, or none (null). */
  contacts?: (operands: readonly GitWord[], given: Given) => readonly GitWord[] | 'all' | null;
  push?: boolean;
  programs?: (call: Call) => readonly string[];
  check?: (operands: readonly GitWord[], given: Given) => string | null;
  verbs?: Readonly<Record<string, FormSpec>>;
  /** Flags git reads before the verb. */
  leading?: string;
  /** The form for words that name no verb; `operandFirst` when they may start with an operand. */
  otherwise?: FormSpec;
  operandFirst?: boolean;
  /** Every short option git knows for a form it reads all options of before acting: any other letter makes it exit. */
  knownShort?: string;
}

interface Form extends Omit<FormSpec, 'options' | 'verbs' | 'leading' | 'otherwise'> {
  options: Options;
  verbs?: ReadonlyMap<string, Form>;
  leading?: Options;
  otherwise?: Form;
}

/**
 * Options from a spec: `--x` a flag, `--x=` a value next or after `=`, `--x[=]` a value only after `=`, `--x=?` the
 * next word unless it is the last, `--(no-)x` also the flag `--no-x`; `-abc` flags, `-m:` and `-u?` the same for the
 * last letter (glued or next, glued only); `-<n>` a count such as `-5`.
 */
function options(spec: string): Options {
  const long = new Map<string, Kind>();
  const short = new Map<string, Kind>();
  let numeric = false;
  const kinds: Record<string, Kind> = {
    '': 'flag',
    '=': 'valued',
    '[=]': 'optional',
    '=?': 'lastArg',
    ':': 'valued',
    '?': 'optional',
  };
  for (const token of spec.split(/\s+/).filter(Boolean)) {
    const longForm = /^--(\(no-\))?([a-z0-9][a-z0-9-]*)(=\?|\[=\]|=)?$/.exec(token);
    const shortForm = /^-([A-Za-z0-9]+)([:?])?$/.exec(token);
    if (token === '-<n>') {
      numeric = true;
    } else if (longForm) {
      long.set(`--${longForm[2]}`, kinds[longForm[3] ?? ''] as Kind);
      if (longForm[1]) long.set(`--no-${longForm[2]}`, 'flag');
    } else if (shortForm) {
      const letters = shortForm[1] as string;
      for (const letter of letters.slice(0, -1)) short.set(letter, 'flag');
      short.set(letters.at(-1) as string, kinds[shortForm[2] ?? ''] as Kind);
    } else {
      throw new Error(`gitTable: bad option spec ${token}`);
    }
  }
  return { long, short, numeric };
}

const DIFF_SHORT = '-pusRaztrmcwbWD -S: -G: -l: -U: -I: -M? -C? -B? -X?';
const DIFF_LONG = `--patch --no-patch --raw --patch-with-raw --patch-with-stat --stat[=] --no-stat --shortstat --numstat
  --name-only --name-status --summary --(no-)compact-summary --binary --(no-)full-index --dirstat[=] --cumulative
  --dirstat-by-file[=] --stat-width= --stat-name-width= --stat-graph-width= --stat-count=
  --no-renames --renames --find-renames[=] --find-copies[=] --(no-)find-copies-harder --break-rewrites[=]
  --irreversible-delete --find-object= --(no-)rename-empty --minimal --patience --histogram --diff-algorithm=
  --anchored= --unified= --inter-hunk-context= --(no-)function-context --(no-)indent-heuristic --ignore-all-space
  --ignore-space-change --ignore-space-at-eol --ignore-blank-lines --ignore-cr-at-eol --ignore-matching-lines=
  --exit-code --quiet --no-ext-diff --no-textconv --check --ws-error-highlight= --color[=] --no-color
  --color-moved[=] --no-color-moved --color-moved-ws= --no-color-moved-ws --color-words[=] --word-diff[=]
  --word-diff-regex= --no-prefix --default-prefix --src-prefix= --dst-prefix= --line-prefix= --relative[=]
  --no-relative --diff-filter= --pickaxe-all --pickaxe-regex --submodule[=] --ignore-submodules[=] --text
  --merge-base --remerge-diff --cc --combined-all-paths --diff-merges= --no-diff-merges --abbrev[=] --no-abbrev
  --output= --output-indicator-new= --output-indicator-old= --output-indicator-context= --rotate-to= --skip-to=
  --ita-invisible-in-index --ita-visible-in-index`;
const LOG_SHORT = '-iEFPg -n: -L:';
const LOG_LONG = `--max-count= --skip= --since= --after= --until= --before= --since-as-filter= --max-age= --min-age=
  --author= --committer= --grep= --grep-reflog= --regexp-ignore-case --extended-regexp --fixed-strings
  --perl-regexp --basic-regexp --all-match --invert-grep --oneline --format[=] --pretty[=] --date= --relative-date
  --encoding= --expand-tabs[=] --no-expand-tabs --notes[=] --no-notes --show-notes[=] --show-notes-by-default
  --standard-notes --no-standard-notes --log-size --show-linear-break[=] --graph --all --branches[=] --tags[=]
  --remotes[=] --glob= --exclude= --exclude-hidden= --reflog --single-worktree --alternate-refs --bisect --stdin
  --not --merges --no-merges --min-parents= --max-parents= --no-min-parents --no-max-parents --first-parent
  --exclude-first-parent-only --reverse --follow --decorate[=] --no-decorate --decorate-refs=
  --decorate-refs-exclude= --clear-decorations --source --(no-)abbrev-commit --full-diff --topo-order --date-order
  --author-date-order --left-right --left-only --right-only --cherry-pick --cherry-mark --cherry --boundary
  --ancestry-path[=] --simplify-by-decoration --simplify-merges --full-history --dense --sparse --show-pulls
  --(no-)mailmap --(no-)use-mailmap --walk-reflogs --no-walk[=] --do-walk --parents --children --count`;
const LOG = `${LOG_SHORT} ${LOG_LONG} -<n>`;
const LOG_DIFF = `${LOG} ${DIFF_SHORT} ${DIFF_LONG}`;

const STRATEGIES = new Set(['ort', 'recursive', 'resolve', 'octopus', 'ours', 'subtree']);
const strategy = (value: string): boolean => STRATEGIES.has(value);

const REMOTE_SCHEMES = new Set(['https', 'http', 'ssh', 'git', 'file', 'git+ssh', 'ssh+git', 'ftp', 'ftps']);

/** Whether git reaches `value` with its own transports: a name, path, scp-like address or URL of a listed scheme. */
export function plainRemote(value: string): boolean {
  if (value.includes('::') || value.startsWith('-')) return false;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(value)?.[1];
  return scheme === undefined || REMOTE_SCHEMES.has(scheme);
}

const firstOperand = (operands: readonly GitWord[]): readonly GitWord[] => operands.slice(0, 1);
/** The remote a call names first, or the default one git picks when it names none. */
const firstOrDefault = (operands: readonly GitWord[]): readonly GitWord[] | 'all' =>
  operands.length === 0 ? 'all' : firstOperand(operands);

/** What git verifies signatures with, for a format that shows one (`%G?`, `%(signature)`) or an option bash fills in. */
function signaturePrograms({ given, open }: Call): readonly string[] {
  const formats = ['--format', '--pretty'].flatMap(name => given.get(name) ?? []);
  const shown = formats.some(value => !value.whole || /%G|%\(signature/.test(value.text));
  return open || shown ? ['gpg', 'gpgsm', 'ssh-keygen'] : [];
}

const ANY_VALUE_SETTINGS = new Set(
  `user.name user.email author.name author.email committer.name committer.email column.ui core.abbrev core.quotepath
  core.autocrlf core.safecrlf core.eol core.filemode core.ignorecase core.longpaths core.precomposeunicode
  core.whitespace core.commentchar core.commentstring core.compression core.preloadindex core.untrackedcache
  diff.renames diff.renamelimit diff.algorithm diff.noprefix diff.mnemonicprefix diff.context diff.interhunkcontext
  diff.colormoved diff.indentheuristic diff.relative diff.statgraphwidth diff.ignoresubmodules merge.conflictstyle
  merge.ff merge.renamelimit merge.log merge.verbosity merge.autostash pull.ff rebase.autosquash rebase.autostash
  rebase.updaterefs rebase.abbreviatecommands rebase.missingcommitscheck push.default push.autosetupremote
  push.followtags fetch.prune fetch.prunetags fetch.parallel init.defaultbranch log.date log.decorate log.follow
  log.abbrevcommit log.mailmap log.showroot status.short status.branch status.showuntrackedfiles
  status.relativepaths status.renames status.aheadbehind branch.sort branch.autosetupmerge branch.autosetuprebase
  tag.sort versionsort.suffix protocol.version rerere.enabled rerere.autoupdate grep.linenumber grep.extendedregexp
  grep.patterntype grep.fullname diff.tool merge.tool diff.guitool merge.guitool`.split(/\s+/)
);
const ANY_VALUE_SECTIONS = /^(color|advice)\./;

const BOOLEAN = /^(true|false|yes|no|on|off|1|0|)$/i;
const FALSE = /^(false|no|off|0|)$/i;
// git skips an editor of `:`; any other name, `true` included, it looks up on PATH.
const editorValue = (value: string): boolean => value === ':';
const LIMITED_SETTINGS: Readonly<Record<string, (value: string) => boolean>> = {
  'commit.gpgsign': value => FALSE.test(value),
  'tag.gpgsign': value => FALSE.test(value),
  'core.hookspath': value => value === '/dev/null',
  'core.fsmonitor': value => FALSE.test(value),
  'credential.helper': value => value === '',
  'core.editor': editorValue,
  'sequence.editor': editorValue,
  'core.pager': value => value === '' || value === 'cat',
  'core.attributesfile': value => value === '/dev/null',
  'core.excludesfile': value => value === '/dev/null',
  'pull.rebase': value => ['true', 'false', 'merges'].includes(value),
  'gpg.format': value => ['openpgp', 'x509', 'ssh'].includes(value),
};

/** Whether `-c key=value` or a `git config` write of it starts no program; a null value is one the shell fills. */
export function listedSetting(key: string, value: string | null): boolean {
  const name = key.toLowerCase();
  if (ANY_VALUE_SETTINGS.has(name) || ANY_VALUE_SECTIONS.test(name)) return true;
  if (value === null) return false;
  if (/^pager\.[a-z0-9-]+$/.test(name)) return BOOLEAN.test(value);
  return Object.hasOwn(LIMITED_SETTINGS, name) && (LIMITED_SETTINGS[name] as (value: string) => boolean)(value);
}

const CONFIG_FILES = '--global --system --local --worktree -f: --file= --blob= --(no-)includes';
const CONFIG_TYPES = '--type= --bool --int --bool-or-int --path --expiry-date --no-type -z --null';
const CONFIG_READS = [
  '--get',
  '--get-all',
  '--get-regexp',
  '--get-urlmatch',
  '--get-color',
  '--get-colorbool',
  '-l',
  '--list',
];

function configWrite(key: GitWord | undefined, value: GitWord | undefined): string | null {
  if (key === undefined) return null;
  if (!key.whole) return 'with a key filled at run time';
  const known = value === undefined || value.whole ? (value?.text ?? null) : null;
  return listedSetting(key.text, value === undefined ? '' : known) ? null : key.text;
}

const UNLISTED: FormSpec = { check: () => 'is not listed' };

const STASH_PUSH: FormSpec = {
  options:
    '-quakS -m: --quiet --include-untracked --no-include-untracked --all --(no-)keep-index --staged --message= --pathspec-file-nul',
};
const REFLOG_SHOW: FormSpec = { options: LOG_DIFF, open: 'any', programs: signaturePrograms };
const SUBMODULE_STATUS: FormSpec = { options: '-q --quiet --cached --recursive' };

const FORMS: Readonly<Record<string, FormSpec>> = {
  status: {
    options: `-sbvz -u? -M? --(no-)short --(no-)branch --(no-)long --(no-)verbose --(no-)show-stash --(no-)ahead-behind
      --(no-)renames --(no-)null --porcelain[=] --no-porcelain --untracked-files[=] --no-untracked-files --ignored[=]
      --no-ignored --ignore-submodules[=] --no-ignore-submodules --find-renames[=] --column[=] --no-column`,
    open: 'any',
  },
  diff: { options: `${DIFF_SHORT} ${DIFF_LONG} --cached --staged --no-index`, open: 'any' },
  log: { options: LOG_DIFF, open: 'any', programs: signaturePrograms },
  show: { options: LOG_DIFF, open: 'any', programs: signaturePrograms },
  shortlog: {
    options: `-iEFPg -L: -nsec -w? ${LOG_LONG} --(no-)numbered --(no-)summary --(no-)email --(no-)committer --group=`,
    open: 'any',
    programs: signaturePrograms,
  },
  'range-diff': {
    options: `${DIFF_SHORT} ${DIFF_LONG} --creation-factor= --(no-)dual-color --(no-)left-only --(no-)right-only
      --max-memory=`,
    open: 'any',
  },
  'diff-tree': {
    options: `${LOG_DIFF} -v --root --no-commit-id --always`,
    open: 'any',
    programs: signaturePrograms,
  },
  'rev-parse': {
    options: `-q --short[=] --abbrev-ref[=] --verify --quiet --git-dir --git-common-dir --absolute-git-dir
      --show-toplevel --show-prefix --show-cdup --is-inside-git-dir --is-inside-work-tree --is-bare-repository
      --is-shallow-repository --show-superproject-working-tree --symbolic --symbolic-full-name --all --branches[=]
      --tags[=] --remotes[=] --glob= --exclude= --show-object-format[=] --show-ref-format --sq --sq-quote --not
      --revs-only --no-revs --flags --no-flags --local-env-vars --disambiguate= --git-path= --resolve-git-dir=
      --default= --since= --until= --after= --before= --path-format= --shared-index-path`,
    open: 'any',
  },
  'rev-list': {
    options: `${LOG} --objects --objects-edge --objects-edge-aggressive --in-commit-order --no-object-names
      --object-names --disk-usage[=] --quiet --bisect-vars --bisect-all --timestamp --header --unpacked --missing=
      --filter= --no-filter --filter-print-omitted --indexed-objects --exclude-promisor-objects --use-bitmap-index`,
    open: 'any',
    programs: signaturePrograms,
  },
  'merge-base': { options: '-a --all --octopus --independent --is-ancestor --fork-point', open: 'any' },
  'merge-tree': {
    options: `-z -X: --write-tree --trivial-merge --name-only --(no-)messages --allow-unrelated-histories --quiet
      --merge-base= --strategy-option=`,
    open: 'any',
  },
  'ls-files': {
    options: `-ztvfcdmoisku -x: -X: --(no-)cached --(no-)deleted --(no-)modified --(no-)others --(no-)ignored
      --(no-)stage --(no-)killed --(no-)unmerged --(no-)directory --(no-)eol --(no-)empty-directory --resolve-undo
      --exclude= --exclude-from= --exclude-per-directory= --exclude-standard --full-name --(no-)recurse-submodules
      --(no-)error-unmatch --with-tree= --abbrev[=] --no-abbrev --(no-)deduplicate --(no-)sparse --format=`,
    open: 'any',
  },
  'ls-tree': {
    options:
      '-drtzl --long --name-only --name-status --object-only --(no-)full-name --(no-)full-tree --format= --abbrev[=]',
    open: 'any',
  },
  'cat-file': { options: '-epts --(no-)use-mailmap --(no-)mailmap', maxOperands: 2, open: 'any' },
  'check-ignore': { options: '-qvzn --(no-)quiet --(no-)verbose --(no-)non-matching --no-index --index', open: 'any' },
  describe: {
    options: `--(no-)contains --(no-)all --(no-)tags --(no-)long --(no-)first-parent --abbrev[=] --no-abbrev
      --(no-)exact-match --candidates= --match= --no-match --exclude= --no-exclude --(no-)always --dirty[=] --no-dirty
      --broken[=] --no-broken`,
    open: 'any',
  },
  'for-each-ref': {
    options: `-sp --(no-)shell --(no-)perl --(no-)python --(no-)tcl --(no-)omit-empty --count= --format= --start-after=
      --color[=] --no-color --exclude= --sort= --points-at= --merged=? --no-merged=? --contains=? --no-contains=?
      --(no-)ignore-case --(no-)include-root-refs`,
    open: 'any',
    programs: signaturePrograms,
  },
  'show-ref': {
    options: `-dsq --(no-)tags --(no-)branches --(no-)heads --(no-)exists --(no-)verify --(no-)head --(no-)dereference
      --hash[=] --abbrev[=] --(no-)quiet`,
    open: 'any',
  },
  'show-branch': {
    options: `-ar -g? --all --remotes --current --topo-order --date-order --sparse --more[=] --list --merge-base
      --independent --no-name --sha1-name --topics --reflog[=] --color[=] --no-color`,
    open: 'any',
  },
  'symbolic-ref': { options: '-qd -m: --quiet --delete --short --(no-)recurse' },
  'update-ref': { options: '-d -m: --no-deref --create-reflog' },
  'commit-tree': { options: '-p: -m: -F: --no-gpg-sign' },
  'write-tree': { options: '--missing-ok --prefix=' },
  cherry: { options: '-v --abbrev[=]', open: 'any' },
  'patch-id': { options: '--stable --unstable --verbatim', open: 'any' },
  'pack-redundant': { options: '--all --alt-odb --verbose --i-still-use-this', open: 'any' },
  blame: {
    options: `-bfnpctlsew -M? -C? -L: --(no-)incremental --(no-)root --(no-)show-stats --(no-)progress --(no-)show-name
      --(no-)show-number --(no-)porcelain --(no-)line-porcelain --(no-)show-email --diff-algorithm= --ignore-rev=
      --ignore-revs-file= --(no-)color-lines --(no-)color-by-age --abbrev[=] --minimal --reverse --first-parent
      --date= --since= --encoding=`,
    open: 'any',
  },
  version: { options: '--build-options', open: 'any' },
  grep: {
    options: `-viwaIrEGFPnhHlLzocqpW -C: -B: -A: -f: -e: -m: -<n> --(no-)cached --no-index --index --(no-)untracked
      --(no-)exclude-standard --(no-)recurse-submodules --(no-)invert-match --(no-)ignore-case --(no-)word-regexp
      --(no-)text --no-textconv --(no-)recursive --max-depth= --(no-)extended-regexp --(no-)basic-regexp
      --(no-)fixed-strings --(no-)perl-regexp --(no-)line-number --(no-)column --(no-)full-name
      --(no-)files-with-matches --(no-)name-only --(no-)files-without-match --(no-)null --(no-)only-matching
      --(no-)count --color[=] --no-color --(no-)break --(no-)heading --context= --before-context= --after-context=
      --threads= --(no-)show-function --(no-)function-context --and --or --not --(no-)quiet --(no-)all-match
      --max-count=`,
    open: 'afterOperand',
  },
  add: {
    options: `-nvfuNA --(no-)dry-run --(no-)verbose --(no-)force --(no-)update --(no-)renormalize --(no-)intent-to-add
      --(no-)all --(no-)ignore-removal --(no-)refresh --(no-)ignore-errors --(no-)ignore-missing --(no-)sparse --chmod=`,
    values: { '--chmod': value => value === '+x' || value === '-x' },
    open: 'any',
  },
  rm: { options: '-nqfr --(no-)dry-run --(no-)quiet --(no-)cached --(no-)force --(no-)ignore-unmatch --(no-)sparse' },
  mv: { options: '-vnfk --(no-)verbose --(no-)dry-run --(no-)force --(no-)sparse' },
  clean: { options: '-qnfdxX -e: --(no-)quiet --(no-)dry-run --(no-)force --exclude=' },
  restore: {
    options: `-SWqm23 -s: --source= --(no-)staged --(no-)worktree --(no-)ignore-unmerged --(no-)overlay --(no-)quiet
      --recurse-submodules[=] --no-recurse-submodules --(no-)progress --(no-)merge --conflict= --ours --theirs
      --(no-)ignore-skip-worktree-bits`,
  },
  reset: {
    options: `-qN --(no-)quiet --refresh --no-refresh --mixed --soft --hard --merge --keep --recurse-submodules[=]
      --no-recurse-submodules --(no-)intent-to-add`,
  },
  checkout: {
    options: `-lqmdf23 -b: -B: -t? --(no-)guess --(no-)overlay --(no-)quiet --recurse-submodules[=]
      --no-recurse-submodules --(no-)progress --(no-)merge --conflict= --(no-)detach --track[=] --no-track --(no-)force
      --orphan= --(no-)overwrite-ignore --(no-)ignore-other-worktrees --ours --theirs --(no-)ignore-skip-worktree-bits`,
  },
  switch: {
    options: `-dfmq -c: -C: -t? --create= --force-create= --(no-)guess --(no-)discard-changes --(no-)quiet
      --recurse-submodules[=] --no-recurse-submodules --(no-)progress --(no-)merge --conflict= --(no-)detach --track[=]
      --no-track --(no-)force --orphan= --(no-)overwrite-ignore --(no-)ignore-other-worktrees`,
  },
  commit: {
    options: `-qvsainoz -F: -m: -C: -u? --(no-)quiet --(no-)verbose --file= --author= --date= --message=
      --reuse-message= --fixup= --squash= --(no-)reset-author --trailer= --(no-)signoff --cleanup= --(no-)status
      --no-gpg-sign --(no-)all --(no-)include --(no-)only --no-verify --verify --(no-)dry-run --(no-)short
      --(no-)branch --(no-)ahead-behind --(no-)porcelain --(no-)long --(no-)null --(no-)amend --no-edit
      --no-post-rewrite --post-rewrite --untracked-files[=] --allow-empty --allow-empty-message`,
  },
  merge: {
    options: `-nvq -m: -F: -s: -X: --(no-)stat --(no-)summary --(no-)compact-summary --log[=] --no-log --(no-)squash
      --(no-)commit --no-edit --cleanup= --(no-)ff --ff-only --(no-)rerere-autoupdate --no-verify-signatures
      --strategy= --strategy-option= --message= --file= --into-name= --(no-)verbose --(no-)quiet --abort --quit
      --continue --(no-)allow-unrelated-histories --(no-)progress --no-gpg-sign --(no-)autostash
      --(no-)overwrite-ignore --(no-)signoff --no-verify --verify`,
    values: { '-s': strategy, '--strategy': strategy },
  },
  rebase: {
    options: `-qvnfm -C: -s: -X: -r? --onto= --(no-)keep-base --no-verify --verify --(no-)quiet --(no-)verbose
      --no-stat --stat --(no-)signoff --(no-)committer-date-is-author-date --(no-)reset-author-date --ignore-date
      --(no-)ignore-whitespace --whitespace= --(no-)force-rebase --no-ff --ff --abort --quit --show-current-patch
      --apply --merge --(no-)rerere-autoupdate --empty= --(no-)autosquash --(no-)update-refs --no-gpg-sign
      --(no-)autostash --rebase-merges[=] --no-rebase-merges --(no-)fork-point --strategy= --strategy-option=
      --(no-)root --(no-)reapply-cherry-picks --(no-)keep-empty`,
    values: { '-s': strategy, '--strategy': strategy },
  },
  'cherry-pick': {
    options: `-nsx -m: -X: --quit --continue --abort --skip --cleanup= --no-commit --commit --(no-)signoff --mainline=
      --(no-)rerere-autoupdate --strategy= --strategy-option= --no-gpg-sign --(no-)ff --(no-)allow-empty
      --(no-)allow-empty-message --(no-)keep-redundant-commits --empty= --no-edit`,
    values: { '--strategy': strategy },
  },
  revert: {
    options: `-ns -m: -X: --quit --continue --abort --skip --cleanup= --no-commit --commit --(no-)signoff --mainline=
      --(no-)rerere-autoupdate --strategy= --strategy-option= --no-gpg-sign --(no-)reference --no-edit`,
    values: { '--strategy': strategy },
  },
  branch: {
    options: `-vqrdDmMcCfial -t? -u: --(no-)verbose --(no-)quiet --track[=] --no-track --set-upstream-to=
      --unset-upstream --color[=] --no-color --remotes --contains=? --no-contains=? --merged=? --no-merged=? --abbrev[=]
      --no-abbrev --all --(no-)delete --(no-)move --(no-)omit-empty --(no-)copy --(no-)list --(no-)show-current
      --(no-)create-reflog --(no-)force --column[=] --no-column --sort= --points-at= --(no-)ignore-case
      --(no-)recurse-submodules --format=`,
    open: 'any',
    programs: signaturePrograms,
  },
  tag: {
    options: `-ldafi -n? -m: -F: --list --delete --(no-)annotate --message= --file= --trailer= --cleanup= --(no-)force
      --(no-)create-reflog --column[=] --no-column --contains=? --no-contains=? --merged=? --no-merged=?
      --(no-)omit-empty --sort= --points-at= --format= --color[=] --no-color --(no-)ignore-case`,
    programs: signaturePrograms,
  },
  stash: {
    verbs: {
      push: STASH_PUSH,
      save: { options: '-quakS --quiet --include-untracked --no-include-untracked --all --(no-)keep-index --staged' },
      pop: { options: '-q --quiet --index', maxOperands: 1 },
      apply: { options: '-q --quiet --index', maxOperands: 1 },
      list: { options: LOG, open: 'any', programs: signaturePrograms },
      show: { options: `${LOG_DIFF} --include-untracked --only-untracked`, open: 'any', programs: signaturePrograms },
      drop: { options: '-q --quiet', maxOperands: 1 },
      clear: { maxOperands: 0 },
      branch: { maxOperands: 2 },
      create: {},
      store: { options: '-q -m: --quiet --message=', maxOperands: 1 },
    },
    otherwise: STASH_PUSH,
  },
  worktree: {
    verbs: {
      list: { options: '-vz --porcelain --verbose --expire=', open: 'any' },
      add: {
        options: `-fdq -b: -B: --(no-)force --(no-)detach --(no-)checkout --(no-)lock --reason= --orphan --(no-)track
          --(no-)guess-remote --(no-)quiet --(no-)relative-paths`,
        open: 'any',
      },
      remove: { options: '-f --force', open: 'any' },
      prune: { options: '-nv --dry-run --verbose --expire=' },
      move: { options: '-f --force' },
      lock: { options: '--reason=' },
      unlock: {},
      repair: { options: '--(no-)relative-paths' },
    },
  },
  init: {
    options: '-q -b: --(no-)quiet --(no-)bare --initial-branch= --object-format= --ref-format= --shared[=]',
    maxOperands: 1,
  },
  reflog: {
    verbs: { show: REFLOG_SHOW, list: { maxOperands: 0 }, exists: { maxOperands: 1 } },
    otherwise: REFLOG_SHOW,
  },
  'sparse-checkout': { verbs: { list: { maxOperands: 0 } } },
  difftool: {
    options: '--tool-help',
    maxOperands: 0,
    check: (_operands, given) => (given.has('--tool-help') ? null : 'without --tool-help'),
  },
  'format-patch': {
    options: `${LOG_LONG} ${DIFF_LONG} -<n> -nNskpRaw -o: -v: -U: -M? -C? -B? --(no-)numbered --(no-)signoff --(no-)stdout
      --(no-)cover-letter --(no-)numbered-files --suffix= --start-number= --reroll-count= --filename-max-length=
      --rfc[=] --no-rfc --cover-from-description= --description-file= --subject-prefix= --output-directory=
      --keep-subject --no-binary --(no-)zero-commit --(no-)ignore-if-in-upstream --add-header= --to= --no-to --cc=
      --no-cc --from[=] --no-from --in-reply-to= --attach[=] --no-attach --inline[=] --thread[=] --no-thread
      --signature= --no-signature --base= --signature-file= --(no-)quiet --(no-)progress --interdiff= --range-diff=
      --creation-factor= --(no-)force-in-body-from`,
    programs: signaturePrograms,
  },
  'send-email': {
    options: `--to= --cc= --bcc= --from= --reply-to= --in-reply-to= --subject= --no-to --no-cc --no-bcc --(no-)thread
      --(no-)chain-reply-to --(no-)signed-off-by-cc --suppress-cc= --(no-)suppress-from --confirm= --dry-run --quiet
      --(no-)validate --(no-)format-patch --(no-)xmailer`,
  },
  'read-tree': {
    options: `-vmuinq --index-output= --(no-)empty --(no-)verbose --(no-)trivial --(no-)aggressive --(no-)reset --prefix=
      --(no-)dry-run --no-sparse-checkout --sparse-checkout --recurse-submodules[=] --no-recurse-submodules --(no-)quiet`,
  },
  'checkout-index': {
    options: `-afqnuz --(no-)all --(no-)ignore-skip-worktree-bits --(no-)force --(no-)quiet --no-create --create
      --(no-)index --(no-)temp --prefix= --stage=`,
  },
  apply: {
    options: `-N3Rvqz -p: -C: --exclude= --include= --no-add --add --(no-)stat --(no-)numstat --(no-)summary --(no-)check
      --(no-)index --(no-)intent-to-add --(no-)cached --(no-)apply --(no-)3way --ours --theirs --union --whitespace=
      --(no-)ignore-space-change --(no-)ignore-whitespace --(no-)reverse --(no-)unidiff-zero --(no-)reject
      --(no-)allow-overlap --(no-)verbose --(no-)quiet --(no-)inaccurate-eof --(no-)recount --directory=
      --(no-)allow-empty`,
  },
  archive: {
    options: '-vl -o: -<n> --format= --prefix= --output= --(no-)worktree-attributes --(no-)verbose --list --mtime=',
    values: { '--format': value => ['tar', 'zip', 'tgz', 'tar.gz'].includes(value) },
  },
  help: {
    options: '-agmcv --all --guides --config --(no-)external-commands --(no-)aliases --(no-)man --(no-)verbose',
    maxOperands: 1,
    knownShort: 'agmcviw',
    // A listing prints from git itself; a page is shown by man.
    programs: ({ operands, given }) =>
      operands.length > 0 && !['-a', '--all', '-g', '--guides', '-c', '--config'].some(list => given.has(list))
        ? ['man']
        : [],
  },
  config: {
    verbs: {
      get: {
        options: `${CONFIG_FILES} ${CONFIG_TYPES} --all --regexp --value= --fixed-value --url= --default= --show-names
          --show-origin --show-scope --name-only`,
      },
      list: { options: `${CONFIG_FILES} --show-origin --show-scope --name-only -z --null` },
      set: {
        options: `${CONFIG_FILES} ${CONFIG_TYPES} --all --value= --fixed-value --comment=`,
        check: operands => configWrite(operands[0], operands[1]),
      },
      unset: {
        options: `${CONFIG_FILES} --all --value= --fixed-value`,
        check: operands => configWrite(operands[0], undefined),
      },
      edit: UNLISTED,
      'rename-section': UNLISTED,
      'remove-section': UNLISTED,
    },
    otherwise: {
      options: `${CONFIG_FILES} ${CONFIG_TYPES} --name-only --show-origin --show-scope --default= -l --list --get
        --get-all --get-regexp --get-urlmatch --get-color --get-colorbool --unset --unset-all --fixed-value`,
      check: (operands, given) => {
        if (CONFIG_READS.some(read => given.has(read))) return null;
        if (given.has('--unset') || given.has('--unset-all')) return configWrite(operands[0], undefined);
        return operands.length < 2 ? null : configWrite(operands[0], operands[1]);
      },
    },
    operandFirst: true,
  },
  fetch: {
    options: `-vqafmtnpPku46 -j: -o: --(no-)verbose --(no-)quiet --(no-)all --(no-)set-upstream --(no-)append
      --(no-)atomic --(no-)force --(no-)multiple --(no-)tags --jobs= --(no-)prefetch --(no-)prune --(no-)prune-tags
      --recurse-submodules[=] --no-recurse-submodules --(no-)dry-run --(no-)porcelain --(no-)write-fetch-head
      --(no-)keep --(no-)update-head-ok --(no-)progress --depth= --shallow-since= --shallow-exclude= --deepen=
      --unshallow --refetch --(no-)update-shallow --refmap= --server-option= --ipv4 --ipv6 --negotiation-tip=
      --filter= --(no-)auto-maintenance --(no-)auto-gc --(no-)show-forced-updates --(no-)write-commit-graph`,
    remotes: (operands, given) =>
      given.has('--all') ? [] : given.has('--multiple') || given.has('-m') ? operands : firstOperand(operands),
    // `--multiple` may name groups, which hold any remote.
    contacts: (operands, given) =>
      ['--all', '--multiple', '-m'].some(option => given.has(option)) ? 'all' : firstOrDefault(operands),
  },
  pull: {
    options: `-vqnaftpk46 -r? -s: -X: -o: -j? --(no-)verbose --(no-)quiet --(no-)progress --recurse-submodules[=]
      --no-recurse-submodules --rebase[=] --no-rebase --(no-)stat --(no-)compact-summary --log[=] --no-log
      --(no-)signoff --(no-)squash --(no-)commit --no-edit --cleanup= --(no-)ff --ff-only --(no-)verify
      --no-verify-signatures --(no-)autostash --strategy= --strategy-option= --no-gpg-sign
      --(no-)allow-unrelated-histories --(no-)all --(no-)append --(no-)force --(no-)tags --(no-)prune --jobs[=]
      --(no-)dry-run --(no-)keep --depth= --shallow-since= --shallow-exclude= --deepen= --unshallow
      --(no-)update-shallow --refmap= --server-option= --(no-)ipv4 --(no-)ipv6 --negotiation-tip=
      --(no-)show-forced-updates --(no-)set-upstream`,
    values: {
      '-s': strategy,
      '--strategy': strategy,
      '-r': value => ['', 'true', 'false', 'merges'].includes(value),
      '--rebase': value => ['true', 'false', 'merges'].includes(value),
    },
    remotes: firstOperand,
    contacts: firstOrDefault,
  },
  push: {
    options: `-vqdnfu46 -o: --(no-)verbose --(no-)quiet --(no-)all --(no-)branches --(no-)mirror --(no-)delete --(no-)tags
      --(no-)dry-run --(no-)porcelain --(no-)force --force-with-lease[=] --no-force-with-lease --(no-)force-if-includes
      --recurse-submodules= --no-recurse-submodules --(no-)thin --(no-)set-upstream --(no-)progress --(no-)prune
      --no-verify --verify --(no-)follow-tags --no-signed --(no-)atomic --push-option= --ipv4 --ipv6`,
    remotes: firstOperand,
    contacts: firstOrDefault,
    push: true,
  },
  'ls-remote': {
    options: `-qtb -o: --(no-)quiet --(no-)tags --(no-)branches --(no-)heads --(no-)refs --(no-)get-url --sort=
      --(no-)exit-code --(no-)symref --server-option=`,
    remotes: firstOperand,
    contacts: firstOrDefault,
  },
  clone: {
    options: `-vqnls46 -j: -o: -b: --(no-)verbose --(no-)quiet --(no-)progress --(no-)reject-shallow --no-checkout
      --checkout --(no-)bare --(no-)mirror --(no-)local --no-hardlinks --hardlinks --(no-)shared --recurse-submodules[=]
      --no-recurse-submodules --recursive[=] --jobs= --(no-)dissociate --origin= --branch= --revision= --depth=
      --shallow-since= --shallow-exclude= --(no-)single-branch --(no-)tags --(no-)shallow-submodules --ref-format=
      --server-option= --ipv4 --ipv6 --filter= --(no-)also-filter-submodules --(no-)remote-submodules --(no-)sparse`,
    maxOperands: 2,
    remotes: firstOperand,
    contacts: firstOperand,
  },
  remote: {
    leading: '-v --verbose',
    verbs: {
      'get-url': { options: '--push --all', maxOperands: 1 },
      add: {
        options: '-f -t: -m: --(no-)tags --mirror=',
        maxOperands: 2,
        remotes: operands => operands.slice(1),
        contacts: (operands, given) => (given.has('-f') ? operands.slice(1) : null),
      },
      'set-url': { options: '--push --add --delete', maxOperands: 3, remotes: operands => operands.slice(1) },
      rename: { options: '--(no-)progress', maxOperands: 2 },
      remove: { maxOperands: 1 },
      rm: { maxOperands: 1 },
      'set-head': {
        options: '-ad --auto --delete',
        maxOperands: 2,
        remotes: firstOperand,
        contacts: (operands, given) => (given.has('-a') || given.has('--auto') ? firstOperand(operands) : null),
      },
      show: {
        options: '-n',
        remotes: operands => operands,
        contacts: (operands, given) => (given.has('-n') ? null : operands),
      },
      prune: { options: '-n --dry-run', remotes: operands => operands, contacts: operands => operands },
      update: { options: '-p --prune', remotes: operands => operands, contacts: () => 'all' },
    },
    otherwise: { options: '-v --verbose', maxOperands: 0 },
  },
  submodule: {
    leading: '-q --quiet',
    verbs: {
      status: SUBMODULE_STATUS,
      summary: { options: '-q -n: --quiet --cached --files --summary-limit=' },
      init: { options: '-q --quiet' },
      sync: { options: '-q --quiet --recursive' },
      update: {
        options: `-qNf -j: --quiet --init --remote --no-fetch --checkout --rebase --merge --force --recursive
          --(no-)single-branch --(no-)recommend-shallow --depth= --jobs= --filter= --(no-)progress`,
        // git limits submodule fetches to its own transports, of which ssh is looked up on PATH.
        programs: () => ['ssh'],
      },
    },
    otherwise: SUBMODULE_STATUS,
  },
};

function compile(spec: FormSpec): Form {
  const { options: text, verbs, leading, otherwise, ...rest } = spec;
  return {
    ...rest,
    options: options(text ?? ''),
    ...(verbs ? { verbs: new Map(Object.entries(verbs).map(([verb, form]) => [verb, compile(form)])) } : {}),
    ...(leading ? { leading: options(leading) } : {}),
    ...(otherwise ? { otherwise: compile(otherwise) } : {}),
  };
}

const COMPILED = new Map(Object.entries(FORMS).map(([sub, spec]) => [sub, compile(spec)]));
COMPILED.set('stage', COMPILED.get('add') as Form);

const GLOBAL_FLAGS = new Set(
  `--no-pager -P -p --paginate --no-optional-locks --no-advice --literal-pathspecs --no-literal-pathspecs
  --glob-pathspecs --noglob-pathspecs --icase-pathspecs --no-replace-objects --no-lazy-fetch`.split(/\s+/)
);
const GLOBAL_PATHS = new Set(['--git-dir', '--work-tree']);

type Miss = { listed: false; reason: string };

const miss = (reason: string): Miss => ({ listed: false, reason });
const shown = (text: string): string => (text.length > 40 ? `${text.slice(0, 40)}...` : text);
const isOpen = (word: GitWord): boolean => word.splits || (!word.whole && word.text === '');
const OPEN = 'with a word filled at run time where git reads options';

function checkValue(form: Form, name: string, value: GitWord, label: string): Miss | null {
  const rule = form.values?.[name];
  if (rule === undefined) return null;
  if (!value.whole) return miss(`${label} ${name} with a value filled at run time`);
  return rule(value.text) ? null : miss(`${label} ${name} ${shown(value.text)}`);
}

/** The value of option `name` in the word after `at`: the index of the last word read, or a miss. */
function nextValue(form: Form, name: string, words: readonly GitWord[], at: number, label: string): number | Miss {
  const next = words[at + 1];
  if (next === undefined) return at;
  // Every name a glob expands to after the first lands where git reads options.
  if (next.glob) return miss(`${label} ${name} with a value bash expands as a glob`);
  if (next.splits && form.open !== 'any') return miss(`${label} ${OPEN}`);
  return checkValue(form, name, next, label) ?? at + 1;
}

/**
 * The option word at `at`: the index of the last word it reads, 'open' when its spelling is not fixed, 'exits' when git
 * stops with its usage there, or a miss.
 */
function readOption(
  form: Form,
  words: readonly GitWord[],
  at: number,
  given: Map<string, GitWord[]>,
  label: string
): number | 'open' | 'exits' | Miss {
  const word = words[at] as GitWord;
  const { text, whole } = word;
  const known = form.options;
  const take = (name: string, value?: GitWord): void => {
    given.set(name, [...(given.get(name) ?? []), ...(value ? [value] : [])]);
  };
  if (known.numeric && /^-\d+$/.test(text)) {
    if (!whole) return 'open';
    take('-<n>');
    return at;
  }
  if (text.startsWith('--')) {
    const equals = text.indexOf('=');
    if (equals === -1 && !whole) return 'open';
    const name = equals === -1 ? text : text.slice(0, equals);
    const kind = known.long.get(name);
    if (kind === undefined) return miss(`${label} ${shown(name)}`);
    if (equals !== -1) {
      if (kind === 'flag') return miss(`${label} ${name}=`);
      const value = { text: text.slice(equals + 1), whole, splits: false };
      take(name, value);
      return checkValue(form, name, value, label) ?? at;
    }
    if (kind === 'valued' || (kind === 'lastArg' && at + 1 < words.length)) {
      take(name, words[at + 1]);
      return nextValue(form, name, words, at, label);
    }
    take(name);
    return at;
  }
  for (let index = 1; index < text.length; index++) {
    const letter = text[index] as string;
    const kind = known.short.get(letter);
    if (kind === undefined && form.knownShort !== undefined && !form.knownShort.includes(letter)) return 'exits';
    if (kind === undefined) return miss(`${label} -${letter}`);
    if (kind === 'flag') {
      take(`-${letter}`);
      continue;
    }
    const rest = text.slice(index + 1);
    if (rest !== '' || !whole || kind === 'optional') {
      const value = { text: rest, whole, splits: false };
      take(`-${letter}`, value);
      return checkValue(form, `-${letter}`, value, label) ?? at;
    }
    take(`-${letter}`, words[at + 1]);
    return nextValue(form, `-${letter}`, words, at, label);
  }
  return whole ? at : 'open';
}

function readVerb(form: Form, words: readonly GitWord[], label: string): GitListing {
  const verbs = form.verbs as ReadonlyMap<string, Form>;
  let at = 0;
  const leading = (word: GitWord): boolean => {
    if (!word.whole || !word.text.startsWith('-') || form.leading === undefined) return false;
    if (word.text.startsWith('--')) return form.leading.long.get(word.text) === 'flag';
    return [...word.text.slice(1)].every(letter => form.leading?.short.get(letter) === 'flag');
  };
  while (at < words.length && leading(words[at] as GitWord)) at++;
  const word = words[at];
  if (word !== undefined && word.whole && verbs.has(word.text)) {
    return readForm(verbs.get(word.text) as Form, words.slice(at + 1), `${label} ${word.text}`);
  }
  if (form.otherwise === undefined) {
    return miss(word === undefined ? `${label} without a subcommand` : `${label} ${shown(word.text)}`);
  }
  if (word !== undefined && (isOpen(word) || (!word.text.startsWith('-') && !form.operandFirst))) {
    return miss(isOpen(word) ? `${label} ${OPEN}` : `${label} ${shown(word.text)}`);
  }
  return readForm(form.otherwise, words, label);
}

/** A listing that contacts no remote and starts no program. */
const plainListing = (form: string, given: Given): GitListing => ({
  listed: true,
  form,
  given,
  operands: [],
  open: false,
  programs: [],
});

function readForm(form: Form, words: readonly GitWord[], label: string): GitListing {
  const given = new Map<string, GitWord[]>();
  if (words.length === 1 && words[0]?.whole && words[0].text === '-h') {
    return plainListing(label, new Map([['-h', []]]));
  }
  if (form.verbs) return readVerb(form, words, label);
  const operands: GitWord[] = [];
  let reading = true;
  let open = false;
  for (let at = 0; at < words.length; at++) {
    const word = words[at] as GitWord;
    if (!reading) {
      operands.push(word);
      continue;
    }
    if (word.whole && word.text === '--') {
      reading = false;
      continue;
    }
    // A lone `-` is a word of its own; `-$x` may become any option.
    const option = !isOpen(word) && word.text.startsWith('-') && (word.text !== '-' || !word.whole);
    const read = isOpen(word) ? 'open' : option ? readOption(form, words, at, given, label) : at;
    if (typeof read === 'object') return read;
    if (read === 'exits') return plainListing(label, given);
    if (read === 'open') {
      if (form.open !== 'any') return miss(`${label} ${OPEN}`);
      open = true;
      operands.push(word);
      continue;
    }
    if (!option) {
      operands.push(word);
      if (form.open === 'afterOperand') reading = false;
    }
    // A value that splits leaves its later words where git reads options.
    if (words.slice(at + 1, read + 1).some(value => value.splits)) {
      if (form.open !== 'any') return miss(`${label} ${OPEN}`);
      open = true;
    }
    at = read;
  }
  if (form.maxOperands !== undefined) {
    if (operands.length > form.maxOperands) return miss(`${label} with ${operands.length} operands`);
    if (operands.some(operand => !operand.whole && (operand.splits || form.open !== 'any'))) {
      return miss(`${label} with an operand filled at run time`);
    }
  }
  for (const remote of form.remotes?.(operands, given) ?? []) {
    if (!remote.whole) return miss(`${label} with a remote filled at run time`);
    if (!plainRemote(remote.text)) return miss(`${label} ${shown(remote.text)}`);
  }
  const reason = form.check?.(operands, given);
  if (reason) return miss(`${label} ${reason}`);
  const contacted = form.contacts?.(operands, given) ?? [];
  const contacts =
    contacted === 'all' || contacted.length > 0
      ? {
          remotes: contacted === 'all' ? ('all' as const) : contacted.map(remote => remote.text),
          push: form.push === true,
        }
      : undefined;
  const programs = form.programs?.({ given, operands, open }) ?? [];
  return { listed: true, form: label, given, operands, open, ...(contacts ? { contacts } : {}), programs };
}

/** The setting a `-c` or `--config-env` word names, and whether its value passes: null when the key is not fixed. */
function globalSetting(word: GitWord, fromEnvironment: boolean): boolean | null {
  const equals = word.text.indexOf('=');
  const key = equals === -1 ? word.text : word.text.slice(0, equals);
  if (equals === -1 && !word.whole) return null;
  if (fromEnvironment) return equals !== -1 && listedSetting(key, null);
  const value = equals === -1 ? 'true' : word.whole ? word.text.slice(equals + 1) : null;
  return listedSetting(key, value);
}

/**
 * Whether git, given `words` (those after `git`, its aliases expanded), runs a form the table lists; the reason when
 * not.
 */
export function gitListed(words: readonly GitWord[]): GitListing {
  for (let at = 0; at < words.length; at++) {
    const word = words[at] as GitWord;
    if (isOpen(word)) return miss(`git ${OPEN}`);
    const { text, whole } = word;
    if (!text.startsWith('-')) {
      if (!whole) return miss('git with a subcommand filled at run time');
      const form = COMPILED.get(text);
      return form ? readForm(form, words.slice(at + 1), `git ${text}`) : miss(`git ${shown(text)}`);
    }
    if (whole && (text === '--version' || text === '-v' || text === '--exec-path' || text.startsWith('--list-cmds='))) {
      return plainListing(`git ${text}`, new Map());
    }
    if (whole && (text === '--help' || text === '-h')) {
      return readForm(COMPILED.get('help') as Form, words.slice(at + 1), 'git help');
    }
    if (whole && GLOBAL_FLAGS.has(text)) continue;
    const equals = text.indexOf('=');
    const name = equals === -1 ? text : text.slice(0, equals);
    if (equals === -1 && !whole) return miss(`git ${OPEN}`);
    if (name === '-C' || name === '-c' || GLOBAL_PATHS.has(name) || name === '--config-env') {
      // git takes -C and -c only with the value in the next word.
      if (equals !== -1 && (name === '-C' || name === '-c')) return miss(`git ${shown(text)}`);
      const valueWord = equals !== -1 ? { text: text.slice(equals + 1), whole, splits: false } : words[++at];
      if (valueWord === undefined) continue;
      if (valueWord.splits || (equals === -1 && valueWord.glob)) return miss(`git ${OPEN}`);
      if (name === '-c' || name === '--config-env') {
        const passes = globalSetting(valueWord, name === '--config-env');
        if (passes === null) return miss(`git ${name} with a setting filled at run time`);
        const key = valueWord.text.split('=')[0] as string;
        if (!passes) return miss(`git ${name} ${shown(key)}`);
      }
      continue;
    }
    return miss(`git ${shown(name)}`);
  }
  return plainListing('git', new Map());
}
