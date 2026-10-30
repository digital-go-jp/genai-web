import { passwordPolicyInputSchema } from '@genai-web/common';
import { z } from 'zod';
import { parseAllowlistEntry } from '../lambda/utils/exAppAllowlist';

/**
 * CDKコンテキストから渡される文字列値を適切な型に変換する
 * JSON.parseを試行し、成功すればその結果を返す
 * 失敗した場合は元の値をそのまま返す
 */
const parseContextValue = (value: unknown): unknown => {
  // すでに文字列でない場合はそのまま返す（env-parametersから来た値）
  if (typeof value !== 'string') {
    return value;
  }

  // 空文字列はそのまま返す
  if (value === '') {
    return value;
  }

  // JSON parseを試行
  try {
    return JSON.parse(value);
  } catch {
    // parseに失敗した場合は元の文字列のまま返す
    return value;
  }
};

/**
 * オブジェクトの全プロパティに対してparseContextValueを再帰的に適用
 */
export const preprocessContextValues = (obj: Record<string, unknown>): Record<string, unknown> => {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      // ネストされたオブジェクトの場合は再帰的に処理
      result[key] = preprocessContextValues(value as Record<string, unknown>);
    } else {
      result[key] = parseContextValue(value);
    }
  }

  return result;
};

export const govaiForHomepage = z.object({
  title: z.string(),
  teamId: z.literal('00000000-0000-0000-0000-000000000000'), // 共通チームIDのみ許可する。拡張時はここをstrng()に変更する。
  exAppId: z.string(),
  description: z.string(),
});

