export const EXAPP_INVOKABLE_HOSTNAMES_ENV = 'EXAPP_INVOKABLE_HOSTNAMES';

const WILDCARD_ENTRY = '*';
const HOST_SUFFIX_PREFIX = '*.';

const ALLOWLIST_PATTERN_KIND = {
  wildcard: 'wildcard',
  exactHost: 'exactHost',
  hostSuffix: 'hostSuffix',
  regex: 'regex',
} as const;

export type AllowlistPattern =
  | { kind: typeof ALLOWLIST_PATTERN_KIND.wildcard }
  | { kind: typeof ALLOWLIST_PATTERN_KIND.exactHost; host: string }
  | { kind: typeof ALLOWLIST_PATTERN_KIND.hostSuffix; suffix: string }
  | { kind: typeof ALLOWLIST_PATTERN_KIND.regex; source: string; compiled: RegExp };

const buildAnchoredHostnameRegex = (source: string): RegExp => new RegExp(`^(?:${source})$`, 'i');

const stripIpLiteralBrackets = (hostname: string): string =>
  hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

const trimTrailingDots = (hostname: string): string => {
  let end = hostname.length;
  while (end > 0 && hostname.charCodeAt(end - 1) === 46) {
    end -= 1;
  }
  return hostname.slice(0, end);
};

export const normalizeHostname = (hostname: string): string =>
  trimTrailingDots(stripIpLiteralBrackets(hostname).toLowerCase());

const MAX_HOSTNAME_LENGTH = 253;
const MAX_HOSTNAME_LABEL_LENGTH = 63;
const SUFFIX_PROBE_LABEL = 'a';

export const isWithinDnsLengthLimits = (normalizedHostname: string): boolean =>
  normalizedHostname.length <= MAX_HOSTNAME_LENGTH &&
  normalizedHostname.split('.').every((label) => label.length <= MAX_HOSTNAME_LABEL_LENGTH);

const isRegexEntry = (entry: unknown): entry is { regex: string } =>
  typeof entry === 'object' &&
  entry !== null &&
  typeof (entry as { regex?: unknown }).regex === 'string';

const compilesOnItsOwn = (source: string): boolean => {
  try {
    return new RegExp(source) instanceof RegExp;
  } catch {
    return false;
  }
};

const toCanonicalHost = (value: string): string | undefined => {
  let parsedHostname: string;
  try {
    parsedHostname = new URL(`https://${value}/`).hostname;
  } catch {
    return undefined;
  }
  const host = normalizeHostname(parsedHostname);
  if (
    host.length === 0 ||
    host.includes(WILDCARD_ENTRY) ||
    host !== normalizeHostname(value) ||
    !isWithinDnsLengthLimits(host) ||
    host.split('.').some((label) => label.length === 0)
  ) {
    return undefined;
  }
  return host;
};

export const parseAllowlistEntry = (entry: unknown): AllowlistPattern | undefined => {
  if (isRegexEntry(entry)) {
    const source = entry.regex.trim();
    if (source.length === 0 || !compilesOnItsOwn(source)) {
      return undefined;
    }
    return {
      kind: ALLOWLIST_PATTERN_KIND.regex,
      source,
      compiled: buildAnchoredHostnameRegex(source),
    };
  }
  if (typeof entry !== 'string') {
    return undefined;
  }
  const value = entry.trim();
  if (value.length === 0) {
    return undefined;
  }
  if (value === WILDCARD_ENTRY) {
    return { kind: ALLOWLIST_PATTERN_KIND.wildcard };
  }
  if (value.startsWith(HOST_SUFFIX_PREFIX)) {
    const suffixHost = toCanonicalHost(value.slice(HOST_SUFFIX_PREFIX.length));
    return suffixHost === undefined ||
      toCanonicalHost(`${SUFFIX_PROBE_LABEL}.${suffixHost}`) === undefined
      ? undefined
      : { kind: ALLOWLIST_PATTERN_KIND.hostSuffix, suffix: `.${suffixHost}` };
  }
  const host = toCanonicalHost(value);
  return host === undefined ? undefined : { kind: ALLOWLIST_PATTERN_KIND.exactHost, host };
};

export const parseAllowlistPatterns = (raw: string | undefined): AllowlistPattern[] => {
  if (typeof raw !== 'string' || raw.length === 0) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const patterns: AllowlistPattern[] = [];
  for (const entry of parsed) {
    const pattern = parseAllowlistEntry(entry);
    if (pattern !== undefined) {
      patterns.push(pattern);
    }
  }
  return patterns;
};

export const matchEndpointAllowlist = (
  hostname: string,
  patterns: readonly AllowlistPattern[],
): boolean => {
  const normalized = normalizeHostname(hostname);
  if (normalized.length === 0) {
    return false;
  }
  return patterns.some((pattern) => {
    switch (pattern.kind) {
      case ALLOWLIST_PATTERN_KIND.wildcard:
        return true;
      case ALLOWLIST_PATTERN_KIND.exactHost:
        return normalized === pattern.host;
      case ALLOWLIST_PATTERN_KIND.hostSuffix:
        return normalized.endsWith(pattern.suffix) && normalized.length > pattern.suffix.length;
      case ALLOWLIST_PATTERN_KIND.regex:
        return pattern.compiled.test(normalized);
    }
  });
};
