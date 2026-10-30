import { APIGatewayProxyEvent } from 'aws-lambda';
import { afterAll, beforeEach, describe, expect, type MockedFunction, test, vi } from 'vitest';
import { handler } from '../../lambda/copyExApp';
import { createExApp, findExAppById } from '../../lambda/repository/exAppRepository';
import { findTeamById } from '../../lambda/repository/teamRepository';
import * as teamRole from '../../lambda/utils/teamRole';
import * as apiKey from '../../lambda/utils/apiKey';
import { EXAPP_INVOKABLE_HOSTNAMES_ENV } from '../../lambda/utils/exAppAllowlist';

vi.mock('../../lambda/repository/exAppRepository');
vi.mock('../../lambda/repository/teamRepository');
vi.mock('../../lambda/utils/teamRole', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lambda/utils/teamRole')>();
  return {
    ...actual,
    isSystemAdmin: vi.fn(),
    isTeamAdmin: vi.fn(),
  };
});
vi.mock('../../lambda/utils/apiKey', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lambda/utils/apiKey')>();
  return {
    ...actual,
    getApiKeyValue: vi.fn(),
    setApiKey: vi.fn(),
  };
});

const mockedCreateExApp = createExApp as MockedFunction<typeof createExApp>;
const mockedFindExAppById = findExAppById as MockedFunction<typeof findExAppById>;
const mockedFindTeamById = findTeamById as MockedFunction<typeof findTeamById>;
const mockedIsSystemAdmin = teamRole.isSystemAdmin as MockedFunction<
  typeof teamRole.isSystemAdmin
>;
const mockedIsTeamAdmin = teamRole.isTeamAdmin as MockedFunction<
  typeof teamRole.isTeamAdmin
>;
const mockedGetApiKeyValue = apiKey.getApiKeyValue as MockedFunction<
  typeof apiKey.getApiKeyValue
>;
const mockedSetApiKey = apiKey.setApiKey as MockedFunction<
  typeof apiKey.setApiKey
>;

const originalEnv = process.env;
beforeEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv };
  process.env.APP_ENV = 'test';
  process.env[EXAPP_INVOKABLE_HOSTNAMES_ENV] = JSON.stringify(['*']);
});

afterAll(() => {
  process.env = originalEnv;
});

function createValidRequestBody() {
  return {
    exAppName: 'コピーされたアプリ',
    description: 'コピーされたアプリの概要',
    howToUse: 'コピーされたアプリの使い方',
    placeholder: '{"input": "test"}',
    config: '{"model": "test"}',
    systemPrompt: 'テストプロンプト',
    systemPromptKeyName: 'system',
    copyable: true,
    status: 'draft',
  };
}

function createAPIGatewayProxyEvent(
  body: unknown | null,
  teamId?: string,
  exAppId?: string,
): APIGatewayProxyEvent {
  return {
    body: body ? JSON.stringify(body) : null,
    pathParameters: { teamId, exAppId },
    requestContext: {
      authorizer: {
        claims: {
          'cognito:groups': 'SystemAdminGroup',
          sub: 'test-user-id',
        },
      },
    },
  } as unknown as APIGatewayProxyEvent;
}

