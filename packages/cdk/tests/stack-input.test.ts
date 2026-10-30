import { DEFAULT_PASSWORD_POLICY } from '@genai-web/common';
import { describe, expect, test } from 'vitest';
import { stackInputSchema } from '../lib/stack-input';

const baseParams = {
  account: '123456789012',
  region: 'ap-northeast-1',
  env: '-test',
  appEnv: 'test',
  allowedSignUpEmailDomains: null,
  allowedIpV4AddressRanges: null,
  allowedIpV6AddressRanges: null,
};

describe('StackInput databaseRemovalPolicy', () => {
  test('accepts DESTROY value', () => {
    const input = {
      ...baseParams,
      databaseRemovalPolicy: 'DESTROY',
    };
    const result = stackInputSchema.parse(input);
    expect(result.databaseRemovalPolicy).toBe('DESTROY');
  });

  test('accepts RETAIN value', () => {
    const input = {
      ...baseParams,
      databaseRemovalPolicy: 'RETAIN',
    };
    const result = stackInputSchema.parse(input);
    expect(result.databaseRemovalPolicy).toBe('RETAIN');
  });

  test('rejects invalid value', () => {
    const input = {
      ...baseParams,
      databaseRemovalPolicy: 'DELETE',
    };
    expect(() => stackInputSchema.parse(input)).toThrow();
  });

  test('applies default DESTROY when not specified', () => {
    const result = stackInputSchema.parse(baseParams);
    expect(result.databaseRemovalPolicy).toBe('DESTROY');
  });
});

describe('StackInput appEnv', () => {
  test('accepts characters allowed by both Secrets Manager and KMS alias names', () => {
    const result = stackInputSchema.parse({ ...baseParams, appEnv: 'gss-prd_1/2' });
    expect(result.appEnv).toBe('gss-prd_1/2');
  });

  test.each(['dev+1', 'dev=1', 'dev@1', 'dev.1'])(
    'rejects appEnv containing KMS-alias-incompatible character (%s)',
    (appEnv) => {
      expect(() => stackInputSchema.parse({ ...baseParams, appEnv })).toThrow();
    },
  );

  test('rejects empty appEnv', () => {
    expect(() => stackInputSchema.parse({ ...baseParams, appEnv: '' })).toThrow();
  });
});

describe('StackInput passwordPolicy', () => {
  test('applies current default password policy when omitted', () => {
    const result = stackInputSchema.parse(baseParams);
    expect(result.passwordPolicy).toEqual(DEFAULT_PASSWORD_POLICY);
  });

  test('merges partial password policy overrides with defaults', () => {
    const result = stackInputSchema.parse({
      ...baseParams,
      passwordPolicy: {
        minLength: 12,
        requireSymbols: false,
      },
    });

    expect(result.passwordPolicy).toEqual({
      ...DEFAULT_PASSWORD_POLICY,
      minLength: 12,
      requireSymbols: false,
    });
  });

  test('rejects too short password policy minLength', () => {
    expect(() =>
      stackInputSchema.parse({
        ...baseParams,
        passwordPolicy: {
          minLength: 5,
        },
      }),
    ).toThrow();
  });
});

describe('StackInput SAML validation', () => {
  test('rejects samlAuthEnabled=true without primaryProviderName', () => {
    const input = {
      ...baseParams,
      samlAuthEnabled: true,
    };
    expect(() => stackInputSchema.parse(input)).toThrow(
      'samlCognitoFederatedIdentityPrimaryProviderName is required when samlAuthEnabled is true',
    );
  });

  test('rejects samlAuthEnabled=true with empty string primaryProviderName', () => {
    const input = {
      ...baseParams,
      samlAuthEnabled: true,
      samlCognitoFederatedIdentityPrimaryProviderName: '',
    };
    expect(() => stackInputSchema.parse(input)).toThrow(
      'samlCognitoFederatedIdentityPrimaryProviderName is required when samlAuthEnabled is true',
    );
  });

  test('accepts samlAuthEnabled=true with primaryProviderName', () => {
    const input = {
      ...baseParams,
      samlAuthEnabled: true,
      samlCognitoFederatedIdentityPrimaryProviderName: 'EntraID',
    };
    const result = stackInputSchema.parse(input);
    expect(result.samlAuthEnabled).toBe(true);
    expect(result.samlCognitoFederatedIdentityPrimaryProviderName).toBe('EntraID');
  });

  test('accepts samlAuthEnabled=false without primaryProviderName', () => {
    const input = {
      ...baseParams,
      samlAuthEnabled: false,
    };
    const result = stackInputSchema.parse(input);
    expect(result.samlAuthEnabled).toBe(false);
  });
});