// Common Validator
export const stackInputSchema = z
  .object({
    account: z.string().default(process.env.CDK_DEFAULT_ACCOUNT ?? ''),
    region: z.string().default(process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-1'),
    env: z.string().default(''),
    appEnv: z
      .string()
      .regex(
        /^[a-zA-Z0-9/_-]+$/,
        'appEnv must contain only characters allowed by both Secrets Manager and KMS alias names, excluding "." (a-zA-Z0-9/_-), and must be non-empty',
      )
      .default(''),
    anonymousUsageTracking: z.boolean().default(true),
    logLevel: z.enum(['INFO', 'WARN', 'ERROR', 'DEBUG']).default('INFO'),

    // Auth
    selfSignUpEnabled: z.boolean().default(false),
    allowedSignUpEmailDomains: z.array(z.string()).nullable(),
    samlAuthEnabled: z.boolean().default(false),
    customEmailSender: z
      .object({
        sesIdentityName: z
          .string()
          .min(1)
          .refine((val) => {
            if (val.includes('@')) {
              return z.string().email().safeParse(val).success;
            }
            return /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/.test(val);
          }, 'sesIdentityName must be a domain name (e.g., example.go.jp) or email address (e.g., admin@example.go.jp)'),
        fromAddress: z.string().email('fromAddress must be a valid email address'),
        sesConfigurationSetName: z
          .string()
          .regex(
            /^[a-zA-Z0-9_-]{1,64}$/,
            'sesConfigurationSetName must contain only alphanumeric characters, hyphens, and underscores (1-64 chars)',
          )
          .optional(),
      })
      .nullish(),
    emailMfaRequired: z.boolean().default(false),
    passwordPolicy: passwordPolicyInputSchema,
    reauthenticationIntervalDays: z.number().min(1).max(365).default(7),
    samlCognitoDomainName: z.string().nullish(),
    samlCognitoFederatedIdentityPrimaryProviderName: z.string().nullish(),
    samlCognitoFederatedIdentityAdditionalProviderNames: z
      .array(
        z.object({
          providerName: z.string(),
          signinPath: z.string(), // /login/{signinPath}
        }),
      )
      .nullish(),
    // Frontend
    hiddenUseCases: z
      .object({
        generate: z.boolean().optional(),
        translate: z.boolean().optional(),
        image: z.boolean().optional(),
        diagram: z.boolean().optional(),
      })
      .default({}),
    govais_for_homepage: z.array(govaiForHomepage).default([]),
    top_chat_system_prompt: z.string().default(''),
    top_chat_system_prompt_title: z.string().default(''),

    // API
    modelRegion: z.string().default('ap-northeast-1'),
    modelIds: z
      .array(z.string())
      .default([
        'jp.anthropic.claude-sonnet-4-6',
        'amazon.nova-lite-v1:0',
        'jp.anthropic.claude-haiku-4-5-20251001-v1:0',
        'jp.anthropic.claude-sonnet-4-5-20250929-v1:0',
      ]),
    defaultModelId: z.string().default('jp.anthropic.claude-sonnet-4-6'),
    imageGenerationModelIds: z.array(z.string()).default(['amazon.nova-canvas-v1:0']),
    endpointNames: z.array(z.string()).default([]),
    crossAccountBedrockRoleArn: z.string().nullish(),
    // Guardrail
    guardrailEnabled: z.boolean().default(false),
    // Recently used AI apps (LandingPage section)
    recentlyUsedAppsEnabled: z.boolean().default(false),
    // Flows
    flows: z
      .array(
        z.object({
          flowId: z.string(),
          aliasId: z.string(),
          flowName: z.string(),
          description: z.string(),
        }),
      )
      .default([]),
    // WAF
    allowedIpV4AddressRanges: z.array(z.string()).nullable(),
    allowedIpV6AddressRanges: z.array(z.string()).nullable(),
    allowedCountryCodes: z.array(z.string()).nullish(),

    // Custom Domain
    useHostedZone: z.boolean().default(false),
    hostName: z.string().nullish(),
    domainName: z.string().nullish(),
    hostedZoneId: z.string().nullish(),
    certificateArn: z.string().nullish(),

    // Dashboard
    dashboard: z.boolean().default(false),
    // Shared VPC for invokeExApp
    vpcIdForInvokeExApp: z.string().default(''),
    // Log
    destination: z // ログ収集システムのログ送信先
      .object({
        // AWSアカウントIDは先頭に0がつく可能性があるため、必ず文字列として扱う
        // coerce.string()でnumberも自動的にstringに変換
        accountId: z.coerce.string(),
        endpointUrl: z.string(),
      })
      .optional(), // 指定がない場合はログに関するスタックを作成しない
    logAccumulationBucketExpirationDays: z.number().default(30),
    DailyExportLambdaLogRetentionDays: z.number().default(30),
    // Cron式のhourパラメータは文字列型（coerce.string()でnumberも自動的にstringに変換）
    DailyExportEventHourUTC: z.coerce.string().default('17'), // 17:00 UTC = 02:00 JST
    TransferS3LogsHourUTC: z.coerce.string().default('18'), // 1 hour after Daily Export

    // Monitoring
    monitoring: z.boolean().default(true),
    slack: z
      .object({
        enabled: z.boolean().default(false),
        workspaceId: z.string().default(''),
        channelId: z.string().default(''),
      })
      .default({ enabled: false, workspaceId: '', channelId: '' }),
    monitoringCrossRegionSnsTopicExportName: z.string().default('MonitoringAlertsTopic'),

    // ExApp API Timeout Configuration
    exAppInvokeTimeoutSeconds: z.number().min(3).max(300).default(29),

    exAppInvokableHostnames: z
      .array(
        z.union([z.string().trim().min(1), z.object({ regex: z.string().trim().min(1) }).strict()]),
      )
      .default([])
      .superRefine((entries, ctx) => {
        entries.forEach((entry, index) => {
          if (parseAllowlistEntry(entry) === undefined) {
            const label =
              typeof entry === 'object'
                ? `regex ${JSON.stringify(entry.regex)}`
                : `host pattern ${JSON.stringify(entry)}`;
            ctx.addIssue({
              code: 'custom',
              path: [index],
              message: `Invalid exAppInvokableHostnames ${label}: unparseable or degenerate (dropped at runtime, risking unintended deny-all)`,
            });
          }
        });
      }),

    // Data Retention Configuration
    dataRetentionDays: z
      .object({
        // DynamoDB TTL設定（日数）
        dynamoDbTtl: z.number().min(1).default(364),
        // S3ファイルのライフサイクル設定（日数）
        s3FileExpiration: z.number().min(1).default(364),
      })
      .default({
        dynamoDbTtl: 364,
        s3FileExpiration: 364,
      }),

    // Database Removal Policy Configuration
    databaseRemovalPolicy: z.enum(['DESTROY', 'RETAIN']).default('DESTROY'),

    // Maintenance Mode
    maintenance: z.boolean().default(false),

    costConversion: z
      .object({
        // 変換後通貨（例: 'JPY'）。未設定なら converted を付与しない。
        toCurrency: z.string().default(''),
        // 適用レート（変換元通貨あたり converted 通貨の量）。0 以下や非有限値なら converted なし。
        rate: z.number().default(0),
        allowedFromCurrencies: z.array(z.string()).default([]),
      })
      .default({ toCurrency: '', rate: 0, allowedFromCurrencies: [] }),
  })
  .refine(
    (data) => {
      if (data.emailMfaRequired && data.samlAuthEnabled) return false;
      return true;
    },
    {
      message:
        'emailMfaRequired is not applicable when samlAuthEnabled is true (SAML IdP handles MFA)',
    },
  )
  .refine(
    (data) => {
      if (data.samlAuthEnabled && !data.samlCognitoFederatedIdentityPrimaryProviderName) {
        return false;
      }
      return true;
    },
    {
      message:
        'samlCognitoFederatedIdentityPrimaryProviderName is required when samlAuthEnabled is true',
    },
  )
  .refine((data) => !(data.emailMfaRequired && !data.customEmailSender), {
    message: 'customEmailSender is required when emailMfaRequired is true',
  });

export type StackInput = z.infer<typeof stackInputSchema>;
