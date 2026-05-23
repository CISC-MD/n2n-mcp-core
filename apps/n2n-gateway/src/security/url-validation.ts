import { URL } from 'url';
import dns from 'dns';
import { promisify } from 'util';
import net from 'net';

const lookupAsync = promisify(dns.lookup);

export function isPrivateIp(ip: string): boolean {
  // IPv4 Private / Loopback / Link-Local ranges
  if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(ip)) {
    return true;
  }
  // IPv4 172.16.0.0 - 172.31.255.255
  const ipv4Match = ip.match(/^172\.(\d+)\./);
  if (ipv4Match) {
    const octet = parseInt(ipv4Match[1], 10);
    if (octet >= 16 && octet <= 31) {
      return true;
    }
  }
  // IPv4 0.0.0.0
  if (ip === '0.0.0.0') {
    return true;
  }

  // IPv6 Private / Loopback / Link-Local
  const lowerIp = ip.toLowerCase();
  if (
    lowerIp === '::1' ||
    lowerIp === '::' ||
    lowerIp.startsWith('fe80:') ||
    lowerIp.startsWith('fc00:') ||
    lowerIp.startsWith('fd00:')
  ) {
    return true;
  }

  return false;
}

export async function validateUrl(urlStr: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch (err) {
    throw new Error('Invalid URL format');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Forbidden protocol: ${url.protocol}`);
  }

  const hostname = url.hostname.trim();
  if (!hostname) {
    throw new Error('Missing hostname');
  }

  const lowerHostname = hostname.toLowerCase();
  if (lowerHostname === 'localhost' || lowerHostname === 'loopback') {
    throw new Error('Access to local network hosts is forbidden');
  }

  // If hostname is directly an IP address, validate it
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error(`Access to private IP range is forbidden: ${hostname}`);
    }
  } else {
    // Resolve hostname to IP to prevent DNS Rebinding / SSRF
    try {
      const { address } = await lookupAsync(hostname);
      if (isPrivateIp(address)) {
        throw new Error(`Access to private IP range is forbidden (resolves to ${address})`);
      }
    } catch (err: any) {
      // If DNS resolution fails, block request to prevent SSRF bypasses via failed DNS tricks
      throw new Error(`DNS resolution failed for hostname ${hostname}: ${err.message}`);
    }
  }
}
