import * as cdk from 'aws-cdk-lib';
import { NestedStack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, test } from 'vitest';
import { EXAPP_INVOKABLE_HOSTNAMES_DENY_ALL_WARNING_ID } from '../../lib/construct/team-access-control';
import { createStacks } from '../../lib/create-stacks';
import { stackInputSchema } from '../../lib/stack-input';
import { EXAPP_INVOKABLE_HOSTNAMES_ENV } from '../../lambda/utils/exAppAllowlist';

const BEFORE_ALL_TIMEOUT = 1_800_000;

const BASE_PARAMS = {
  account: '123456789012',
  region: 'ap-northeast-1',
  env: '',
  allowedSignUpEmailDomains: null,
  allowedIpV4AddressRanges: null,
  allowedIpV6AddressRanges: null,
};

const LAMBDA_TYPE = 'AWS::Lambda::Function';
const EVENT_SOURCE_MAPPING_TYPE = 'AWS::Lambda::EventSourceMapping';
const TEAM_ACCESS_CONTROL_STACK_ID = 'TeamAccessControlStack';

const TEST_ALLOWLIST = [
  'api.allowed.example',
  '*.allowed.example',
  { regex: 'chat\\.allowed\\.example' },
];
const TEST_ALLOWLIST_JSON = JSON.stringify(TEST_ALLOWLIST);

type LambdaResource = {
  Properties?: { Environment?: { Variables?: Record<string, unknown> } };
};

const findNestedTemplate = (parentStack: cdk.Stack, nestedStackId: string): Template => {
  const nested = parentStack.node
    .findAll()
    .filter((c): c is NestedStack => c instanceof NestedStack)
    .find((ns) => ns.node.id === nestedStackId);
  if (!nested) {
    throw new Error(`NestedStack "${nestedStackId}" was not found`);
  }
  return Template.fromStack(nested);
};

const envOf = (fn: LambdaResource): Record<string, unknown> =>
  fn.Properties?.Environment?.Variables ?? {};

const lambdaEntries = (template: Template): Array<{ logicalId: string; env: Record<string, unknown> }> =>
  Object.entries(template.findResources(LAMBDA_TYPE)).map(([logicalId, res]) => ({
    logicalId,
    env: envOf(res as LambdaResource),
  }));

const eventSourceMappingTargetIds = (template: Template): string[] => {
  const mappings = template.findResources(EVENT_SOURCE_MAPPING_TYPE);
  const ids: string[] = [];
  for (const res of Object.values(mappings)) {
    const fnName = (res as { Properties?: { FunctionName?: unknown } }).Properties?.FunctionName;
    if (fnName && typeof fnName === 'object') {
      const ref = (fnName as { Ref?: string }).Ref;
      const getAtt = (fnName as { 'Fn::GetAtt'?: [string, string] })['Fn::GetAtt'];
      if (typeof ref === 'string') {
        ids.push(ref);
      } else if (Array.isArray(getAtt)) {
        ids.push(getAtt[0]);
      }
    }
  }
  return ids;
};

const synthGenerativeAiUseCasesStack = (overrides: Record<string, unknown>): cdk.Stack => {
  const app = new cdk.App();
  const params = stackInputSchema.parse({ ...BASE_PARAMS, ...overrides });
  return createStacks(app, params).generativeAiUseCasesStack;
};

const denyAllWarningCount = (stack: cdk.Stack): number =>
  Annotations.fromStack(stack).findWarning(
    '*',
    Match.stringLikeRegexp(EXAPP_INVOKABLE_HOSTNAMES_DENY_ALL_WARNING_ID),
  ).length;

describe('ExApp invocable-endpoint allowlist env 配布 (spec 20260831-exapp-endpoint-allowlist)', () => {
  let stack: cdk.Stack;
  let template: Template;
  let entries: Array<{ logicalId: string; env: Record<string, unknown> }>;

  beforeAll(() => {
    stack = synthGenerativeAiUseCasesStack({ exAppInvokableHostnames: TEST_ALLOWLIST });
    template = findNestedTemplate(stack, TEAM_ACCESS_CONTROL_STACK_ID);
    entries = lambdaEntries(template);
  }, BEFORE_ALL_TIMEOUT);

  test('許可リストが空でなければ deny-all の警告は出ない', () => {
    expect(denyAllWarningCount(stack)).toBe(0);
  });

  test(
    '許可リストが空なら synth で deny-all を警告する',
    () => {
      const denyAllStack = synthGenerativeAiUseCasesStack({ exAppInvokableHostnames: [] });

      expect(denyAllWarningCount(denyAllStack)).toBeGreaterThan(0);
    },
    BEFORE_ALL_TIMEOUT,
  );

  test('reader/writer parity: 共有定数名で env が配布される (FR-013)', () => {
    const carriers = entries.filter((e) => EXAPP_INVOKABLE_HOSTNAMES_ENV in e.env);
    expect(carriers.length).toBeGreaterThan(0);
  });

  test('配布値は exAppInvokableHostnames の JSON 直列化と一致する (FR-014)', () => {
    const carriers = entries.filter((e) => EXAPP_INVOKABLE_HOSTNAMES_ENV in e.env);
    for (const carrier of carriers) {
      expect(carrier.env[EXAPP_INVOKABLE_HOSTNAMES_ENV]).toBe(TEST_ALLOWLIST_JSON);
    }
  });

  test('invoke Lambda（POLLING_QUEUE_URL 保有）に env が付与される', () => {
    const invoke = entries.filter((e) => 'POLLING_QUEUE_URL' in e.env);
    expect(invoke.length).toBeGreaterThan(0);
    for (const fn of invoke) {
      expect(fn.env[EXAPP_INVOKABLE_HOSTNAMES_ENV]).toBe(TEST_ALLOWLIST_JSON);
    }
  });

  test('poll Lambda（SQS EventSourceMapping のターゲット）に env が付与される', () => {
    const targetIds = eventSourceMappingTargetIds(template);
    expect(targetIds.length).toBeGreaterThan(0);
    for (const id of targetIds) {
      const fn = entries.find((e) => e.logicalId === id);
      expect(fn, `EventSourceMapping target ${id} not found`).toBeDefined();
      expect(fn!.env[EXAPP_INVOKABLE_HOSTNAMES_ENV]).toBe(TEST_ALLOWLIST_JSON);
    }
  });

  test('create/update/copy を含むヘルパ系 Lambda（EXAPP_TABLE_NAME 保有）すべてに env が付与される', () => {
    const helperFns = entries.filter((e) => 'EXAPP_TABLE_NAME' in e.env);
    expect(helperFns.length).toBeGreaterThan(0);
    for (const fn of helperFns) {
      expect(fn.env[EXAPP_INVOKABLE_HOSTNAMES_ENV]).toBe(TEST_ALLOWLIST_JSON);
    }
  });
});
