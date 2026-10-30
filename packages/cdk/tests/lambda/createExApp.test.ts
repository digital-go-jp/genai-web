import { APIGatewayProxyEvent } from 'aws-lambda';
import { afterAll, beforeEach, describe, expect, type MockedFunction, test, vi } from 'vitest';
import { handler } from '../../lambda/createExApp';
import { createExApp } from '../../lambda/repository/exAppRepository';
import * as teamRole from '../../lambda/utils/teamRole';
import * as apiKey from '../../lambda/utils/apiKey';
import {
  assertPublicEndpointUrl,
  UnsafeExAppUrlError,
} from '../../lambda/utils/exAppUrlSecurity';

vi.mock('../../lambda/repository/exAppRepository');
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
    setApiKey: vi.fn(),
  };
});
vi.mock('../../lambda/utils/exAppUrlSecurity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lambda/utils/exAppUrlSecurity')>();
  return {
    ...actual,
    assertPublicEndpointUrl: vi.fn(),
  };
});

const mockedCreateExApp = createExApp as MockedFunction<typeof createExApp>;
const mockedIsSystemAdmin = teamRole.isSystemAdmin as MockedFunction<
  typeof teamRole.isSystemAdmin
>;
const mockedIsTeamAdmin = teamRole.isTeamAdmin as MockedFunction<
  typeof teamRole.isTeamAdmin
>;
const mockedSetApiKey = apiKey.setApiKey as MockedFunction<
  typeof apiKey.setApiKey
>;
const mockedAssertPublicEndpointUrl = assertPublicEndpointUrl as MockedFunction<
  typeof assertPublicEndpointUrl
>;

const originalEnv = process.env;
beforeEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv };
  process.env.APP_ENV = 'test';
});

afterAll(() => {
  process.env = originalEnv;
});

