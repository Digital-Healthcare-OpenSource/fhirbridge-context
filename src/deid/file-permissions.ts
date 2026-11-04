/**
 * Owner-only permissions for vault and key files.
 *
 * POSIX: `chmod 600`. Windows ignores the `mode` argument of fs calls, so the file would inherit
 * the parent directory's ACL (often readable by other local users); there we remove inherited
 * entries and grant only the current user full control with `icacls` (spawned without a shell,
 * so no argument is ever interpreted). Failure is fatal: a vault is never left readable by others.
 */
import { execFile } from 'node:child_process';
import { chmod } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { promisify } from 'node:util';
import { FhirBridgeError } from '../errors.js';

const execFileAsync = promisify(execFile);
const ICACLS_TIMEOUT_MS = 15_000;

/** `DOMAIN\user` when the domain is known, else the bare account name. */
export function windowsPrincipal(env: NodeJS.ProcessEnv = process.env, user = userInfo().username): string {
  const domain = env.USERDOMAIN?.trim();
  return domain ? `${domain}\\${user}` : user;
}

export async function restrictToOwner(file: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  try {
    if (platform !== 'win32') {
      await chmod(file, 0o600);
      return;
    }
    await execFileAsync('icacls', [file, '/inheritance:r', '/grant:r', `${windowsPrincipal()}:(F)`], {
      windowsHide: true,
      timeout: ICACLS_TIMEOUT_MS,
    });
  } catch (err) {
    throw new FhirBridgeError('VAULT_IO', 'Could not restrict the vault file to the current user.', {
      cause: err,
      hint: 'Check that the vault directory is on a local NTFS/POSIX filesystem you own.',
    });
  }
}
