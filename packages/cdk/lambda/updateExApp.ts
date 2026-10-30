/*
 *  Copyright 2025 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *  SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
 *  Licensed under the Amazon Software License  http://aws.amazon.com/asl/
 */
import { findExAppById, updateExApp } from './repository/exAppRepository';
import { updateExAppSchema } from './schemas/updateExAppSchema';
import { setApiKey } from './utils/apiKey';
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

  const req = parseRequestBody(updateExAppSchema, event.body!);
  try {
    await assertPublicEndpointUrl(req.endpoint);
  } catch (error) {
    if (isExAppUrlValidationError(error)) {
      throw new HttpError(
        400,
        '許可されたエンドポイント以外のURLが指定されたか、URLの形式が不正です。',
      );
    }
    throw error;
  }

  const currentExApp = await findExAppById(teamId, exAppId);
  if (!currentExApp) {
    throw new HttpError(404, 'AIアプリが見つかりません。');
  }

  if (currentExApp.endpoint !== req.endpoint && !req.apiKey) {
    throw new HttpError(400, 'APIエンドポイントを変更する場合はAPIキーを再入力してください。');
  }

  const exApp = await updateExApp(teamId, exAppId, req);

  if (req.apiKey) {
    await setApiKey(teamId, exAppId, req.apiKey, APP_ENV);
  }

  return { statusCode: 200, body: { ...exApp, apiKey: '' } };
});
