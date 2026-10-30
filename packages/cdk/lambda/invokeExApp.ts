import { Logger } from '@aws-lambda-powertools/logger';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { UsageMetadata } from 'genai-web';
import { findExAppById } from './repository/exAppRepository';
import {
  createInvokeExAppHistory,
  updateInvokeExAppHistoryTitle,
} from './repository/invokeHistoryRepository';
import { findTeamById } from './repository/teamRepository';
import { getApiKeyValue } from './utils/apiKey';
import { resolveIdentityId } from './utils/cognitoIdentity';
import { COMMON_TEAM_ID } from './utils/constants';
import { summarizeFromUsageMetadata } from './utils/estimatedCostSummary';
import {
  assertPublicEndpointUrl,
  isExAppUrlValidationError,
  requestValidatedExAppUrl,
  resolveRelativeStatusUrl,
  toRelativeStatusUrl,
} from './utils/exAppUrlSecurity';
import { createResponse } from './utils/http';
import { HttpError } from './utils/httpError';
import { classifyErrorType, publishErrorMetrics, publishSuccessMetrics } from './utils/monitoring';
import { predictExAppTitle } from './utils/predictExAppTitle';
import { isSystemAdmin, isTeamUser } from './utils/teamRole';
import { truncate } from './utils/truncate';
import { generateStableUserId } from './utils/userIdentifier';

const logger = new Logger();
const sqsClient = new SQSClient({});
const POLLING_QUEUE_URL = process.env.POLLING_QUEUE_URL!;
const cloudWatchClient = new CloudWatchClient({});
const APP_ENV = process.env.APP_ENV || '';

