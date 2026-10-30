import { APIGatewayProxyEvent } from 'aws-lambda';
import { afterAll, beforeEach, describe, expect, type MockedFunction, test, vi } from 'vitest';
import { handler } from '../../lambda/updateExApp';
import { findExAppById, updateExApp } from '../../lambda/repository/exAppRepository';
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

const mockedFindExAppById = findExAppById as MockedFunction<typeof findExAppById>;
const mockedUpdateExApp = updateExApp as MockedFunction<typeof updateExApp>;
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
    exAppName: '更新後のアプリ',
    description: '更新後のアプリの概要',
    howToUse: '更新後のアプリの使い方',
    endpoint: 'https://api.example.com/updated',
    placeholder: '{"input": "updated"}',
    config: '{"model": "updated"}',
    systemPrompt: '更新後のプロンプト',
    systemPromptKeyName: 'system',
    copyable: false,
    status: 'published',
  };
}

function createExistingExApp(endpoint = 'https://api.example.com/updated') {
  const now = Date.now().toString();
  return {
    teamId: 'test-team-id',
    exAppId: 'target-exapp-id',
    exAppName: '更新前のアプリ',
    description: '更新前のアプリの概要',
    howToUse: '更新前のアプリの使い方',
    endpoint,
    apiKey: '',
    placeholder: '{"input": "current"}',
    config: '{"model": "current"}',
    systemPrompt: '更新前のプロンプト',
    systemPromptKeyName: 'system',
    copyable: false,
    status: 'published' as const,
    createdDate: now,
    updatedDate: now,
  };
}

