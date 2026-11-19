// Library paths as they travel on the wire: relative, forward slashes, NFC. The checks
// are the union of what git, Windows and the contract refuse, so one rule holds on every
// host the server may run on.
import { ApiError } from './errors.ts';

/** Temp files are written under this name, so no client path may start a segment with it. */
export const TEMP_PREFIX = '.neo-tmp-';

const CONTROL = /[\u0000-\u001f\u007f]/;
const WINDOWS_ILLEGAL = /[<>:"|?*]/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i;

function refuse(p: string, why: string): never {
  throw new ApiError('bad_path', 400, `bad path ${JSON.stringify(p)}: ${why}`);
}

export function checkPath(p: string): string {
  if (typeof p !== 'string' || p === '') return refuse(String(p), 'empty');
  if (p.startsWith('/')) refuse(p, 'leading slash');
  if (p.endsWith('/')) refuse(p, 'trailing slash');
  if (p.includes('\\')) refuse(p, 'backslash');
  if (CONTROL.test(p)) refuse(p, 'control character');
  if (p !== p.normalize('NFC')) refuse(p, 'not NFC');
  for (const segment of p.split('/')) {
    if (segment === '') refuse(p, 'empty segment');
    if (segment === '.' || segment === '..') refuse(p, 'dot segment');
    if (segment.toLowerCase() === '.git') refuse(p, '.git segment');
    if (segment.startsWith(TEMP_PREFIX)) refuse(p, 'reserved temp-file prefix');
    if (WINDOWS_ILLEGAL.test(segment)) refuse(p, 'character Windows refuses');
    if (/[. ]$/.test(segment)) refuse(p, 'segment ends in a dot or space');
    if (WINDOWS_DEVICE.test(segment.split('.')[0].trimEnd())) refuse(p, 'Windows device name');
  }
  return p;
}

/** Two paths with the same key cannot coexist on a case-insensitive disk. */
export function foldKey(p: string): string {
  return p.normalize('NFC').toLowerCase();
}