function createValidRequestBody() {
  return {
    exAppName: 'テストアプリ',
    description: 'テストアプリの概要',
    howToUse: 'テストアプリの使い方',
    endpoint: 'https://api.example.com/test',
    apiKey: 'test-api-key',
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
): APIGatewayProxyEvent {
  return {
    body: body ? JSON.stringify(body) : null,
    pathParameters: teamId ? { teamId } : {},
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

describe('createExApp Lambda handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedAssertPublicEndpointUrl.mockResolvedValue({
      url: new URL('https://api.example.com/test'),
    });
  });

  test('システム管理者がExAppを正常に作成できる', async () => {
    const teamId = 'test-team-id';
    const now = Date.now().toString();

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    mockedCreateExApp.mockResolvedValue({
      teamId,
      exAppId: 'new-exapp-id',
      exAppName: 'テストアプリ',
      description: 'テストアプリの概要',
      howToUse: 'テストアプリの使い方',
      endpoint: 'https://api.example.com/test',
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

    const event = createAPIGatewayProxyEvent(createValidRequestBody(), teamId);

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(mockedAssertPublicEndpointUrl).toHaveBeenCalledWith('https://api.example.com/test');
    expect(mockedCreateExApp).toHaveBeenCalled();
    expect(mockedSetApiKey).toHaveBeenCalledWith(teamId, 'new-exapp-id', 'test-api-key', expect.any(String));

    const body = JSON.parse(result.body);
    expect(body.exAppId).toBe('new-exapp-id');
    expect(body.exAppName).toBe('テストアプリ');
    expect(body.apiKey).toBe('');
  });

  test('チーム管理者がExAppを正常に作成できる', async () => {
    const teamId = 'test-team-id';
    const now = Date.now().toString();

    mockedIsSystemAdmin.mockReturnValue(false);
    mockedIsTeamAdmin.mockResolvedValue(true);

    mockedCreateExApp.mockResolvedValue({
      teamId,
      exAppId: 'new-exapp-id',
      exAppName: 'テストアプリ',
      description: 'テストアプリの概要',
      howToUse: 'テストアプリの使い方',
      endpoint: 'https://api.example.com/test',
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

    const event = createAPIGatewayProxyEvent(createValidRequestBody(), teamId);

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
  });

  test('管理者でない場合は403エラーを返す', async () => {
    const teamId = 'test-team-id';

    mockedIsSystemAdmin.mockReturnValue(false);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const event = createAPIGatewayProxyEvent(createValidRequestBody(), teamId);

    const result = await handler(event);

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body)).toEqual({
      error: '管理者ではないため利用できません。',
    });
    expect(mockedCreateExApp).not.toHaveBeenCalled();
  });

  test('アプリ名が空の場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), exAppName: '' };
    const event = createAPIGatewayProxyEvent(body, teamId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'アプリ名は必須です。',
    });
  });

  test('APIエンドポイントの形式が不正な場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), endpoint: 'invalid-url' };
    const event = createAPIGatewayProxyEvent(body, teamId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'APIエンドポイントの形式が不正です。',
    });
  });

  test('APIエンドポイントが公開HTTPS URLでない場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);
    mockedAssertPublicEndpointUrl.mockRejectedValue(
      new UnsafeExAppUrlError('APIエンドポイントには公開 IP アドレスを指定してください。'),
    );

    const body = { ...createValidRequestBody(), endpoint: 'https://127.0.0.1/test' };
    const event = createAPIGatewayProxyEvent(body, teamId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: '許可されたエンドポイント以外のURLが指定されたか、URLの形式が不正です。',
    });
    expect(mockedCreateExApp).not.toHaveBeenCalled();
    expect(mockedSetApiKey).not.toHaveBeenCalled();
  });

  test('placeholderのJSON形式が不正な場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), placeholder: 'invalid-json' };
    const event = createAPIGatewayProxyEvent(body, teamId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'APIリクエストのJSON形式が不正です。',
    });
  });

  test('ステータスがdraft/published以外の場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), status: 'invalid' };
    const event = createAPIGatewayProxyEvent(body, teamId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'ステータスはdraftかpublishedのいずれかである必要があります。',
    });
  });

  test('アプリ名が文字列でない場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), exAppName: 123 };
    const event = createAPIGatewayProxyEvent(body, teamId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'アプリ名の形式が不正です。',
    });
  });

  test('概要が空の場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), description: '' };
    const event = createAPIGatewayProxyEvent(body, teamId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: '概要は必須です。',
    });
  });

  test('概要が文字列でない場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), description: 123 };
    const event = createAPIGatewayProxyEvent(body, teamId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: '概要の形式が不正です。',
    });
  });

  test('使い方が空の場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), howToUse: '' };
    const event = createAPIGatewayProxyEvent(body, teamId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: '使い方は必須です。',
    });
  });

  test('使い方が文字列でない場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), howToUse: 123 };
    const event = createAPIGatewayProxyEvent(body, teamId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: '使い方の形式が不正です。',
    });
  });

  test('APIエンドポイントが文字列でない場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), endpoint: 123 };
    const event = createAPIGatewayProxyEvent(body, teamId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'APIエンドポイントの形式が不正です。',
    });
  });

  test('APIキーが空の場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), apiKey: '' };
    const event = createAPIGatewayProxyEvent(body, teamId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'APIキーは必須です。',
    });
  });

  test('APIキーが文字列でない場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), apiKey: 123 };
    const event = createAPIGatewayProxyEvent(body, teamId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'APIキーの形式が不正です。',
    });
  });

  test('placeholderが空の場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), placeholder: '' };
    const event = createAPIGatewayProxyEvent(body, teamId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'APIリクエストは必須です。',
    });
  });

  test('placeholderが文字列でない場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), placeholder: 123 };
    const event = createAPIGatewayProxyEvent(body, teamId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'APIリクエストの形式が不正です。',
    });
  });

  test('configのJSON形式が不正な場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), config: 'invalid-json' };
    const event = createAPIGatewayProxyEvent(body, teamId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'コンフィグのJSON形式が不正です。',
    });
  });

  test('configが文字列でない場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), config: 123 };
    const event = createAPIGatewayProxyEvent(body, teamId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'コンフィグの形式が不正です。',
    });
  });

  test('systemPromptが文字列でない場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), systemPrompt: 123 };
    const event = createAPIGatewayProxyEvent(body, teamId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'システムプロンプトの形式が不正です。',
    });
  });

  test('systemPromptKeyNameが文字列でない場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), systemPromptKeyName: 123 };
    const event = createAPIGatewayProxyEvent(body, teamId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'システムプロンプトキー名の形式が不正です。',
    });
  });

  test('copyableがブール値でない場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), copyable: 'true' };
    const event = createAPIGatewayProxyEvent(body, teamId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'コピー可能フラグの形式が不正です。',
    });
  });

  test('ステータスが空の場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), status: '' };
    const event = createAPIGatewayProxyEvent(body, teamId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'ステータスは必須です。',
    });
  });

  test('ステータスが文字列でない場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), status: 123 };
    const event = createAPIGatewayProxyEvent(body, teamId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'ステータスの形式が不正です。',
    });
  });

  test('予期しないエラーが発生した場合は500エラーを返す', async () => {
    const teamId = 'test-team-id';
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);
    mockedCreateExApp.mockRejectedValue(new Error('Unexpected error'));

    const event = createAPIGatewayProxyEvent(createValidRequestBody(), teamId);

    const result = await handler(event);

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body)).toEqual({
      error: 'サーバ側でエラーが発生しました。管理者へご連絡ください。',
    });
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});
