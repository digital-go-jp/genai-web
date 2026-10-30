import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertPublicEndpointUrl,
  assertPublicStatusUrl,
  parseHttpsUrl,
  requestValidatedExAppUrl,
  resolveRelativeStatusUrl,
  toRelativeStatusUrl,
  UnsafeExAppUrlError,
} from '../../../lambda/utils/exAppUrlSecurity';
import {
  EXAPP_INVOKABLE_HOSTNAMES_ENV,
  matchEndpointAllowlist,
  parseAllowlistPatterns,
} from '../../../lambda/utils/exAppAllowlist';

describe('exAppUrlSecurity', () => {
  beforeEach(() => {
    vi.stubEnv(EXAPP_INVOKABLE_HOSTNAMES_ENV, JSON.stringify(['*']));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  describe('parseHttpsUrl', () => {
    it('HTTPS URLをパースする', () => {
      const url = parseHttpsUrl('https://api.example.com/invoke?x=1');

      expect(url.toString()).toBe('https://api.example.com/invoke?x=1');
    });

    it.each([
      'http://api.example.com/invoke',
      'file:///etc/passwd',
      'https://user:pass@api.example.com/invoke',
      'https://api.example.com/invoke#fragment',
      ' https://api.example.com/invoke',
      'https://api.example.com/invoke\n',
      'not-a-url',
    ])('不正なendpoint URLを拒否する: %s', (value) => {
      expect(() => parseHttpsUrl(value)).toThrow(UnsafeExAppUrlError);
    });
  });

  describe('assertPublicEndpointUrl', () => {
    it('HTTPSドメインをDNS解決せず許可する', async () => {
      const result = await assertPublicEndpointUrl('https://api.example.com/invoke');

      expect(result.url.hostname).toBe('api.example.com');
    });

    it('public IP literalを許可する', async () => {
      const result = await assertPublicEndpointUrl('https://8.8.8.8/invoke');

      expect(result.url.hostname).toBe('8.8.8.8');
    });

    it('public IPv6 literalを許可する', async () => {
      const result = await assertPublicEndpointUrl('https://[2001:4860:4860::8888]/invoke');

      expect(result.url.hostname).toBe('[2001:4860:4860::8888]');
    });

    it.each([
      'https://localhost/invoke',
      'https://LOCALHOST/invoke',
      'https://localhost./invoke',
      'https://./invoke',
      'https://.../invoke',
      'https://api.localhost/invoke',
      'https://api.localhost./invoke',
      'https://127.0.0.1/invoke',
      'https://127.0.0.1./invoke',
      'https://127.1/invoke',
      'https://0177.0.0.1/invoke',
      'https://127.000.000.001/invoke',
      'https://2130706433/invoke',
      'https://0x7f000001/invoke',
      'https://0.0.0.0/invoke',
      'https://255.255.255.255/invoke',
      'https://224.0.0.1/invoke',
      'https://[::1]/invoke',
      'https://[::]/invoke',
      'https://[fe80::1]/invoke',
      'https://[fd00::1]/invoke',
      'https://[ff02::1]/invoke',
      'https://[2001:db8::1]/invoke',
      'https://[::ffff:127.0.0.1]/invoke',
      'https://169.254.169.254/latest/meta-data',
      'https://10.0.0.1/invoke',
      'https://172.16.0.1/invoke',
      'https://192.168.0.1/invoke',
      'https://100.64.0.1/invoke',
      'https://203.0.113.10/invoke',
    ])('内部・特殊用途IP literalを拒否する: %s', async (value) => {
      await expect(assertPublicEndpointUrl(value)).rejects.toBeInstanceOf(UnsafeExAppUrlError);
    });

    it.each([
      'https://localhost/test',
      'https://127.0.0.1/test',
      'https://10.0.0.1/test',
      'https://172.16.0.1/test',
      'https://192.168.0.1/test',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::1]/test',
      'https://[fe80::1]/test',
      'https://[fd00::1]/test',
      'https://[::ffff:127.0.0.1]/test',
    ])('代表的な内部向けendpointを拒否する: %s', async (value) => {
      await expect(assertPublicEndpointUrl(value)).rejects.toBeInstanceOf(UnsafeExAppUrlError);
    });
  });

  describe('assertPublicEndpointUrl のホスト名の長さ（DNS の上限）', () => {
    const labelOf = (length: number) => 'a'.repeat(length);
    const hostnameOf253 = [labelOf(63), labelOf(63), labelOf(63), labelOf(61)].join('.');
    const hostnameOf254 = [labelOf(63), labelOf(63), labelOf(63), labelOf(62)].join('.');

    it('境界値のホスト名は 253 文字と 254 文字である', () => {
      expect(hostnameOf253).toHaveLength(253);
      expect(hostnameOf254).toHaveLength(254);
    });

    it.each([
      ['全体 253 文字', `https://${hostnameOf253}/invoke`],
      ['全体 253 文字 + 末尾ドット', `https://${hostnameOf253}./invoke`],
      ['63 文字のラベル', `https://${labelOf(63)}.example/invoke`],
      ['punycode 変換後に 58 文字の IDN ラベル', `https://${'日本語ドメイン'.repeat(5)}.jp/invoke`],
    ])('%s は許可する', async (_label, endpoint) => {
      await expect(assertPublicEndpointUrl(endpoint)).resolves.toMatchObject({
        url: expect.anything(),
      });
    });

    it.each([
      ['全体 254 文字', `https://${hostnameOf254}/invoke`],
      ['64 文字のラベル', `https://${labelOf(64)}.example/invoke`],
      ['変換前 42 文字・punycode 変換後 69 文字の IDN ラベル', `https://${'日本語ドメイン'.repeat(6)}.jp/invoke`],
    ])("%s は '*' でも拒否する", async (_label, endpoint) => {
      await expect(assertPublicEndpointUrl(endpoint)).rejects.toThrow(
        'APIエンドポイントのホスト名が長すぎます。',
      );
    });
  });

  describe('resolveRelativeStatusUrl', () => {
    it('相対status_urlをendpoint originに解決する', async () => {
      const endpoint = await assertPublicEndpointUrl('https://api.example.com/prod/invoke');

      const result = resolveRelativeStatusUrl('/status/123?poll=1', endpoint);

      expect(result.url.toString()).toBe('https://api.example.com/status/123?poll=1');
      expect(toRelativeStatusUrl(result.url)).toBe('/status/123?poll=1');
    });

    it.each([
      'https://evil.example/status/123',
      'http://10.0.0.5/internal-service',
      '//evil.example/status/123',
      '/\\evil.example/status/123',
      '\t/status/123',
      '/status/123#fragment',
      'status/123',
      '',
    ])('不正なstatus_urlを拒否する: %s', async (statusUrl) => {
      const endpoint = await assertPublicEndpointUrl('https://api.example.com/invoke');

      expect(() => resolveRelativeStatusUrl(statusUrl, endpoint)).toThrow(UnsafeExAppUrlError);
    });

    it.each(['/%2F%2Fevil.example/status', '/%5Cevil.example/status'])(
      'エンコード済みの紛らわしいstatus_urlも同一originのパスとして扱う: %s',
      async (statusUrl) => {
        const endpoint = await assertPublicEndpointUrl('https://api.example.com/invoke');

        const result = resolveRelativeStatusUrl(statusUrl, endpoint);

        expect(result.url.origin).toBe('https://api.example.com');
        expect(toRelativeStatusUrl(result.url)).toBe(statusUrl);
      },
    );

    it('assertPublicStatusUrlはendpoint検証とstatus_url解決をまとめて行う', async () => {
      const result = await assertPublicStatusUrl('/prod/status/123', 'https://api.example.com/prod/invoke');

      expect(result.url.toString()).toBe('https://api.example.com/prod/status/123');
    });
  });

  describe('requestValidatedExAppUrl', () => {
    it('redirectを追従せずに外部リクエストを送信する', async () => {
      const response = new Response('{"ok":true}', { status: 200 });
      const fetchMock = vi.fn().mockResolvedValue(response);
      vi.stubGlobal('fetch', fetchMock);
      const endpoint = await assertPublicEndpointUrl('https://api.example.com/invoke');

      const result = await requestValidatedExAppUrl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"input":"test"}',
      });

      expect(result.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledWith(endpoint.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"input":"test"}',
        redirect: 'manual',
      });
    });

    it('method未指定時はGETで外部リクエストを送信する', async () => {
      const response = new Response('{"ok":true}', { status: 200 });
      const fetchMock = vi.fn().mockResolvedValue(response);
      vi.stubGlobal('fetch', fetchMock);
      const endpoint = await assertPublicEndpointUrl('https://api.example.com/invoke');

      await requestValidatedExAppUrl(endpoint);

      expect(fetchMock).toHaveBeenCalledWith(endpoint.url, {
        method: 'GET',
        headers: undefined,
        body: undefined,
        redirect: 'manual',
      });
    });

    it('redirectレスポンスを拒否する', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 302 }));
      vi.stubGlobal('fetch', fetchMock);
      const endpoint = await assertPublicEndpointUrl('https://api.example.com/invoke');

      await expect(requestValidatedExAppUrl(endpoint)).rejects.toBeInstanceOf(UnsafeExAppUrlError);
    });
  });

  describe('assertPublicEndpointUrl allowlist enforcement', () => {
    it('空ホワイトリスト（deny-all）は公開HTTPSドメインでも拒否する', async () => {
      vi.stubEnv(EXAPP_INVOKABLE_HOSTNAMES_ENV, JSON.stringify([]));

      await expect(assertPublicEndpointUrl('https://api.example.com/invoke')).rejects.toBeInstanceOf(
        UnsafeExAppUrlError,
      );
    });

    it('env未設定（deny-all）は拒否する（fail-open にならない）', async () => {
      vi.stubEnv(EXAPP_INVOKABLE_HOSTNAMES_ENV, undefined);

      await expect(assertPublicEndpointUrl('https://api.example.com/invoke')).rejects.toBeInstanceOf(
        UnsafeExAppUrlError,
      );
    });

    it.each(['', 'not-json', '{"a":1}', '"*"', '[""]'])(
      'env が %j なら deny-all になり、UnsafeExAppUrlError で拒否する',
      async (raw) => {
        vi.stubEnv(EXAPP_INVOKABLE_HOSTNAMES_ENV, raw);

        await expect(assertPublicEndpointUrl('https://api.example.com/invoke')).rejects.toBeInstanceOf(
          UnsafeExAppUrlError,
        );
      },
    );

    it('完全一致ホストのみ許可し、リスト外は拒否する', async () => {
      vi.stubEnv(EXAPP_INVOKABLE_HOSTNAMES_ENV, JSON.stringify(['api.allowed.example']));

      const result = await assertPublicEndpointUrl('https://api.allowed.example/invoke');
      expect(result.url.hostname).toBe('api.allowed.example');

      await expect(assertPublicEndpointUrl('https://evil.example/invoke')).rejects.toBeInstanceOf(
        UnsafeExAppUrlError,
      );
    });

    it('サフィックス *.allowed.example はサブドメインを許可しapexは拒否する', async () => {
      vi.stubEnv(EXAPP_INVOKABLE_HOSTNAMES_ENV, JSON.stringify(['*.allowed.example']));

      await expect(
        assertPublicEndpointUrl('https://a.b.allowed.example/invoke'),
      ).resolves.toMatchObject({ url: expect.anything() });
      await expect(assertPublicEndpointUrl('https://allowed.example/invoke')).rejects.toBeInstanceOf(
        UnsafeExAppUrlError,
      );
    });

    it('SC-005: 内部IPに解決されうる非許可DNS名を拒否する（従来素通しだった経路）', async () => {
      vi.stubEnv(EXAPP_INVOKABLE_HOSTNAMES_ENV, JSON.stringify(['api.allowed.example']));

      await expect(
        assertPublicEndpointUrl('https://internal.corp.example/latest/meta-data'),
      ).rejects.toBeInstanceOf(UnsafeExAppUrlError);
    });

    it("'*' でも base の IP literal ガードは継続する（FR-012）", async () => {
      vi.stubEnv(EXAPP_INVOKABLE_HOSTNAMES_ENV, JSON.stringify(['*']));

      await expect(assertPublicEndpointUrl('https://169.254.169.254/x')).rejects.toBeInstanceOf(
        UnsafeExAppUrlError,
      );
    });

    it('正規表現はhostname全体にアンカーされ部分一致を許可しない', async () => {
      vi.stubEnv(EXAPP_INVOKABLE_HOSTNAMES_ENV, JSON.stringify([{ regex: 'chat\\.allowed\\.example' }]));

      const result = await assertPublicEndpointUrl('https://chat.allowed.example/invoke');
      expect(result.url.hostname).toBe('chat.allowed.example');

      await expect(
        assertPublicEndpointUrl('https://chat.allowed.example.evil.com/invoke'),
      ).rejects.toBeInstanceOf(UnsafeExAppUrlError);
    });
  });

  describe('matchEndpointAllowlist / parseAllowlistPatterns', () => {
    it('完全一致: 大文字・末尾ドットを正規化して一致する', () => {
      const patterns = parseAllowlistPatterns(JSON.stringify(['api.allowed.example']));

      expect(matchEndpointAllowlist('API.Allowed.Example.', patterns)).toBe(true);
      expect(matchEndpointAllowlist('x.allowed.example', patterns)).toBe(false);
    });

    it('サフィックス: 多段サブドメイン一致・apex非一致・非境界非一致', () => {
      const patterns = parseAllowlistPatterns(JSON.stringify(['*.example.com']));

      expect(matchEndpointAllowlist('a.example.com', patterns)).toBe(true);
      expect(matchEndpointAllowlist('a.b.example.com', patterns)).toBe(true);
      expect(matchEndpointAllowlist('example.com', patterns)).toBe(false);
      expect(matchEndpointAllowlist('notexample.com', patterns)).toBe(false);
      expect(matchEndpointAllowlist('example.com.evil.com', patterns)).toBe(false);
    });

    it("'*' は任意ホスト名に一致する", () => {
      const patterns = parseAllowlistPatterns(JSON.stringify(['*']));

      expect(matchEndpointAllowlist('anything.example', patterns)).toBe(true);
    });

    it('正規表現はアンカーされ部分一致しない', () => {
      const patterns = parseAllowlistPatterns(JSON.stringify([{ regex: 'api\\.example\\.com' }]));

      expect(matchEndpointAllowlist('api.example.com', patterns)).toBe(true);
      expect(matchEndpointAllowlist('evil-api.example.com.attacker.com', patterns)).toBe(false);
    });

    it.each([undefined, '', '[]', 'not-json', '{"a":1}', '"*"', '{"regex":".*"}', '"api.example.com"'])(
      'deny-all: %s は空パターン（全拒否）になる',
      (raw) => {
        const patterns = parseAllowlistPatterns(raw);

        expect(patterns).toHaveLength(0);
        expect(matchEndpointAllowlist('api.example.com', patterns)).toBe(false);
      },
    );

    it('不正な正規表現エントリはスキップされる（他エントリは有効）', () => {
      const patterns = parseAllowlistPatterns(
        JSON.stringify([{ regex: '(' }, 'api.allowed.example']),
      );

      expect(matchEndpointAllowlist('api.allowed.example', patterns)).toBe(true);
    });
  });

  describe('allowlist security — 正規表現アンカーによる bypass 防止', () => {
    const patternsFor = (regex: string) => parseAllowlistPatterns(JSON.stringify([{ regex }]));

    it('完全アンカーされ、prefix/suffix/substring では一致しない', () => {
      const patterns = patternsFor('api\\.allowed\\.example');

      expect(matchEndpointAllowlist('api.allowed.example', patterns)).toBe(true);
      expect(matchEndpointAllowlist('xapi.allowed.example', patterns)).toBe(false);
      expect(matchEndpointAllowlist('api.allowed.example.evil.com', patterns)).toBe(false);
      expect(matchEndpointAllowlist('api.allowed.example.attacker', patterns)).toBe(false);
      expect(matchEndpointAllowlist('sub.api.allowed.example.evil', patterns)).toBe(false);
    });

    it.each(['a)|(.*', '.*)|(x', 'api\\.allowed\\.example)|(?:.*'])(
      'グループを閉じてアンカーの外へ出る source %s は破棄され、全ホスト一致にならない',
      (regex) => {
        const patterns = patternsFor(regex);

        expect(patterns).toHaveLength(0);
        expect(matchEndpointAllowlist('evil.example', patterns)).toBe(false);
      },
    );

    it('大文字を含む regex でも、小文字化した hostname に一致する', () => {
      const patterns = patternsFor('API\\.Allowed\\.Example');

      expect(matchEndpointAllowlist('api.allowed.example', patterns)).toBe(true);
      expect(matchEndpointAllowlist('API.ALLOWED.EXAMPLE', patterns)).toBe(true);
      expect(matchEndpointAllowlist('api.allowed.example.evil', patterns)).toBe(false);
    });

    it('大文字の escape（\\S など）を含む regex も受け付ける', () => {
      const patterns = patternsFor('\\S+\\.allowed\\.example');

      expect(patterns).toHaveLength(1);
      expect(matchEndpointAllowlist('a.allowed.example', patterns)).toBe(true);
      expect(matchEndpointAllowlist('a.allowed.example.evil', patterns)).toBe(false);
    });

    it('alternation は列挙ホストのみ許可する', () => {
      const patterns = patternsFor('(?:api|www)\\.allowed\\.example');

      expect(matchEndpointAllowlist('api.allowed.example', patterns)).toBe(true);
      expect(matchEndpointAllowlist('www.allowed.example', patterns)).toBe(true);
      expect(matchEndpointAllowlist('evil.allowed.example', patterns)).toBe(false);
    });

    it('括弧で囲まない alternation でも、どの候補も hostname 全体にアンカーされる', () => {
      const patterns = patternsFor('api\\.a\\.example|api\\.b\\.example');

      expect(matchEndpointAllowlist('api.a.example', patterns)).toBe(true);
      expect(matchEndpointAllowlist('api.b.example', patterns)).toBe(true);
      expect(matchEndpointAllowlist('api.a.example.evil.com', patterns)).toBe(false);
      expect(matchEndpointAllowlist('evil.api.b.example', patterns)).toBe(false);
    });

    it('正規表現も、正規化した hostname（末尾ドットを除いたもの）に対して照合する', () => {
      const patterns = patternsFor('api\\.allowed\\.example');

      expect(matchEndpointAllowlist('api.allowed.example.', patterns)).toBe(true);
    });

    it('ラベル 1 語だけの regex は、その語の完全一致にしか反応しない（過剰一致しない）', () => {
      const patterns = patternsFor('allowed');

      expect(matchEndpointAllowlist('allowed', patterns)).toBe(true);
      expect(matchEndpointAllowlist('allowed.example.com', patterns)).toBe(false);
      expect(matchEndpointAllowlist('evil.allowed.example', patterns)).toBe(false);
    });

    it('.* を含む広い regex でもアンカー端は保たれる', () => {
      const patterns = patternsFor('.*\\.allowed\\.example');

      expect(matchEndpointAllowlist('a.allowed.example', patterns)).toBe(true);
      expect(matchEndpointAllowlist('a.b.allowed.example', patterns)).toBe(true);
      expect(matchEndpointAllowlist('allowed.example.evil.com', patterns)).toBe(false);
    });

    it('source に埋め込まれた ^ / $ があってもアンカーは崩れない', () => {
      const patterns = patternsFor('api\\.allowed\\.example$');

      expect(matchEndpointAllowlist('api.allowed.example', patterns)).toBe(true);
      expect(matchEndpointAllowlist('api.allowed.example.evil', patterns)).toBe(false);
    });

    it('末尾改行では一致しない（JS $ は非 multiline で文字列末尾のみ）', () => {
      const patterns = patternsFor('api\\.allowed\\.example');

      expect(matchEndpointAllowlist('api.allowed.example\n', patterns)).toBe(false);
      expect(matchEndpointAllowlist('api.allowed.example\nevil.example', patterns)).toBe(false);
    });

    it('エスケープしていないドットは任意 1 文字に一致する（regex の鋭利さ・ホストパターン推奨の根拠）', () => {
      const patterns = patternsFor('api.allowed.example');

      expect(matchEndpointAllowlist('api.allowed.example', patterns)).toBe(true);
      expect(matchEndpointAllowlist('apiXallowed.example', patterns)).toBe(true);
      expect(matchEndpointAllowlist('api.allowed.example.evil', patterns)).toBe(false);
    });
  });

  describe('allowlist security — ホストパターンの境界', () => {
    it('完全一致: 大文字・単一/複数末尾ドットを正規化するが substring は許可しない', () => {
      const patterns = parseAllowlistPatterns(JSON.stringify(['api.allowed.example']));

      expect(matchEndpointAllowlist('API.Allowed.Example', patterns)).toBe(true);
      expect(matchEndpointAllowlist('api.allowed.example.', patterns)).toBe(true);
      expect(matchEndpointAllowlist('api.allowed.example..', patterns)).toBe(true);
      expect(matchEndpointAllowlist('xapi.allowed.example', patterns)).toBe(false);
      expect(matchEndpointAllowlist('api.allowed.example.evil.com', patterns)).toBe(false);
    });

    it('サフィックスはラベル境界を要求し apex を含まない', () => {
      const patterns = parseAllowlistPatterns(JSON.stringify(['*.allowed.example']));

      expect(matchEndpointAllowlist('a.allowed.example', patterns)).toBe(true);
      expect(matchEndpointAllowlist('a.b.c.allowed.example', patterns)).toBe(true);
      expect(matchEndpointAllowlist('allowed.example', patterns)).toBe(false);
      expect(matchEndpointAllowlist('evil-allowed.example', patterns)).toBe(false);
      expect(matchEndpointAllowlist('xallowed.example', patterns)).toBe(false);
      expect(matchEndpointAllowlist('allowed.example.evil.com', patterns)).toBe(false);
      expect(matchEndpointAllowlist('.allowed.example', patterns)).toBe(false);
    });

    it('許可リスト側の大文字・末尾ドット・前後の空白も正規化してから照合する', () => {
      const patterns = parseAllowlistPatterns(
        JSON.stringify(['API.Allowed.Example.', '  *.Other.Example  ']),
      );

      expect(matchEndpointAllowlist('api.allowed.example', patterns)).toBe(true);
      expect(matchEndpointAllowlist('x.other.example', patterns)).toBe(true);
    });

    it.each([
      'https://api.allowed.example',
      'api.allowed.example/v1',
      'api.allowed.example:443',
      'user@api.allowed.example',
      'api.*.allowed.example',
      '*allowed.example',
      '*.*.allowed.example',
      '*.https://allowed.example',
      'a b.allowed.example',
      '%61pi.allowed.example',
      '例え.jp',
      '2001:4860:4860::8888',
      '.example.com',
      '*..example.com',
      '*.203.0.113.10',
      '*.[2001:db8::1]',
      '8.8.8',
      '0x08080808',
      '010.8.8.8',
      '*.8.8.8',
      '[2001:4860:4860:0:0::8888]',
      '[::ffff:8.8.8.8]',
    ])('ホスト名として正規形でない文字列 %s は破棄される', (entry) => {
      expect(parseAllowlistPatterns(JSON.stringify([entry]))).toHaveLength(0);
    });

    it('IDN は punycode で書けば、URL.hostname（punycode）に一致する', () => {
      const patterns = parseAllowlistPatterns(JSON.stringify(['xn--r8jz45g.jp']));

      expect(matchEndpointAllowlist(new URL('https://例え.jp/').hostname, patterns)).toBe(true);
    });

    it("空サフィックス '*.' は破棄され、全ホスト一致 bypass にならない", () => {
      expect(parseAllowlistPatterns(JSON.stringify(['*.']))).toHaveLength(0);
      expect(parseAllowlistPatterns(JSON.stringify(['*..']))).toHaveLength(0);
      expect(matchEndpointAllowlist('anything.example', parseAllowlistPatterns(JSON.stringify(['*.'])))).toBe(
        false,
      );
    });

    it('一致しうるホスト名が 253 文字を超える接尾辞は破棄され、253 文字のホスト名が一致しうる接尾辞は残る', () => {
      const suffixOf = (lastLabelLength: number) =>
        ['a'.repeat(63), 'a'.repeat(63), 'a'.repeat(63), 'a'.repeat(lastLabelLength)].join('.');

      expect(parseAllowlistPatterns(JSON.stringify([`*.${suffixOf(60)}`]))).toHaveLength(0);
      const patterns = parseAllowlistPatterns(JSON.stringify([`*.${suffixOf(59)}`]));
      expect(matchEndpointAllowlist(`a.${suffixOf(59)}`, patterns)).toBe(true);
    });

    it("広い TLD サフィックス '*.example' は運用者の明示選択として機能する", () => {
      const patterns = parseAllowlistPatterns(JSON.stringify(['*.example']));

      expect(matchEndpointAllowlist('a.example', patterns)).toBe(true);
      expect(matchEndpointAllowlist('a.b.example', patterns)).toBe(true);
      expect(matchEndpointAllowlist('example', patterns)).toBe(false);
    });

    it('IPv4 リテラルの完全一致で許可できる', () => {
      const patterns = parseAllowlistPatterns(JSON.stringify(['203.0.113.10']));

      expect(matchEndpointAllowlist('203.0.113.10', patterns)).toBe(true);
      expect(matchEndpointAllowlist('203.0.113.11', patterns)).toBe(false);
    });

    it('IPv6 リテラルはブラケット/大文字を正規化して一致する', () => {
      const patterns = parseAllowlistPatterns(JSON.stringify(['[2001:DB8::ABCD]']));

      expect(matchEndpointAllowlist('[2001:db8::abcd]', patterns)).toBe(true);
      expect(matchEndpointAllowlist('[2001:db8::abce]', patterns)).toBe(false);
    });
  });

  describe('allowlist security — 設定パースの堅牢性', () => {
    it('文字列/正規表現以外のエントリは無視され、正常エントリのみ残る', () => {
      const patterns = parseAllowlistPatterns(
        JSON.stringify([123, null, true, ['x'], { foo: 'bar' }, { regex: 42 }, 'api.allowed.example']),
      );

      expect(matchEndpointAllowlist('api.allowed.example', patterns)).toBe(true);
      expect(matchEndpointAllowlist('other.example', patterns)).toBe(false);
    });

    it('空文字・空白のみのエントリは破棄される', () => {
      expect(parseAllowlistPatterns(JSON.stringify(['', '   ', '\t']))).toHaveLength(0);
    });

    it('deny-all: 空エントリのみのリストは全拒否になる', () => {
      const patterns = parseAllowlistPatterns(JSON.stringify(['', { regex: '   ' }]));

      expect(patterns).toHaveLength(0);
      expect(matchEndpointAllowlist('api.example.com', patterns)).toBe(false);
    });
  });

  describe('allowlist security — assertPublicEndpointUrl の多層防御', () => {
    it('userinfo による host すり替えは、許可対象が @ 後ホストでも parseHttpsUrl 層で拒否される', async () => {
      vi.stubEnv(EXAPP_INVOKABLE_HOSTNAMES_ENV, JSON.stringify(['evil.example']));

      await expect(
        assertPublicEndpointUrl('https://api.allowed.example@evil.example/x'),
      ).rejects.toBeInstanceOf(UnsafeExAppUrlError);
    });

    it.each([['*.allowed.example'], [{ regex: '.*\\.allowed\\.example' }]])(
      '照合は生 URL ではなく hostname に対して行う（%j）',
      async (entry) => {
        vi.stubEnv(EXAPP_INVOKABLE_HOSTNAMES_ENV, JSON.stringify([entry]));

        await expect(
          assertPublicEndpointUrl('https://evil.example/x.allowed.example'),
        ).rejects.toBeInstanceOf(UnsafeExAppUrlError);
      },
    );

    it("'*' でも難読化 IPv4（10進/16進）の内部アドレスは base ガードで拒否される", async () => {
      vi.stubEnv(EXAPP_INVOKABLE_HOSTNAMES_ENV, JSON.stringify(['*']));

      await expect(assertPublicEndpointUrl('https://2130706433/x')).rejects.toBeInstanceOf(
        UnsafeExAppUrlError,
      );
      await expect(assertPublicEndpointUrl('https://0x7f000001/x')).rejects.toBeInstanceOf(
        UnsafeExAppUrlError,
      );
    });

    it('公開 IP リテラルは allowlist に入れれば許可される', async () => {
      vi.stubEnv(EXAPP_INVOKABLE_HOSTNAMES_ENV, JSON.stringify(['8.8.8.8']));

      const result = await assertPublicEndpointUrl('https://8.8.8.8/invoke');
      expect(result.url.hostname).toBe('8.8.8.8');
    });

    it('ポート指定は hostname 照合に影響しない（v1 は hostname のみ）', async () => {
      vi.stubEnv(EXAPP_INVOKABLE_HOSTNAMES_ENV, JSON.stringify(['api.allowed.example']));

      const result = await assertPublicEndpointUrl('https://api.allowed.example:8443/invoke');
      expect(result.url.hostname).toBe('api.allowed.example');
    });

    it('allowlist 内でも HTTP スキームは拒否される（scheme ガードが先）', async () => {
      vi.stubEnv(EXAPP_INVOKABLE_HOSTNAMES_ENV, JSON.stringify(['api.allowed.example']));

      await expect(assertPublicEndpointUrl('http://api.allowed.example/x')).rejects.toBeInstanceOf(
        UnsafeExAppUrlError,
      );
    });

    it('assertPublicStatusUrl（poll 経路）でも endpoint が allowlist 照合される', async () => {
      vi.stubEnv(EXAPP_INVOKABLE_HOSTNAMES_ENV, JSON.stringify(['api.allowed.example']));

      await expect(
        assertPublicStatusUrl('/status/1', 'https://evil.example/invoke'),
      ).rejects.toBeInstanceOf(UnsafeExAppUrlError);

      const result = await assertPublicStatusUrl('/status/1', 'https://api.allowed.example/invoke');
      expect(result.url.toString()).toBe('https://api.allowed.example/status/1');
    });
  });
});
