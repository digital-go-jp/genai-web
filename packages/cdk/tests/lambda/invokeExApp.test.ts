import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSqsSend, mockCloudWatchSend, mockRequestValidatedExAppUrl, mockSendMessageCommand } =
  vi.hoisted(() => ({
    mockSqsSend: vi.fn(),
    mockCloudWatchSend: vi.fn(),
    mockRequestValidatedExAppUrl: vi.fn(),
    mockSendMessageCommand: vi.fn(function SendMessageCommandMock(this: unknown, input: unknown) {
      return input;
    }),
  }));


vi.mock('../../lambda/repository/exAppRepository', () => ({
  findExAppById: vi.fn(),
}));

vi.mock('../../lambda/repository/invokeHistoryRepository', () => ({
  createInvokeExAppHistory: vi.fn(),
  updateInvokeExAppHistoryTitle: vi.fn(),
}));

vi.mock('../../lambda/utils/predictExAppTitle', () => ({
  predictExAppTitle: vi.fn(),
}));

vi.mock('../../lambda/repository/teamRepository', () => ({
  findTeamById: vi.fn(),
}));

vi.mock('../../lambda/utils/teamRole', () => ({
  isSystemAdmin: vi.fn(),
  isTeamUser: vi.fn(),
}));

vi.mock('../../lambda/utils/apiKey', () => ({
  getApiKeyValue: vi.fn(),
}));

vi.mock('../../lambda/utils/userIdentifier', () => ({
  generateStableUserId: vi.fn(),
}));

vi.mock('../../lambda/utils/cognitoIdentity', () => ({
  resolveIdentityId: vi.fn(),
}));

vi.mock('../../lambda/utils/monitoring', () => ({
  classifyErrorType: vi.fn(),
  publishErrorMetrics: vi.fn(),
  publishSuccessMetrics: vi.fn(),
}));

vi.mock('../../lambda/utils/exAppUrlSecurity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lambda/utils/exAppUrlSecurity')>();
  return {
    ...actual,
    assertPublicEndpointUrl: vi.fn(),
    requestValidatedExAppUrl: mockRequestValidatedExAppUrl,
    resolveRelativeStatusUrl: vi.fn((statusUrl, endpoint) => ({
      ...endpoint,
      url: new URL(statusUrl, endpoint.url),
    })),
    toRelativeStatusUrl: vi.fn((url: URL) => `${url.pathname}${url.search}`),
  };
});

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    send = mockSqsSend;
  },
  SendMessageCommand: mockSendMessageCommand,
}));

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class {
    send = mockCloudWatchSend;
  },
}));

import { handler } from '../../lambda/invokeExApp';
import { findExAppById } from '../../lambda/repository/exAppRepository';
import {
  createInvokeExAppHistory,
  updateInvokeExAppHistoryTitle,
} from '../../lambda/repository/invokeHistoryRepository';
import { predictExAppTitle } from '../../lambda/utils/predictExAppTitle';
import { findTeamById } from '../../lambda/repository/teamRepository';
import { isSystemAdmin, isTeamUser } from '../../lambda/utils/teamRole';
import { getApiKeyValue } from '../../lambda/utils/apiKey';
import { generateStableUserId } from '../../lambda/utils/userIdentifier';
import { resolveIdentityId } from '../../lambda/utils/cognitoIdentity';
import {
  assertPublicEndpointUrl,
  requestValidatedExAppUrl,
  resolveRelativeStatusUrl,
  UnsafeExAppUrlError,
} from '../../lambda/utils/exAppUrlSecurity';
import {
  classifyErrorType,
  publishErrorMetrics,
  publishSuccessMetrics,
} from '../../lambda/utils/monitoring';

