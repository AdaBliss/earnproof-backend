import { isIP } from "net";

interface ParsedIp {
  readonly value: bigint;
  readonly bits: 32 | 128;
}

interface ParsedCidr extends ParsedIp {
  readonly prefix: number;
}

export function isValidCidr(cidr: string): boolean {
  return parseCidr(cidr) !== undefined;
}

export function isIpInCidr(ip: string, cidr: string): boolean {
  const parsedCidr = parseCidr(cidr);
  let parsedIp = parseIp(ip);
  if (!parsedCidr || !parsedIp) return false;

  if (parsedCidr.bits === 32 && parsedIp.bits === 128) {
    parsedIp = asIpv4MappedAddress(parsedIp);
  }
  if (parsedIp.bits !== parsedCidr.bits) return false;

  const shift = BigInt(parsedCidr.bits - parsedCidr.prefix);
  return (parsedIp.value >> shift) === (parsedCidr.value >> shift);
}

/** Normalises IPv4-mapped IPv6 addresses to their IPv4 spelling. */
export function normaliseIp(ip: string): string {
  const parsed = parseIp(ip);
  if (!parsed) return ip;
  const ipv4 = asIpv4MappedAddress(parsed);
  if (ipv4.bits === 32 && parsed.bits === 128) {
    return [
      Number((ipv4.value >> 24n) & 255n),
      Number((ipv4.value >> 16n) & 255n),
      Number((ipv4.value >> 8n) & 255n),
      Number(ipv4.value & 255n),
    ].join(".");
  }
  return ip;
}

function parseCidr(cidr: string): ParsedCidr | undefined {
  const parts = cidr.split("/");
  if (parts.length !== 2 || !/^\d+$/.test(parts[1])) return undefined;
  const ip = parseIp(parts[0]);
  if (!ip) return undefined;

  const prefix = Number(parts[1]);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > ip.bits) {
    return undefined;
  }
  return { ...ip, prefix };
}

function parseIp(ip: string): ParsedIp | undefined {
  const version = isIP(ip);
  if (version === 4) {
    const value = ip
      .split(".")
      .reduce((acc, octet) => (acc << 8n) | BigInt(octet), 0n);
    return { value, bits: 32 };
  }
  if (version !== 6) return undefined;

  const value = parseIpv6(ip);
  return value === undefined ? undefined : { value, bits: 128 };
}

function parseIpv6(ip: string): bigint | undefined {
  let input = ip.toLowerCase();
  if (input.includes(".")) {
    const lastColon = input.lastIndexOf(":");
    const ipv4 = input.slice(lastColon + 1);
    const parsedV4 = parseIp(ipv4);
    if (!parsedV4 || parsedV4.bits !== 32) return undefined;
    const high = Number((parsedV4.value >> 16n) & 0xffffn).toString(16);
    const low = Number(parsedV4.value & 0xffffn).toString(16);
    input = `${input.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = input.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (
    (halves.length === 1 && missing !== 0) ||
    (halves.length === 2 && missing < 1)
  ) {
    return undefined;
  }

  const groups = [
    ...left,
    ...Array(halves.length === 2 ? missing : 0).fill("0"),
    ...right,
  ];
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return undefined;

  return groups.reduce(
    (acc, group) => (acc << 16n) | BigInt(`0x${group}`),
    0n,
  );
}

function asIpv4MappedAddress(ip: ParsedIp): ParsedIp {
  if (
    ip.bits === 128 &&
    (ip.value >> 32n) === 0xffffn
  ) {
    return { value: ip.value & 0xffffffffn, bits: 32 };
  }
  return ip;
}
