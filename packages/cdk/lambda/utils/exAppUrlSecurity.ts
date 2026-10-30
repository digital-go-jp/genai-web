import ipaddr = require('ipaddr.js');

import {
  EXAPP_INVOKABLE_HOSTNAMES_ENV,
  isWithinDnsLengthLimits,
  matchEndpointAllowlist,
  normalizeHostname,
  parseAllowlistPatterns,
} from './exAppAllowlist';

const MAX_ENDPOINT_URL_LENGTH = 4096;
const MAX_STATUS_URL_LENGTH = 2048;

export class UnsafeExAppUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeExAppUrlError';
  }
}

export type ValidatedExAppUrl = {
  readonly url: URL;
};

export type ExAppHttpRequestOptions = {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
};

export type ExAppHttpResponse = Pick<Response, 'ok' | 'status' | 'text' | 'json'>;

const hasUnsafeRawCharacters = (value: string): boolean =>
  value.trim() !== value || hasControlCharacter(value);

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const charCode = value.charCodeAt(index);
    if (charCode <= 0x1f || charCode === 0x7f) {
      return true;
    }
  }
  return false;
};

const assertAllowedHostname = (hostname: string): void => {
  const normalizedHostname = normalizeHostname(hostname);
  if (normalizedHostname.length === 0) {
    throw new UnsafeExAppUrlError('APIエンドポイントのホスト名を指定してください。');
  }
  if (!isWithinDnsLengthLimits(normalizedHostname)) {
    throw new UnsafeExAppUrlError('APIエンドポイントのホスト名が長すぎます。');
  }
  if (normalizedHostname === 'localhost' || normalizedHostname.endsWith('.localhost')) {
    throw new UnsafeExAppUrlError('APIエンドポイントのホスト名は許可されていません。');
  }
  if (!ipaddr.isValid(normalizedHostname)) {
    return;
  }

  const parsedAddress = ipaddr.process(normalizedHostname);
  if (parsedAddress.range() !== 'unicast') {
    throw new UnsafeExAppUrlError('APIエンドポイントには公開 IP アドレスを指定してください。');
  }
};

export const parseHttpsUrl = (value: string): URL => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ENDPOINT_URL_LENGTH ||
    hasUnsafeRawCharacters(value)
  ) {
    throw new UnsafeExAppUrlError('APIエンドポイントの形式が不正です。');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UnsafeExAppUrlError('APIエンドポイントの形式が不正です。');
  }

  if (url.protocol !== 'https:') {
    throw new UnsafeExAppUrlError('APIエンドポイントには HTTPS URL を指定してください。');
  }
  if (!url.hostname) {
    throw new UnsafeExAppUrlError('APIエンドポイントのホスト名を指定してください。');
  }
  if (url.username || url.password) {
    throw new UnsafeExAppUrlError('APIエンドポイントに認証情報は含められません。');
  }
  if (url.hash) {
    throw new UnsafeExAppUrlError('APIエンドポイントにフラグメントは含められません。');
  }

  return url;
};

const assertHostnameAllowlisted = (hostname: string): void => {
  const patterns = parseAllowlistPatterns(process.env[EXAPP_INVOKABLE_HOSTNAMES_ENV]);
  if (!matchEndpointAllowlist(hostname, patterns)) {
    throw new UnsafeExAppUrlError('APIエンドポイントは許可されていません。');
  }
};

export const assertPublicEndpointUrl = async (value: string): Promise<ValidatedExAppUrl> => {
  const url = parseHttpsUrl(value);
  assertAllowedHostname(url.hostname);
  assertHostnameAllowlisted(url.hostname);
  return { url };
};

export const resolveRelativeStatusUrl = (
  statusUrl: string,
  endpoint: ValidatedExAppUrl,
): ValidatedExAppUrl => {
  if (
    typeof statusUrl !== 'string' ||
    statusUrl.length === 0 ||
    statusUrl.length > MAX_STATUS_URL_LENGTH ||
    hasUnsafeRawCharacters(statusUrl) ||
    !statusUrl.startsWith('/') ||
    statusUrl.startsWith('//') ||
    statusUrl.includes('\\')
  ) {
    throw new UnsafeExAppUrlError('ステータスURLには同一オリジンの相対パスを指定してください。');
  }

  const resolvedUrl = new URL(statusUrl, endpoint.url);
  if (resolvedUrl.origin !== endpoint.url.origin || resolvedUrl.protocol !== 'https:') {
    throw new UnsafeExAppUrlError(
      'ステータスURLはAPIエンドポイントと同一オリジンである必要があります。',
    );
  }
  if (resolvedUrl.hash) {
    throw new UnsafeExAppUrlError('ステータスURLにフラグメントは含められません。');
  }

  return { url: resolvedUrl };
};

export const assertPublicStatusUrl = async (
  statusUrl: string,
  endpoint: string,
): Promise<ValidatedExAppUrl> => {
  const validatedEndpoint = await assertPublicEndpointUrl(endpoint);
  return resolveRelativeStatusUrl(statusUrl, validatedEndpoint);
};

export const toRelativeStatusUrl = (url: URL): string => `${url.pathname}${url.search}`;

export const isExAppUrlValidationError = (error: unknown): error is UnsafeExAppUrlError =>
  error instanceof UnsafeExAppUrlError;

export const requestValidatedExAppUrl = async (
  validatedUrl: ValidatedExAppUrl,
  options: ExAppHttpRequestOptions = {},
): Promise<ExAppHttpResponse> => {
  const response = await fetch(validatedUrl.url, {
    method: options.method ?? 'GET',
    headers: options.headers ? { ...options.headers } : undefined,
    body: options.body,
    redirect: 'manual',
  });
  if (response.status >= 300 && response.status < 400) {
    throw new UnsafeExAppUrlError('AIアプリのリダイレクト応答は許可されていません。');
  }
  return response;
};
