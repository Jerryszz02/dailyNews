import { lookup as lookupDns } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent } from "undici";

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type SourceHostResolver = (hostname: string) => Promise<ResolvedAddress[]>;
type SourceLookupCallback = (
  error: Error | null,
  address: string | ResolvedAddress[],
  family?: number,
) => void;

const blockedIpv4Ranges: Array<[number, number]> = [
  [ipv4("0.0.0.0"), 8],
  [ipv4("10.0.0.0"), 8],
  [ipv4("100.64.0.0"), 10],
  [ipv4("127.0.0.0"), 8],
  [ipv4("169.254.0.0"), 16],
  [ipv4("172.16.0.0"), 12],
  [ipv4("192.0.0.0"), 24],
  [ipv4("192.0.2.0"), 24],
  [ipv4("192.168.0.0"), 16],
  [ipv4("198.18.0.0"), 15],
  [ipv4("198.51.100.0"), 24],
  [ipv4("203.0.113.0"), 24],
  [ipv4("224.0.0.0"), 4],
  [ipv4("240.0.0.0"), 4],
];

export function isPublicSourceAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4(address);
    return !blockedIpv4Ranges.some(([network, prefix]) => inIpv4Subnet(value, network, prefix));
  }
  if (family !== 6) return false;
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) return isPublicSourceAddress(normalized.slice("::ffff:".length));
  if (normalized === "::" || normalized === "::1") return false;
  if (/^f[cd]/.test(normalized) || /^fe[89ab]/.test(normalized) || /^ff/.test(normalized)) return false;
  if (normalized.startsWith("2001:db8:")) return false;
  return /^[23]/.test(normalized);
}

export async function resolvePublicSourceAddress(
  hostname: string,
  resolver: SourceHostResolver = resolveAllAddresses,
): Promise<ResolvedAddress> {
  return (await resolvePublicSourceAddresses(hostname, resolver))[0];
}

async function resolvePublicSourceAddresses(
  hostname: string,
  resolver: SourceHostResolver,
): Promise<ResolvedAddress[]> {
  const addresses = await resolver(hostname);
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicSourceAddress(address))) {
    throw Object.assign(new Error("source_address_not_public"), { code: "SOURCE_ADDRESS_NOT_PUBLIC" });
  }
  return addresses;
}

export function createPublicSourceLookup(resolver: SourceHostResolver = resolveAllAddresses) {
  return (hostname: string, options: { all?: boolean }, callback: SourceLookupCallback): void => {
    void resolvePublicSourceAddresses(hostname, resolver).then(
      (addresses) => {
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      },
      (error) => callback(error as Error, options.all ? [] : "", 0),
    );
  };
}

export const publicSourceDispatcher = new Agent({
  connect: { lookup: createPublicSourceLookup() },
});

async function resolveAllAddresses(hostname: string): Promise<ResolvedAddress[]> {
  return lookupDns(hostname, { all: true, verbatim: true });
}

function ipv4(address: string): number {
  return address.split(".").reduce((value, part) => (value * 256) + Number(part), 0) >>> 0;
}

function inIpv4Subnet(address: number, network: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) === (network & mask);
}