describe('StackInput exAppInvokableHostnames', () => {
  test('defaults to [] (deny-all) when omitted', () => {
    const result = stackInputSchema.parse(baseParams);
    expect(result.exAppInvokableHostnames).toEqual([]);
  });

  test.each([
    ['*'],
    ['api.allowed.example'],
    ['*.allowed.example'],
    [{ regex: 'api\\.allowed\\.example' }],
    [{ regex: 'API\\.Allowed\\.Example' }],
    ['api.allowed.example', { regex: '(?:a|b)\\.allowed\\.example' }],
    ['xn--r8jz45g.jp'],
    ['[2001:db8::1]'],
  ])('accepts valid allowlist entry set %j', (...entries) => {
    const result = stackInputSchema.parse({ ...baseParams, exAppInvokableHostnames: entries });
    expect(result.exAppInvokableHostnames).toEqual(entries);
  });

  test.each([
    [['*.']],
    [['*..']],
    [['.']],
    [['   ']],
    [[{ regex: '(' }]],
    [[{ regex: 'a)|(.*' }]],
    [['https://api.allowed.example']],
    [['api.allowed.example/v1']],
    [['api.allowed.example:443']],
    [['api.*.allowed.example']],
    [['*allowed.example']],
    [['例え.jp']],
    [['2001:db8::1']],
    [['.example.com']],
    [['*..example.com']],
    [['*.203.0.113.10']],
    [['*.[2001:db8::1]']],
    [['8.8.8']],
    [['0x08080808']],
    [['010.8.8.8']],
    [['*.8.8.8']],
    [['[2001:4860:4860:0:0::8888]']],
    [['[::ffff:8.8.8.8]']],
    [['api.allowed.example', 'https://chat.allowed.example']],
    [['*', { regex: '(' }]],
  ])('rejects degenerate/invalid entry set %j at synth (FR-011)', (entries) => {
    expect(() =>
      stackInputSchema.parse({ ...baseParams, exAppInvokableHostnames: entries }),
    ).toThrow();
  });

  describe('DNS length limits', () => {
    const labelOf = (length: number) => 'a'.repeat(length);
    const hostnameOf253 = [labelOf(63), labelOf(63), labelOf(63), labelOf(61)].join('.');
    const hostnameOf254 = [labelOf(63), labelOf(63), labelOf(63), labelOf(62)].join('.');

    test('the boundary hostnames are 253 and 254 characters long', () => {
      expect(hostnameOf253).toHaveLength(253);
      expect(hostnameOf254).toHaveLength(254);
    });

    test.each([
      ['a 253-character hostname', hostnameOf253],
      ['a 63-character label', `${labelOf(63)}.example`],
      ['a suffix with a 63-character label', `*.${labelOf(63)}.example`],
      [
        'a 251-character suffix, which a 253-character hostname can match',
        `*.${[labelOf(63), labelOf(63), labelOf(63), labelOf(59)].join('.')}`,
      ],
    ])('accepts %s', (_label, entry) => {
      const result = stackInputSchema.parse({ ...baseParams, exAppInvokableHostnames: [entry] });
      expect(result.exAppInvokableHostnames).toEqual([entry]);
    });

    test.each([
      ['a 254-character hostname', hostnameOf254],
      ['a 64-character label', `${labelOf(64)}.example`],
      ['a suffix with a 64-character label', `*.${labelOf(64)}.example`],
      [
        'a 252-character suffix, which only hostnames over 253 characters can match',
        `*.${[labelOf(63), labelOf(63), labelOf(63), labelOf(60)].join('.')}`,
      ],
    ])('rejects %s at synth', (_label, entry) => {
      expect(() =>
        stackInputSchema.parse({ ...baseParams, exAppInvokableHostnames: [entry] }),
      ).toThrow(/Invalid exAppInvokableHostnames host pattern/);
    });
  });
});
