/**
 * Literal-address guard for the SMART `iss`: refuses IP literals in loopback, private,
 * link-local and cloud-metadata ranges so a crafted `--iss` cannot turn the CLI into a probe of
 * the operator's internal network. Host NAMES are not resolved (no DNS lookup happens here); use
 * network egress controls for that.
 */
import { isIP } from 'node:net';

const LOOPBACK_NAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** localhost / 127.0.0.1 / ::1: the local-development allowance (always permitted). */
export function isLocalDevHost(hostname: string): boolean {
  return LOOPBACK_NAMES.has(hostname.toLowerCase());
}

function privateIPv4(a: number, b: number): boolean {
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) || // link-local, incl. 169.254.169.254 metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
  );
}

function ipv4Groups(host: string): [number, number] | undefined {
  const parts = host.split('.').map(Number);
  return parts.length === 4 && parts[0] !== undefined && parts[1] !== undefined ? [parts[0], parts[1]] : undefined;
}

/** First two IPv4 octets embedded in `::ffff:a.b.c.d`, in URL-normalized `::ffff:hhhh:hhhh` form. */
function mappedIPv4(host: string): [number, number] | undefined {
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!m) return undefined;
  const high = parseInt(m[1] ?? '', 16);
  return [high >> 8, high & 0xff];
}

/** True for IP-literal hostnames in loopback/private/link-local/metadata ranges. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const family = isIP(host);
  if (family === 4) {
    const groups = ipv4Groups(host);
    return groups !== undefined && privateIPv4(groups[0], groups[1]);
  }
  if (family === 6) {
    if (host === '::1' || host === '::') return true;
    const mapped = mappedIPv4(host);
    if (mapped) return privateIPv4(mapped[0], mapped[1]);
    const first = parseInt(host.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80; // fc00::/7, fe80::/10
  }
  return false;
}