function createUpdatedExApp(endpoint = 'https://api.example.com/updated') {
  const now = Date.now().toString();
  return {
    teamId: 'test-team-id',
    exAppId: 'target-exapp-id',
    exAppName: '更新後のアプリ',
    description: '更新後のアプリの概要',
    howToUse: '更新後のアプリの使い方',
    endpoint,
    apiKey: '',
    placeholder: '{"input": "updated"}',
    config: '{"model": "updated"}',
    systemPrompt: '更新後のプロンプト',
    systemPromptKeyName: 'system',
    copyable: false,
    status: 'published' as const,
    createdDate: now,
    updatedDate: now,
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

describe('updateExApp Lambda handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedAssertPublicEndpointUrl.mockResolvedValue({
      url: new URL('https://api.example.com/updated'),
    });
    mockedFindExAppById.mockResolvedValue(createExistingExApp());
  });

  test('システム管理者がExAppを正常に更新できる', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'target-exapp-id';
    const now = Date.now().toString();

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    mockedUpdateExApp.mockResolvedValue({
      teamId,
      exAppId,
      exAppName: '更新後のアプリ',
      description: '更新後のアプリの概要',
      howToUse: '更新後のアプリの使い方',
      endpoint: 'https://api.example.com/updated',
      apiKey: '',
      placeholder: '{"input": "updated"}',
      config: '{"model": "updated"}',
      systemPrompt: '更新後のプロンプト',
      systemPromptKeyName: 'system',
      copyable: false,
      status: 'published',
      createdDate: now,
      updatedDate: now,
    });

    const event = createAPIGatewayProxyEvent(createValidRequestBody(), teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(mockedAssertPublicEndpointUrl).toHaveBeenCalledWith('https://api.example.com/updated');
    expect(mockedFindExAppById).toHaveBeenCalledWith(teamId, exAppId);
    expect(mockedUpdateExApp).toHaveBeenCalled();
    expect(mockedSetApiKey).not.toHaveBeenCalled();

    const body = JSON.parse(result.body);
    expect(body.exAppId).toBe(exAppId);
    expect(body.exAppName).toBe('更新後のアプリ');
    expect(body.status).toBe('published');
  });

  test('チーム管理者がExAppを正常に更新できる', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'target-exapp-id';
    const now = Date.now().toString();

    mockedIsSystemAdmin.mockReturnValue(false);
    mockedIsTeamAdmin.mockResolvedValue(true);

    mockedUpdateExApp.mockResolvedValue({
      teamId,
      exAppId,
      exAppName: '更新後のアプリ',
      description: '更新後のアプリの概要',
      howToUse: '更新後のアプリの使い方',
      endpoint: 'https://api.example.com/updated',
      apiKey: '',
      placeholder: '{"input": "updated"}',
      config: '{"model": "updated"}',
      systemPrompt: '更新後のプロンプト',
      systemPromptKeyName: 'system',
      copyable: false,
      status: 'published',
      createdDate: now,
      updatedDate: now,
    });

    const event = createAPIGatewayProxyEvent(createValidRequestBody(), teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
  });

  test('APIキーが指定された場合は更新される', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'target-exapp-id';
    const now = Date.now().toString();

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    mockedUpdateExApp.mockResolvedValue({
      teamId,
      exAppId,
      exAppName: '更新後のアプリ',
      description: '更新後のアプリの概要',
      howToUse: '更新後のアプリの使い方',
      endpoint: 'https://api.example.com/updated',
      apiKey: '',
      placeholder: '{"input": "updated"}',
      config: '{"model": "updated"}',
      systemPrompt: '更新後のプロンプト',
      systemPromptKeyName: 'system',
      copyable: false,
      status: 'published',
      createdDate: now,
      updatedDate: now,
    });

    mockedSetApiKey.mockResolvedValue(undefined);

    const bodyWithApiKey = { ...createValidRequestBody(), apiKey: 'new-api-key' };
    const event = createAPIGatewayProxyEvent(bodyWithApiKey, teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(mockedSetApiKey).toHaveBeenCalledWith(teamId, exAppId, 'new-api-key', expect.any(String));
  });

  test('APIエンドポイントのURLシリアライズ結果だけが異なる場合は変更扱いにしない', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'target-exapp-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);
    mockedFindExAppById.mockResolvedValue(createExistingExApp('https://api.example.com'));
    mockedAssertPublicEndpointUrl.mockResolvedValue({
      url: new URL('https://api.example.com'),
    });
    mockedUpdateExApp.mockResolvedValue(createUpdatedExApp('https://api.example.com'));

    const event = createAPIGatewayProxyEvent(
      { ...createValidRequestBody(), endpoint: 'https://api.example.com' },
      teamId,
      exAppId,
    );

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(mockedUpdateExApp).toHaveBeenCalled();
    expect(mockedSetApiKey).not.toHaveBeenCalled();
  });

  test('APIエンドポイント変更時にAPIキーが未指定の場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'target-exapp-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);
    mockedFindExAppById.mockResolvedValue(createExistingExApp('https://api.example.com/current'));

    const event = createAPIGatewayProxyEvent(createValidRequestBody(), teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'APIエンドポイントを変更する場合はAPIキーを再入力してください。',
    });
    expect(mockedUpdateExApp).not.toHaveBeenCalled();
    expect(mockedSetApiKey).not.toHaveBeenCalled();
  });

  test('APIエンドポイント変更時にAPIキーが指定された場合は更新できる', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'target-exapp-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);
    mockedFindExAppById.mockResolvedValue(createExistingExApp('https://api.example.com/current'));
    mockedUpdateExApp.mockResolvedValue(createUpdatedExApp());
    mockedSetApiKey.mockResolvedValue(undefined);

    const event = createAPIGatewayProxyEvent(
      { ...createValidRequestBody(), apiKey: 'new-api-key' },
      teamId,
      exAppId,
    );

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(mockedUpdateExApp).toHaveBeenCalled();
    expect(mockedSetApiKey).toHaveBeenCalledWith(teamId, exAppId, 'new-api-key', expect.any(String));
  });

  test('対象のExAppが存在しない場合は404エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'target-exapp-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);
    mockedFindExAppById.mockResolvedValue(null);

    const event = createAPIGatewayProxyEvent(createValidRequestBody(), teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body)).toEqual({
      error: 'AIアプリが見つかりません。',
    });
    expect(mockedUpdateExApp).not.toHaveBeenCalled();
    expect(mockedSetApiKey).not.toHaveBeenCalled();
  });

  test('管理者でない場合は403エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'target-exapp-id';

    mockedIsSystemAdmin.mockReturnValue(false);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const event = createAPIGatewayProxyEvent(createValidRequestBody(), teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body)).toEqual({
      error: '管理者ではないため利用できません。',
    });
    expect(mockedUpdateExApp).not.toHaveBeenCalled();
  });

  test('アプリ名が空の場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'target-exapp-id';

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

  test('APIエンドポイントの形式が不正な場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'target-exapp-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), endpoint: 'invalid-url' };
    const event = createAPIGatewayProxyEvent(body, teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'APIエンドポイントの形式が不正です。',
    });
  });

  test('APIエンドポイントが公開HTTPS URLでない場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'target-exapp-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);
    mockedAssertPublicEndpointUrl.mockRejectedValue(
      new UnsafeExAppUrlError('APIエンドポイントには公開 IP アドレスを指定してください。'),
    );

    const body = { ...createValidRequestBody(), endpoint: 'https://127.0.0.1/updated' };
    const event = createAPIGatewayProxyEvent(body, teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: '許可されたエンドポイント以外のURLが指定されたか、URLの形式が不正です。',
    });
    expect(mockedUpdateExApp).not.toHaveBeenCalled();
    expect(mockedSetApiKey).not.toHaveBeenCalled();
  });

  test('ステータスがdraft/published以外の場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'target-exapp-id';

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

  test('APIキーが空文字の場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'target-exapp-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), apiKey: '   ' };
    const event = createAPIGatewayProxyEvent(body, teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'APIキーの形式が不正です。',
    });
  });

  test('アプリ名が文字列でない場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'target-exapp-id';

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
    const exAppId = 'target-exapp-id';

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
    const exAppId = 'target-exapp-id';

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
    const exAppId = 'target-exapp-id';

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
    const exAppId = 'target-exapp-id';

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

  test('APIエンドポイントが文字列でない場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'target-exapp-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), endpoint: 123 };
    const event = createAPIGatewayProxyEvent(body, teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'APIエンドポイントの形式が不正です。',
    });
  });

  test('placeholderが空の場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'target-exapp-id';

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
    const exAppId = 'target-exapp-id';

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
    const exAppId = 'target-exapp-id';

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
    const exAppId = 'target-exapp-id';

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
    const exAppId = 'target-exapp-id';

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
    const exAppId = 'target-exapp-id';

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
    const exAppId = 'target-exapp-id';

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
    const exAppId = 'target-exapp-id';

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
    const exAppId = 'target-exapp-id';

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
    const exAppId = 'target-exapp-id';

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

  test('APIキーが文字列でない場合は400エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'target-exapp-id';

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);

    const body = { ...createValidRequestBody(), apiKey: 123 };
    const event = createAPIGatewayProxyEvent(body, teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'APIキーの形式が不正です。',
    });
  });

  test('予期しないエラーが発生した場合は500エラーを返す', async () => {
    const teamId = 'test-team-id';
    const exAppId = 'target-exapp-id';
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockedIsSystemAdmin.mockReturnValue(true);
    mockedIsTeamAdmin.mockResolvedValue(false);
    mockedUpdateExApp.mockRejectedValue(new Error('Unexpected error'));

    const event = createAPIGatewayProxyEvent(createValidRequestBody(), teamId, exAppId);

    const result = await handler(event);

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body)).toEqual({
      error: 'サーバ側でエラーが発生しました。管理者へご連絡ください。',
    });
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});