// UUID v4形式のバリデーション用正規表現
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const getStatusUrlFromResponse = (body: unknown): string | undefined => {
  if (typeof body !== 'object' || body === null || !('status_url' in body)) {
    return undefined;
  }
  const statusUrl = (body as { status_url?: unknown }).status_url;
  return typeof statusUrl === 'string' ? statusUrl : undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getErrorMessageFromResponse = (body: unknown): string => {
  if (!isRecord(body)) {
    return 'Unknown error';
  }
  const error = body.error ?? body.message;
  return typeof error === 'string' ? error : 'Unknown error';
};

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const userId: string = event.requestContext.authorizer!.claims['sub'];

  // Cognito subから安定IDを生成
  let stableUserId: string;
  try {
    stableUserId = await generateStableUserId(userId);
  } catch (error) {
    logger.error('Failed to generate stable user ID', error as Error);
    throw new HttpError(500, 'ユーザーID生成に失敗しました');
  }

  let teamId: string = '';
  let exAppId: string = '';
  let inputs: Record<string, unknown> = {};
  let responseBody: unknown = {};
  let status: 'ACCEPTED' | 'COMPLETED' | 'ERROR' = 'COMPLETED';
  const createdDate = `${Date.now()}`;
  let dbId = '';
  let baseS3Prefix = '';
  let sessionId: string | undefined;
  let endpointAccepted = false;
  const requestStartTime = Date.now();

  try {
    if (!event.body) {
      throw new HttpError(400, 'Pathが不正か、bodyがありません');
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(event.body);
    } catch {
      throw new HttpError(400, 'リクエストボディのJSON形式が不正です。');
    }
    if (!isRecord(parsedJson)) {
      throw new HttpError(400, 'パラメータが不正です。');
    }
    const parsedBody = parsedJson;
    teamId = typeof parsedBody.teamId === 'string' ? parsedBody.teamId : '';
    exAppId = typeof parsedBody.exAppId === 'string' ? parsedBody.exAppId : '';
    const parsedInputs = parsedBody.inputs;
    dbId = `${teamId}#${exAppId}#${userId}`;

    const authHeader = event.headers?.Authorization ?? event.headers?.authorization;
    const idToken = authHeader?.replace(/^Bearer\s+/i, '');
    if (!idToken) {
      throw new HttpError(401, 'Authorization header is required');
    }
    const cognitoId = await resolveIdentityId(idToken);
    baseS3Prefix = `${cognitoId}/${teamId}/${exAppId}/${createdDate}`;

    // sessionIdのバリデーション
    if (parsedBody.sessionId) {
      if (typeof parsedBody.sessionId === 'string' && UUID_V4_REGEX.test(parsedBody.sessionId)) {
        sessionId = parsedBody.sessionId;
      } else {
        logger.warn('Invalid sessionId format provided', { sessionId: parsedBody.sessionId });
        throw new HttpError(400, 'sessionIdはUUID v4形式である必要があります。');
      }
    }

    if (!teamId || !exAppId || !isRecord(parsedInputs)) {
      throw new HttpError(400, 'パラメータが不正です。');
    }
    inputs = parsedInputs;

    const isTeamUserResult = await isTeamUser(event, teamId);
    const isCommonOrTeamUser = teamId === COMMON_TEAM_ID || isTeamUserResult;
    if (!isSystemAdmin(event) && !isCommonOrTeamUser) {
      throw new HttpError(
        403,
        'チームメンバーではないため実行できません。権限を見直してください。',
      );
    }

    const res = await findExAppById(teamId, exAppId);
    if (!res) {
      throw new HttpError(404, 'リクエストされたAIアプリが見つかりませんでした。');
    }

    const validatedEndpoint = await assertPublicEndpointUrl(res.endpoint);
    endpointAccepted = true;

    const apiKeyValue = await getApiKeyValue(teamId, exAppId, APP_ENV);
    if (!apiKeyValue) {
      throw new HttpError(404, 'リクエストされたAIアプリが見つかりませんでした。');
    }

    const requestBody: { inputs: Record<string, unknown>; sessionId?: string } = { inputs };
    if (sessionId) {
      requestBody.sessionId = sessionId;
    }
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKeyValue,
        'x-user-id': stableUserId,
      },
      body: JSON.stringify(requestBody),
    };

    const response = await requestValidatedExAppUrl(validatedEndpoint, options);

    try {
      responseBody = await response.json();
    } catch (e) {
      const textOutput = await response.text();
      logger.warn('Response was not valid JSON. Treating as plain text output.', {
        error: e,
        text: truncate(textOutput),
      });
      responseBody = {
        outputs: textOutput,
      };
    }

    const statusUrl = getStatusUrlFromResponse(responseBody);
    if (response.status === 202 && statusUrl) {
      status = 'ACCEPTED';
      const validatedStatusUrl = resolveRelativeStatusUrl(statusUrl, validatedEndpoint);
      const relativeStatusUrl = toRelativeStatusUrl(validatedStatusUrl.url);

      const sqsMessage = {
        dbId,
        createdDate,
        teamId,
        exAppId,
        userId,
        stableUserId,
        statusUrl: relativeStatusUrl,
        endpoint: validatedEndpoint.url.toString(),
        apiKeySecretId: `${teamId}/${exAppId}`,
        baseS3Prefix, // PrefixをSQSメッセージに追加
      };

      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: POLLING_QUEUE_URL,
          MessageBody: JSON.stringify(sqsMessage),
        }),
      );

      const asyncResponseBody = isRecord(responseBody) ? responseBody : {};
      return createResponse(
        202,
        JSON.stringify({ ...asyncResponseBody, status_url: relativeStatusUrl }),
      );
    } else {
      const requestEndTime = Date.now();
      const responseTime = requestEndTime - requestStartTime;
      if (response.status >= 400) {
        status = 'ERROR';
        const errorType = classifyErrorType(response.status, responseBody);
        await publishErrorMetrics(cloudWatchClient, {
          exAppId,
          teamId,
          statusCode: response.status,
          endpoint: res.endpoint,
          responseTime,
          errorType,
          userId,
          envName: APP_ENV,
        });

        logger.error('ExApp invocation failed', {
          exAppId,
          teamId,
          statusCode: response.status,
          endpoint: res.endpoint,
          errorType,
          responseTime,
          errorMessage: getErrorMessageFromResponse(responseBody),
          userId,
          requestId: event.requestContext.requestId,
        });
      } else {
        await publishSuccessMetrics(cloudWatchClient, {
          exAppId,
          teamId,
          responseTime,
          endpoint: res.endpoint,
          statusCode: response.status,
          envName: APP_ENV,
        });
      }

      // 外部アプリ応答（信頼境界外）の usageMetadata は最小ガードしてから合算ヘルパに渡す。
      // 計算失敗・currency 混在・usageMetadata 不在では undefined（フェイルセーフ）。
      if (response.status < 400 && isRecord(responseBody)) {
        try {
          const rawUsageMetadata = (responseBody as { usageMetadata?: unknown }).usageMetadata;
          if (Array.isArray(rawUsageMetadata)) {
            const totalEstimatedCost = summarizeFromUsageMetadata(
              rawUsageMetadata as UsageMetadata[],
            );
            if (totalEstimatedCost !== undefined) {
              (responseBody as { totalEstimatedCost?: unknown }).totalEstimatedCost =
                totalEstimatedCost;
            }
          }
        } catch (e) {
          logger.warn('Failed to summarize totalEstimatedCost for sync invoke response', {
            error: e,
          });
        }
      }

      return createResponse(response.status, JSON.stringify(responseBody));
    }
  } catch (error) {
    logger.error('Error in invokeExApp', error as Error);
    status = 'ERROR';
    if (error instanceof HttpError) {
      responseBody = { outputs: error.message };
      return createResponse(error.statusCode, JSON.stringify(responseBody));
    } else if (isExAppUrlValidationError(error)) {
      responseBody = {
        outputs: endpointAccepted
          ? 'AIアプリの応答（リダイレクトまたはステータスURL）が不正なため実行できません。'
          : '許可されたエンドポイント以外のURLが指定されたか、URLの形式が不正なためAIアプリの実行はできません。',
      };
      return createResponse(502, JSON.stringify(responseBody));
    } else {
      responseBody = { outputs: 'サーバ側でエラーが発生しました。管理者へご連絡ください。' };
      return createResponse(500, JSON.stringify(responseBody));
    }
  } finally {
    await createInvokeExAppHistory(
      dbId,
      createdDate,
      teamId,
      exAppId,
      userId,
      baseS3Prefix,
      inputs,
      responseBody,
      (await findTeamById(teamId))!.teamName,
      (await findExAppById(teamId, exAppId))!.exAppName,
      status,
      sessionId,
    );

    if (status === 'COMPLETED') {
      try {
        const outputsStr =
          typeof responseBody.outputs === 'string'
            ? responseBody.outputs
            : JSON.stringify(responseBody.outputs || {});
        const title = await predictExAppTitle(inputs, outputsStr);
        if (title) {
          await updateInvokeExAppHistoryTitle(dbId, createdDate, title);
        }
      } catch (e) {
        logger.error('Failed to predict title for ExApp history', e as Error);
      }
    }
  }
};
