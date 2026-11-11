/**
 * Windows file security for the plugin state, done with system tools.
 *
 * `mode: 0o600` means nothing on NTFS: Node maps it to the read-only attribute.
 * The real protection is a DACL, so this module sets one and reads it back.
 *
 * koffi was tried here first and corrupted the host heap on a directory whose
 * descriptor came from `GetNamedSecurityInfoW`, so file ACLs stay on `icacls`
 * and `Get-Acl`, which are part of Windows and behave the same for every user.
 */

import { execFileSync } from 'node:child_process';

const SYSTEM = 'S-1-5-18';
const ADMINISTRATORS = 'S-1-5-32-544';

/** Runs a tool and returns trimmed stdout, or throws with its stderr. */
function run(file, args) {
  try {
    return execFileSync(file, args, {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const detail = error?.stderr ? String(error.stderr).trim() : error?.message ?? String(error);
    throw new Error(`${file} failed: ${detail}`);
  }
}

/**
 * Reads a path's DACL as SDDL.
 *
 * `Get-Acl` is used instead of `icacls` because SDDL is locale-independent,
 * while `icacls` prints translated group names.
 *
 * The child gets its own PSModulePath: when the host was started from
 * PowerShell 7, the inherited value points at 7-only modules and Windows
 * PowerShell cannot load `Microsoft.PowerShell.Security` at all.
 */
export function pathSddl(path) {
  const script =
    "$p = $env:COUCOU_ACL_PATH; if (-not (Test-Path -LiteralPath $p)) { '' } else { (Get-Acl -LiteralPath $p).Sddl }";
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        COUCOU_ACL_PATH: path,
        PSModulePath: [
          'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
          'C:\\Program Files\\WindowsPowerShell\\Modules',
          'C:\\Program Files\\PowerShell\\Modules',
        ].join(';'),
      },
    },
  ).trim();
  return out || null;
}

/**
 * Grants the current user, SYSTEM and Administrators full control, and stops
 * the path from inheriting anything wider from its parent.
 *
 * `/grant:r` replaces the entry for that principal, so repeated runs converge
 * instead of stacking duplicate ACEs. SIDs are passed with a leading `*` so no
 * translated account name is involved.
 */
export function securePath(path, sid, { directory = false } = {}) {
  const inheritance = directory ? '(OI)(CI)' : '';
  const args = [path, '/inheritance:r'];
  for (const principal of [sid, SYSTEM, ADMINISTRATORS]) {
    args.push('/grant:r', `*${principal}:${inheritance}F`);
  }
  run('icacls.exe', args);
  return pathSddl(path);
}

/**
 * True when the DACL is protected and names only the user, SYSTEM and
 * Administrators.
 *
 * Anything else — Everyone, Users, Anonymous, a second account — means the
 * secret in this directory is not actually private. SDDL abbreviates the
 * well-known principals, so they are resolved before the comparison.
 */
export function isPrivateSddl(sddl, sid) {
  if (!sddl) return false;
  // `D:P` means the DACL no longer inherits from its parent.
  if (!/D:P/.test(sddl)) return false;

  const aliases = new Map([
    ['sy', SYSTEM],
    ['ba', ADMINISTRATORS],
  ]);
  const allowed = new Set([sid.toLowerCase(), SYSTEM.toLowerCase(), ADMINISTRATORS.toLowerCase()]);

  const trustees = [...sddl.matchAll(/\(([^)]*)\)/g)]
    .map((match) => {
      const fields = match[1].split(';');
      // ace_type;ace_flags;rights;object_guid;inherit_object_guid;account_sid
      return (fields.length >= 6 ? fields[5] : fields[fields.length - 1] ?? '').trim().toLowerCase();
    })
    .filter(Boolean);

  if (trustees.length === 0) return false;
  return trustees.every((trustee) => {
    const resolved = aliases.get(trustee) ?? trustee;
    return allowed.has(resolved.toLowerCase());
  });
}