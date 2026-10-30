import { createExApp, findExAppById } from './repository/exAppRepository';
import { findTeamById } from './repository/teamRepository';
import { copyExAppSchema } from './schemas/copyExAppSchema';
import { getApiKeyValue, setApiKey } from './utils/apiKey';
import { createApiHandler } from './utils/createApiHandler';
import { assertPublicEndpointUrl, isExAppUrlValidationError } from './utils/exAppUrlSecurity';
import { HttpError } from './utils/httpError';
import { parseRequestBody } from './utils/parseRequestBody';
import { requirePathParam } from './utils/requirePathParam';
import { requireTeamAdminOrSystemAdmin } from './utils/requireTeamAdminOrSystemAdmin';

const APP_ENV = process.env.APP_ENV || '';

export const handler = createApiHandler(async (event) => {
  const teamId = requirePathParam(event, 'teamId');
  const exAppId = requirePathParam(event, 'exAppId');
  await requireTeamAdminOrSystemAdmin(event, teamId);

  const req = parseRequestBody(copyExAppSchema, event.body!);

  const team = await findTeamById(teamId);
  if (!team) {
    throw new HttpError(400, 'チームが見つかりませんでした。');
  }

  const exApp = await findExAppById(teamId, exAppId);
  if (!exApp) {
    throw new HttpError(400, 'ExAppが見つかりませんでした。');
  }

  if (!exApp.copyable) {
    throw new HttpError(403, 'このAIアプリはコピーできません。');
  }

  try {
    await assertPublicEndpointUrl(exApp.endpoint);
  } catch (error) {
    if (isExAppUrlValidationError(error)) {
      throw new HttpError(
        400,
        '許可されたエンドポイント以外のURLが指定されたか、URLの形式が不正です。',
      );
    }
    throw error;
  }

  const apiKeyValue = await getApiKeyValue(teamId, exAppId, APP_ENV);
  if (!apiKeyValue) {
    throw new HttpError(400, 'APIキーの取得に失敗しました。');
  }

  const copiedExApp = await createExApp({
    teamId,
    exAppName: req.exAppName,
    endpoint: exApp.endpoint,
    config: req.config ?? '',
    placeholder: req.placeholder,
    systemPrompt: req.systemPrompt ?? '',
    systemPromptKeyName: req.systemPromptKeyName ?? '',
    description: req.description,
    howToUse: req.howToUse,
    copyable: req.copyable,
    status: req.status,
  });

  await setApiKey(teamId, copiedExApp.exAppId, apiKeyValue, APP_ENV);

  return { statusCode: 200, body: { ...copiedExApp, apiKey: '' } };
});