describe('copyExApp Lambda handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  test('システム管理者がExAppを正常にコピーできる', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'source-exapp-id';
    const now = Date.now().toString();

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    mockedFindTeamById.mockResolvedValue({
      teamId,
      teamName: 'テストチーム',
      createdDate: now,
      updatedDate: now,
    });

    mockedFindExAppById.mockResolvedValue({
      teamId,
      exAppId,
      exAppName: '元アプリ',
      description: '元アプリの概要',
      howToUse: '元アプリの使い方',
      endpoint: 'https://api.example.com/original',
      apiKey: '',
      placeholder: '{"input": "original"}',
      config: '{"model": "original"}',
      systemPrompt: '元プロンプト',
      systemPromptKeyName: 'system',
      copyable: true,
      status: 'published',
      createdDate: now,
      updatedDate: now,
    });

    mockedGetApiKeyValue.mockResolvedValue('original-api-key');

    mockedCreateExApp.mockResolvedValue({
      teamId,
      exAppId: 'copied-exapp-id',
      exAppName: 'コピーされたアプリ',
      description: 'コピーされたアプリの概要',
      howToUse: 'コピーされたアプリの使い方',
      endpoint: 'https://api.example.com/original',
      apiKey: '',
      placeholder: '{"input": "test"}',
      config: '{"model": "test"}',
      systemPrompt: 'テストプロンプト',
      systemPromptKeyName: 'system',
      copyable: true,
      status: 'draft',
      createdDate: now,
      updatedDate: now,
    });

    mockedSetApiKey.mockResolvedValue(undefined);

    const event = createAPIGatewayProxyEvent(createValidRequestBody(), teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(mockedCreateExApp).toHaveBeenCalled();
    expect(mockedSetApiKey).toHaveBeenCalledWith(teamId, 'copied-exapp-id', 'original-api-key', expect.any(String));

    const body = JSON.parse(result.body);
    expect(body.exAppId).toBe('copied-exapp-id');
    expect(body.exAppName).toBe('コピーされたアプリ');
  });

  test('copyable=falseのExAppをコピーしようとすると403エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'source-exapp-id';
    const now = Date.now().toString();

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    mockedFindTeamById.mockResolvedValue({
      teamId,
      teamName: 'テストチーム',
      createdDate: now,
      updatedDate: now,
    });

    mockedFindExAppById.mockResolvedValue({
      teamId,
      exAppId,
      exAppName: '元アプリ',
      description: '元アプリの概要',
      howToUse: '元アプリの使い方',
      endpoint: 'https://api.example.com/original',
      apiKey: '',
      placeholder: '{"input": "original"}',
      config: '{"model": "original"}',
      systemPrompt: '元プロンプト',
      systemPromptKeyName: 'system',
      copyable: false,
      status: 'published',
      createdDate: now,
      updatedDate: now,
    });

    const event = createAPIGatewayProxyEvent(createValidRequestBody(), teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body)).toEqual({
      error: 'このAIアプリはコピーできません。',
    });
    expect(mockedCreateExApp).not.toHaveBeenCalled();
    expect(mockedGetApiKeyValue).not.toHaveBeenCalled();
  });

  test('copyableが未定義のExAppをコピーしようとすると403エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'source-exapp-id';
    const now = Date.now().toString();

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    mockedFindTeamById.mockResolvedValue({
      teamId,
      teamName: 'テストチーム',
      createdDate: now,
      updatedDate: now,
    });

    mockedFindExAppById.mockResolvedValue({
      teamId,
      exAppId,
      exAppName: '元アプリ',
      description: '元アプリの概要',
      howToUse: '元アプリの使い方',
      endpoint: 'https://api.example.com/original',
      apiKey: '',
      placeholder: '{"input": "original"}',
      config: '{"model": "original"}',
      systemPrompt: '元プロンプト',
      systemPromptKeyName: 'system',
      status: 'published',
      createdDate: now,
      updatedDate: now,
    });

    const event = createAPIGatewayProxyEvent(createValidRequestBody(), teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body)).toEqual({
      error: 'このAIアプリはコピーできません。',
    });
    expect(mockedCreateExApp).not.toHaveBeenCalled();
    expect(mockedGetApiKeyValue).not.toHaveBeenCalled();
  });

  test('管理者でない場合は403エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'source-exapp-id';

    mockedIsSystemAdmin.mockReturnValue(false);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const event = createAPIGatewayProxyEvent(createValidRequestBody(), teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body)).toEqual({
      error: '管理者ではないため利用できません。',
    });
  });

  test('アプリ名が空の場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'source-exapp-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), exAppName: '' };
    const event = createAPIGatewayProxyEvent(body, teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'アプリ名は必須です。',
    });
  });

  test('アプリ名が文字列でない場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'source-exapp-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), exAppName: 123 };
    const event = createAPIGatewayProxyEvent(body, teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'アプリ名の形式が不正です。',
    });
  });

  test('概要が空の場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'source-exapp-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), description: '' };
    const event = createAPIGatewayProxyEvent(body, teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: '概要は必須です。',
    });
  });

  test('概要が文字列でない場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'source-exapp-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), description: 123 };
    const event = createAPIGatewayProxyEvent(body, teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: '概要の形式が不正です。',
    });
  });

  test('使い方が空の場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'source-exapp-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), howToUse: '' };
    const event = createAPIGatewayProxyEvent(body, teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: '使い方は必須です。',
    });
  });

  test('使い方が文字列でない場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'source-exapp-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), howToUse: 123 };
    const event = createAPIGatewayProxyEvent(body, teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: '使い方の形式が不正です。',
    });
  });

  test('placeholderが空の場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'source-exapp-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), placeholder: '' };
    const event = createAPIGatewayProxyEvent(body, teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'APIリクエストは必須です。',
    });
  });

  test('placeholderが文字列でない場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'source-exapp-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), placeholder: 123 };
    const event = createAPIGatewayProxyEvent(body, teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'APIリクエストの形式が不正です。',
    });
  });

  test('placeholderのJSON形式が不正な場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'source-exapp-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), placeholder: 'invalid-json' };
    const event = createAPIGatewayProxyEvent(body, teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'APIリクエストのJSON形式が不正です。',
    });
  });

  test('configのJSON形式が不正な場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'source-exapp-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), config: 'invalid-json' };
    const event = createAPIGatewayProxyEvent(body, teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'コンフィグのJSON形式が不正です。',
    });
  });

  test('configが文字列でない場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'source-exapp-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), config: 123 };
    const event = createAPIGatewayProxyEvent(body, teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'コンフィグの形式が不正です。',
    });
  });

  test('systemPromptが文字列でない場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'source-exapp-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), systemPrompt: 123 };
    const event = createAPIGatewayProxyEvent(body, teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'システムプロンプトの形式が不正です。',
    });
  });

  test('systemPromptKeyNameが文字列でない場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'source-exapp-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), systemPromptKeyName: 123 };
    const event = createAPIGatewayProxyEvent(body, teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'システムプロンプトキー名の形式が不正です。',
    });
  });

  test('copyableがブール値でない場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'source-exapp-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), copyable: 'true' };
    const event = createAPIGatewayProxyEvent(body, teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'コピー可能フラグの形式が不正です。',
    });
  });

  test('ステータスが空の場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'source-exapp-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), status: '' };
    const event = createAPIGatewayProxyEvent(body, teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'ステータスは必須です。',
    });
  });

  test('ステータスが文字列でない場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'source-exapp-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), status: 123 };
    const event = createAPIGatewayProxyEvent(body, teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'ステータスの形式が不正です。',
    });
  });

  test('ステータスがdraft/published以外の場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'source-exapp-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), status: 'invalid' };
    const event = createAPIGatewayProxyEvent(body, teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'ステータスはdraftかpublishedのいずれかである必要があります。',
    });
  });

  test('チームが見つからない場合は400エラーを返す', async () => {
    const teamId = 'nonexistent-team-id';
    const exAppId = 'source-exapp-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);
    mockedFindTeamById.mockResolvedValue(null);

    const event = createAPIGatewayProxyEvent(createValidRequestBody(), teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'チームが見つかりませんでした。',
    });
  });

  test('コピー元のExAppが見つからない場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'nonexistent-exapp-id';
    const now = Date.now().toString();

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    mockedFindTeamById.mockResolvedValue({
      teamId,
      teamName: 'テストチーム',
      createdDate: now,
      updatedDate: now,
    });

    mockedFindExAppById.mockResolvedValue(null);

    const event = createAPIGatewayProxyEvent(createValidRequestBody(), teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'ExAppが見つかりませんでした。',
    });
  });

  test('APIキーの取得に失敗した場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'source-exapp-id';
    const now = Date.now().toString();

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    mockedFindTeamById.mockResolvedValue({
      teamId,
      teamName: 'テストチーム',
      createdDate: now,
      updatedDate: now,
    });

    mockedFindExAppById.mockResolvedValue({
      teamId,
      exAppId,
      exAppName: '元アプリ',
      description: '元アプリの概要',
      howToUse: '元アプリの使い方',
      endpoint: 'https://api.example.com/original',
      apiKey: '',
      placeholder: '{"input": "original"}',
      config: '{"model": "original"}',
      systemPrompt: '元プロンプト',
      systemPromptKeyName: 'system',
      copyable: true,
      status: 'published',
      createdDate: now,
      updatedDate: now,
    });

    mockedGetApiKeyValue.mockResolvedValue(undefined);

    const event = createAPIGatewayProxyEvent(createValidRequestBody(), teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'APIキーの取得に失敗しました。',
    });
  });

  test('予期しないエラーが発生した場合は500エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'source-exapp-id';
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);
    mockedFindTeamById.mockRejectedValue(new Error('Unexpected error'));

    const event = createAPIGatewayProxyEvent(createValidRequestBody(), teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body)).toEqual({
      error: 'サーバ側でエラーが発生しました。管理者へご連絡ください。',
    });
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  test('コピー元endpointがホワイトリスト外の場合は400を返し、APIキー取得・コピーを行わない', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'source-exapp-id';
    const now = Date.now().toString();
    process.env[EXAPP_INVOKABLE_HOSTNAMES_ENV] = JSON.stringify(['api.allowed.example']);

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);
    mockedFindTeamById.mockResolvedValue({
      teamId,
      teamName: 'テストチーム',
      createdDate: now,
      updatedDate: now,
    });
    mockedFindExAppById.mockResolvedValue({
      teamId,
      exAppId,
      exAppName: '元アプリ',
      description: '元アプリの概要',
      howToUse: '元アプリの使い方',
      endpoint: 'https://api.example.com/original',
      apiKey: '',
      placeholder: '{"input": "original"}',
      config: '{"model": "original"}',
      systemPrompt: '元プロンプト',
      systemPromptKeyName: 'system',
      copyable: true,
      status: 'published',
      createdDate: now,
      updatedDate: now,
    });

    const event = createAPIGatewayProxyEvent(createValidRequestBody(), teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: '許可されたエンドポイント以外のURLが指定されたか、URLの形式が不正です。',
    });
    expect(mockedGetApiKeyValue).not.toHaveBeenCalled();
    expect(mockedCreateExApp).not.toHaveBeenCalled();
    expect(mockedSetApiKey).not.toHaveBeenCalled();
  });

  test.each(['https://169.254.169.254/latest', 'http://api.example.com/original'])(
    "ホワイトリストが '*' でも、コピー元endpoint %s は400を返し、APIキー取得・コピーを行わない",
    async (endpoint) => {
      const teamId = 'test-team-id';
      const exAppId = 'source-exapp-id';
      const now = Date.now().toString();

      mockedIsSystemAdmin.mockReturnValue(true);
      mockedIsTeamAdmin.mockResolvedValue(false);
      mockedFindTeamById.mockResolvedValue({
        teamId,
        teamName: 'テストチーム',
        createdDate: now,
        updatedDate: now,
      });
      mockedFindExAppById.mockResolvedValue({
        teamId,
        exAppId,
        exAppName: '元アプリ',
        description: '元アプリの概要',
        howToUse: '元アプリの使い方',
        endpoint,
        apiKey: '',
        placeholder: '{"input": "original"}',
        config: '{"model": "original"}',
        systemPrompt: '元プロンプト',
        systemPromptKeyName: 'system',
        copyable: true,
        status: 'published',
        createdDate: now,
        updatedDate: now,
      });

      const event = createAPIGatewayProxyEvent(createValidRequestBody(), teamId, exAppId);

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      expect(mockedGetApiKeyValue).not.toHaveBeenCalled();
      expect(mockedCreateExApp).not.toHaveBeenCalled();
      expect(mockedSetApiKey).not.toHaveBeenCalled();
    },
  );

  test('コピー元endpointがホワイトリスト内なら正常にコピーできる', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'source-exapp-id';
    const now = Date.now().toString();
    process.env[EXAPP_INVOKABLE_HOSTNAMES_ENV] = JSON.stringify(['api.example.com']);

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);
    mockedFindTeamById.mockResolvedValue({
      teamId,
      teamName: 'テストチーム',
      createdDate: now,
      updatedDate: now,
    });
    mockedFindExAppById.mockResolvedValue({
      teamId,
      exAppId,
      exAppName: '元アプリ',
      description: '元アプリの概要',
      howToUse: '元アプリの使い方',
      endpoint: 'https://api.example.com/original',
      apiKey: '',
      placeholder: '{"input": "original"}',
      config: '{"model": "original"}',
      systemPrompt: '元プロンプト',
      systemPromptKeyName: 'system',
      copyable: true,
      status: 'published',
      createdDate: now,
      updatedDate: now,
    });
    mockedGetApiKeyValue.mockResolvedValue('original-api-key');
    mockedCreateExApp.mockResolvedValue({
      teamId,
      exAppId: 'copied-exapp-id',
      exAppName: 'コピーされたアプリ',
      description: 'コピーされたアプリの概要',
      howToUse: 'コピーされたアプリの使い方',
      endpoint: 'https://api.example.com/original',
      apiKey: '',
      placeholder: '{"input": "test"}',
      config: '{"model": "test"}',
      systemPrompt: 'テストプロンプト',
      systemPromptKeyName: 'system',
      copyable: true,
      status: 'draft',
      createdDate: now,
      updatedDate: now,
    });

    const event = createAPIGatewayProxyEvent(createValidRequestBody(), teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(mockedCreateExApp).toHaveBeenCalled();
  });
});