describe('invokeExApp Lambda handler', () => {
  const mockUserId = 'test-user-id';
  const mockTeamId = 'test-team-id';
  const mockExAppId = 'test-exapp-id';
  const mockCognitoId = 'test-cognito-id';
  const mockStableUserId = 'stable-user-id-123';
  const mockApiKey = 'test-api-key';
  const mockEndpoint = 'https://api.example.com/invoke';
  const mockIdToken = 'mock-id-token';
  const mockValidatedEndpoint = {
    url: new URL(mockEndpoint),
  };

  const mockTeam = {
    teamId: mockTeamId,
    teamName: 'Test Team',
    createdDate: '1234567890',
    updatedDate: '1234567890',
  };

  const mockExApp = {
    teamId: mockTeamId,
    exAppId: mockExAppId,
    exAppName: 'Test ExApp',
    endpoint: mockEndpoint,
    placeholder: '{}',
    description: 'Test description',
    howToUse: 'Test how to use',
    apiKey: '',
    config: '{}',
    systemPrompt: '',
    systemPromptKeyName: '',
    copyable: true,
    status: 'published' as const,
    createdDate: '1234567890',
    updatedDate: '1234567890',
  };

  const createEvent = (body?: object): APIGatewayProxyEvent =>
    ({
      body: body ? JSON.stringify(body) : null,
      headers: {
        Authorization: `Bearer ${mockIdToken}`,
      },
      requestContext: {
        requestId: 'test-request-id',
        authorizer: {
          claims: {
            sub: mockUserId,
            'cognito:groups': ['Users'],
          },
        },
      },
    }) as unknown as APIGatewayProxyEvent;

  const createValidBody = (overrides?: object) => ({
    teamId: mockTeamId,
    exAppId: mockExAppId,
    inputs: { prompt: 'test input' },
    ...overrides,
  });

  const createMockResponse = (
    status: number,
    body: unknown,
    options?: { jsonError?: Error; text?: string },
  ) => ({
    status,
    ok: status >= 200 && status < 300,
    json: vi.fn().mockImplementation(() => {
      if (options?.jsonError) {
        return Promise.reject(options.jsonError);
      }
      return Promise.resolve(body);
    }),
    text: vi
      .fn()
      .mockResolvedValue(options?.text ?? (typeof body === 'string' ? body : JSON.stringify(body))),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(generateStableUserId).mockResolvedValue(mockStableUserId);
    vi.mocked(resolveIdentityId).mockResolvedValue(mockCognitoId);
    vi.mocked(findTeamById).mockResolvedValue(mockTeam);
    vi.mocked(findExAppById).mockResolvedValue(mockExApp);
    vi.mocked(getApiKeyValue).mockResolvedValue(mockApiKey);
    vi.mocked(isSystemAdmin).mockReturnValue(false);
    vi.mocked(isTeamUser).mockResolvedValue(true);
    vi.mocked(createInvokeExAppHistory).mockResolvedValue({} as any);
    vi.mocked(predictExAppTitle).mockResolvedValue('テストタイトル');
    vi.mocked(updateInvokeExAppHistoryTitle).mockResolvedValue(undefined);
    mockSqsSend.mockResolvedValue({});
    vi.mocked(classifyErrorType).mockReturnValue('CLIENT_ERROR');
    vi.mocked(publishErrorMetrics).mockResolvedValue(undefined);
    vi.mocked(publishSuccessMetrics).mockResolvedValue(undefined);
    vi.mocked(assertPublicEndpointUrl).mockResolvedValue(mockValidatedEndpoint);
    vi.mocked(resolveRelativeStatusUrl).mockImplementation((statusUrl, endpoint) => ({
      ...endpoint,
      url: new URL(statusUrl, endpoint.url),
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('同期レスポンス（200）の場合、正常に結果を返す', async () => {
    const mockResponse = { outputs: 'AI response' };
    mockRequestValidatedExAppUrl.mockResolvedValue(createMockResponse(200, mockResponse));

    const event = createEvent(createValidBody());
    const result: APIGatewayProxyResult = await handler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body).toEqual(mockResponse);
    expect(generateStableUserId).toHaveBeenCalledWith(mockUserId);
    expect(findExAppById).toHaveBeenCalledWith(mockTeamId, mockExAppId);
    expect(assertPublicEndpointUrl).toHaveBeenCalledWith(mockEndpoint);
    expect(getApiKeyValue).toHaveBeenCalled();
    expect(requestValidatedExAppUrl).toHaveBeenCalledWith(
      mockValidatedEndpoint,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'x-api-key': mockApiKey,
          'x-user-id': mockStableUserId,
        }),
      }),
    );
    expect(publishSuccessMetrics).toHaveBeenCalled();
    expect(createInvokeExAppHistory).toHaveBeenCalled();
  });

  it('非同期レスポンス（202）の場合、SQSにメッセージを送信する', async () => {
    const mockResponse = { status_url: '/status/123' };
    mockRequestValidatedExAppUrl.mockResolvedValue(createMockResponse(202, mockResponse));

    const event = createEvent(createValidBody());
    const result: APIGatewayProxyResult = await handler(event);

    expect(result.statusCode).toBe(202);
    const body = JSON.parse(result.body);
    expect(body).toEqual(mockResponse);
    expect(resolveRelativeStatusUrl).toHaveBeenCalledWith('/status/123', mockValidatedEndpoint);
    expect(mockSqsSend).toHaveBeenCalledWith(
      expect.objectContaining({
        MessageBody: expect.stringContaining('"statusUrl":"/status/123"'),
      }),
    );
    expect(createInvokeExAppHistory).toHaveBeenCalled();
  });

  it('sessionIdが正しいUUID v4形式の場合、リクエストに含まれる', async () => {
    const validSessionId = '550e8400-e29b-41d4-a716-446655440000';
    const mockResponse = { outputs: 'AI response' };
    mockRequestValidatedExAppUrl.mockResolvedValue(createMockResponse(200, mockResponse));

    const event = createEvent(createValidBody({ sessionId: validSessionId }));
    const result: APIGatewayProxyResult = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(requestValidatedExAppUrl).toHaveBeenCalledWith(
      mockValidatedEndpoint,
      expect.objectContaining({
        body: expect.stringContaining(validSessionId),
      }),
    );
  });

  it('システム管理者の場合、チームメンバーでなくても実行できる', async () => {
    vi.mocked(isSystemAdmin).mockReturnValue(true);
    vi.mocked(isTeamUser).mockResolvedValue(false);

    const mockResponse = { outputs: 'AI response' };
    mockRequestValidatedExAppUrl.mockResolvedValue(createMockResponse(200, mockResponse));

    const event = createEvent(createValidBody());
    const result: APIGatewayProxyResult = await handler(event);

    expect(result.statusCode).toBe(200);
  });

  it('COMMON_TEAM_IDの場合、チームメンバーでなくても実行できる', async () => {
    const commonTeamId = '00000000-0000-0000-0000-000000000000';
    vi.mocked(isTeamUser).mockResolvedValue(false);

    const mockResponse = { outputs: 'AI response' };
    mockRequestValidatedExAppUrl.mockResolvedValue(createMockResponse(200, mockResponse));

    const commonTeam = { teamId: commonTeamId, teamName: 'Common Team', createdDate: '1234567890', updatedDate: '1234567890' };
    const commonExApp = { ...mockExApp, teamId: commonTeamId };
    vi.mocked(findTeamById).mockResolvedValue(commonTeam);
    vi.mocked(findExAppById).mockResolvedValue(commonExApp);

    const event = createEvent(createValidBody({ teamId: commonTeamId }));
    const result: APIGatewayProxyResult = await handler(event);

    expect(result.statusCode).toBe(200);
  });

  it('bodyがない場合は400エラーを返す', async () => {
    const event = createEvent();
    event.body = null;

    const result: APIGatewayProxyResult = await handler(event);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.outputs).toBe('Pathが不正か、bodyがありません');
  });

  it('teamIdがない場合は400エラーを返す', async () => {
    const event = createEvent({
      exAppId: mockExAppId,
      inputs: { prompt: 'test' },
    });

    const result: APIGatewayProxyResult = await handler(event);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.outputs).toBe('パラメータが不正です。');
  });

  it('exAppIdがない場合は400エラーを返す', async () => {
    const event = createEvent({
      teamId: mockTeamId,
      inputs: { prompt: 'test' },
    });

    const result: APIGatewayProxyResult = await handler(event);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.outputs).toBe('パラメータが不正です。');
  });

  it('inputsがない場合は400エラーを返す', async () => {
    const event = createEvent({
      teamId: mockTeamId,
      exAppId: mockExAppId,
    });

    const result: APIGatewayProxyResult = await handler(event);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.outputs).toBe('パラメータが不正です。');
  });

  it('sessionIdがUUID v4形式でない場合は400エラーを返す', async () => {
    const event = createEvent(createValidBody({ sessionId: 'invalid-session-id' }));

    const result: APIGatewayProxyResult = await handler(event);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.outputs).toBe('sessionIdはUUID v4形式である必要があります。');
  });

  it('sessionIdが空文字の場合はsessionIdなしとして正常に処理される', async () => {
    const mockResponse = { outputs: 'AI response' };
    mockRequestValidatedExAppUrl.mockResolvedValue(createMockResponse(200, mockResponse));

    const event = createEvent(createValidBody({ sessionId: '' }));

    const result: APIGatewayProxyResult = await handler(event);

    expect(result.statusCode).toBe(200);
  });

  it('チームメンバーでない場合は403エラーを返す', async () => {
    vi.mocked(isTeamUser).mockResolvedValue(false);

    const event = createEvent(createValidBody());

    const result: APIGatewayProxyResult = await handler(event);

    expect(result.statusCode).toBe(403);
    const body = JSON.parse(result.body);
    expect(body.outputs).toBe('チームメンバーではないため実行できません。権限を見直してください。');
  });

  it('ExAppが見つからない場合は404エラーを返す', async () => {
    vi.mocked(findExAppById)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(mockExApp);

    const event = createEvent(createValidBody());

    const result: APIGatewayProxyResult = await handler(event);

    expect(result.statusCode).toBe(404);
    const body = JSON.parse(result.body);
    expect(body.outputs).toBe('リクエストされたAIアプリが見つかりませんでした。');
  });

  it('APIキーが見つからない場合は404エラーを返す', async () => {
    vi.mocked(getApiKeyValue).mockResolvedValue(undefined);

    const event = createEvent(createValidBody());

    const result: APIGatewayProxyResult = await handler(event);

    expect(result.statusCode).toBe(404);
    const body = JSON.parse(result.body);
    expect(body.outputs).toBe('リクエストされたAIアプリが見つかりませんでした。');
  });

  it('保存済みendpointが安全でない場合はAPIキーを取得せず502エラーを返す', async () => {
    vi.mocked(assertPublicEndpointUrl).mockRejectedValue(
      new UnsafeExAppUrlError('APIエンドポイントには公開 IP アドレスを指定してください。'),
    );

    const event = createEvent(createValidBody());
    const result: APIGatewayProxyResult = await handler(event);

    expect(result.statusCode).toBe(502);
    const body = JSON.parse(result.body);
    expect(body.outputs).toBe(
      '許可されたエンドポイント以外のURLが指定されたか、URLの形式が不正なためAIアプリの実行はできません。',
    );
    expect(getApiKeyValue).not.toHaveBeenCalled();
    expect(requestValidatedExAppUrl).not.toHaveBeenCalled();
    const HISTORY_STATUS_ARG_INDEX = 10;
    expect(vi.mocked(createInvokeExAppHistory).mock.lastCall?.[HISTORY_STATUS_ARG_INDEX]).toBe('ERROR');
  });

  it('非同期レスポンスのstatus_urlが同一origin相対URLでない場合はSQS送信しない', async () => {
    vi.mocked(resolveRelativeStatusUrl).mockImplementation(() => {
      throw new UnsafeExAppUrlError('ステータスURLには同一オリジンの相対パスを指定してください。');
    });
    mockRequestValidatedExAppUrl.mockResolvedValue(
      createMockResponse(202, { status_url: 'https://evil.example/status/123' }),
    );

    const event = createEvent(createValidBody());
    const result: APIGatewayProxyResult = await handler(event);

    expect(result.statusCode).toBe(502);
    expect(mockSqsSend).not.toHaveBeenCalled();
    expect(JSON.parse(result.body).outputs).toBe(
      'AIアプリの応答（リダイレクトまたはステータスURL）が不正なため実行できません。',
    );
  });

  it('外部APIがリダイレクトを返した場合は、ホワイトリストの拒否と区別した文言で502エラーを返す', async () => {
    mockRequestValidatedExAppUrl.mockRejectedValue(
      new UnsafeExAppUrlError('AIアプリのリダイレクト応答は許可されていません。'),
    );

    const event = createEvent(createValidBody());
    const result: APIGatewayProxyResult = await handler(event);

    expect(result.statusCode).toBe(502);
    expect(JSON.parse(result.body).outputs).toBe(
      'AIアプリの応答（リダイレクトまたはステータスURL）が不正なため実行できません。',
    );
    const HISTORY_STATUS_ARG_INDEX = 10;
    expect(vi.mocked(createInvokeExAppHistory).mock.lastCall?.[HISTORY_STATUS_ARG_INDEX]).toBe('ERROR');
  });

  it('外部APIが4xxエラーを返した場合、エラーメトリクスを発行する', async () => {
    const mockErrorResponse = { error: 'Bad Request' };
    mockRequestValidatedExAppUrl.mockResolvedValue(createMockResponse(400, mockErrorResponse));

    const event = createEvent(createValidBody());
    const result: APIGatewayProxyResult = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(publishErrorMetrics).toHaveBeenCalled();
    expect(classifyErrorType).toHaveBeenCalledWith(400, mockErrorResponse);
  });

  it('外部APIが5xxエラーを返した場合、エラーメトリクスを発行する', async () => {
    const mockErrorResponse = { error: 'Internal Server Error' };
    mockRequestValidatedExAppUrl.mockResolvedValue(createMockResponse(500, mockErrorResponse));

    const event = createEvent(createValidBody());
    const result: APIGatewayProxyResult = await handler(event);

    expect(result.statusCode).toBe(500);
    expect(publishErrorMetrics).toHaveBeenCalled();
    expect(classifyErrorType).toHaveBeenCalledWith(500, mockErrorResponse);
  });

  it('外部APIのレスポンスがJSONでない場合、テキストとして処理する', async () => {
    mockRequestValidatedExAppUrl.mockResolvedValue(
      createMockResponse(200, undefined, {
        jsonError: new Error('Invalid JSON'),
        text: 'Plain text response',
      }),
    );

    const event = createEvent(createValidBody());
    const result: APIGatewayProxyResult = await handler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.outputs).toBe('Plain text response');
  });

  it('安定ユーザーID生成に失敗した場合は500エラーを返す', async () => {
    vi.mocked(generateStableUserId).mockRejectedValue(new Error('KMS error'));

    const event = createEvent(createValidBody());

    await expect(handler(event)).rejects.toThrow('ユーザーID生成に失敗しました');
  });

  it('予期しないエラーが発生した場合は500エラーを返す', async () => {
    vi.mocked(findExAppById)
      .mockRejectedValueOnce(new Error('Unexpected error'))
      .mockResolvedValue(mockExApp);

    const event = createEvent(createValidBody());

    const result: APIGatewayProxyResult = await handler(event);

    expect(result.statusCode).toBe(500);
    const body = JSON.parse(result.body);
    expect(body.outputs).toBe('サーバ側でエラーが発生しました。管理者へご連絡ください。');
  });

  it('COMPLETED時にタイトル予測が実行され結果が保存される', async () => {
    const mockResponse = { outputs: 'AI response' };
    mockRequestValidatedExAppUrl.mockResolvedValue(createMockResponse(200, mockResponse));

    const event = createEvent(createValidBody());
    await handler(event);

    expect(predictExAppTitle).toHaveBeenCalledWith({ prompt: 'test input' }, 'AI response');
    expect(updateInvokeExAppHistoryTitle).toHaveBeenCalled();
  });

  it('ERRORの場合、タイトル予測が実行されない', async () => {
    const mockErrorResponse = { error: 'Bad Request' };
    mockRequestValidatedExAppUrl.mockResolvedValue(createMockResponse(400, mockErrorResponse));

    const event = createEvent(createValidBody());
    await handler(event);

    expect(predictExAppTitle).not.toHaveBeenCalled();
  });

  it('非同期レスポンス（202）の場合、タイトル予測が実行されない', async () => {
    const mockResponse = { status_url: '/status/123' };
    mockRequestValidatedExAppUrl.mockResolvedValue(createMockResponse(202, mockResponse));

    const event = createEvent(createValidBody());
    await handler(event);

    expect(predictExAppTitle).not.toHaveBeenCalled();
  });

  it('タイトル予測が失敗しても正常レスポンスが返る', async () => {
    const mockResponse = { outputs: 'AI response' };
    mockRequestValidatedExAppUrl.mockResolvedValue(createMockResponse(200, mockResponse));

    vi.mocked(predictExAppTitle).mockRejectedValueOnce(new Error('Bedrock error'));

    const event = createEvent(createValidBody());
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.outputs).toBe('AI response');
  });

  it('エラー発生時もcreateInvokeExAppHistoryが呼ばれる', async () => {
    vi.mocked(findExAppById)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(mockExApp);

    const event = createEvent(createValidBody());
    await handler(event);

    expect(createInvokeExAppHistory).toHaveBeenCalled();
  });

  // 同期成功レスポンスに totalEstimatedCost を同梱する。
  describe('totalEstimatedCost 同梱', () => {
    it('外部アプリが usageMetadata を返した場合、totalEstimatedCost が同梱される', async () => {
      const mockResponse = {
        outputs: 'AI response',
        usageMetadata: [
          {
            estimatedCostInfo: { estimatedCost: 0.5, currency: 'USD' },
            modelVersion: 'gemini-2',
            requestCount: 1,
            tokens: { candidatesTokenCount: 50, promptTokenCount: 100, totalTokenCount: 150 },
          },
          {
            estimatedCostInfo: { estimatedCost: 0.25, currency: 'USD' },
            modelVersion: 'gemini-2',
            requestCount: 1,
            tokens: { candidatesTokenCount: 30, promptTokenCount: 80, totalTokenCount: 110 },
          },
        ],
      };
      mockRequestValidatedExAppUrl.mockResolvedValue(createMockResponse(200, mockResponse));

      const event = createEvent(createValidBody());
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.totalEstimatedCost).toEqual({
        totalCost: 0.75,
        currency: 'USD',
      });
      // 既存 usageMetadata は変わらず透過される（回帰なし）
      expect(body.usageMetadata).toEqual(mockResponse.usageMetadata);
    });

    it('usageMetadata 不在では totalEstimatedCost も付かない（後方互換）', async () => {
      const mockResponse = { outputs: 'AI response' };
      mockRequestValidatedExAppUrl.mockResolvedValue(createMockResponse(200, mockResponse));

      const event = createEvent(createValidBody());
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.totalEstimatedCost).toBeUndefined();
    });

    it('currency 混在エントリでは totalEstimatedCost は undefined', async () => {
      const mockResponse = {
        outputs: 'AI response',
        usageMetadata: [
          {
            estimatedCostInfo: { estimatedCost: 0.5, currency: 'USD' },
            modelVersion: 'm',
            requestCount: 1,
            tokens: { candidatesTokenCount: 0, promptTokenCount: 0, totalTokenCount: 0 },
          },
          {
            estimatedCostInfo: { estimatedCost: 100, currency: 'JPY' },
            modelVersion: 'm',
            requestCount: 1,
            tokens: { candidatesTokenCount: 0, promptTokenCount: 0, totalTokenCount: 0 },
          },
        ],
      };
      mockRequestValidatedExAppUrl.mockResolvedValue(createMockResponse(200, mockResponse));

      const event = createEvent(createValidBody());
      const result = await handler(event);

      const body = JSON.parse(result.body);
      expect(body.totalEstimatedCost).toBeUndefined();
    });

    it('202（async）パスでは totalEstimatedCost は付与されない', async () => {
      const mockResponse = {
        status_url: '/status/123',
        usageMetadata: [
          {
            estimatedCostInfo: { estimatedCost: 0.5, currency: 'USD' },
            modelVersion: 'm',
            requestCount: 1,
            tokens: { candidatesTokenCount: 0, promptTokenCount: 0, totalTokenCount: 0 },
          },
        ],
      };
      mockRequestValidatedExAppUrl.mockResolvedValue(createMockResponse(202, mockResponse));

      const event = createEvent(createValidBody());
      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      const body = JSON.parse(result.body);
      expect(body.totalEstimatedCost).toBeUndefined();
    });
  });
});
