/*
 *  Copyright 2025 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *  SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
 *  Licensed under the Amazon Software License  http://aws.amazon.com/asl/
 */
import { createExApp } from './repository/exAppRepository';
import { createExAppSchema } from './schemas/createExAppSchema';
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
  await requireTeamAdminOrSystemAdmin(event, teamId);

  const req = parseRequestBody(createExAppSchema, event.body!);
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

  const exApp = await createExApp({
    teamId,
    exAppName: req.exAppName,
    endpoint: req.endpoint,
    config: req.config ?? '',
    placeholder: req.placeholder,
    systemPrompt: req.systemPrompt ?? '',
    systemPromptKeyName: req.systemPromptKeyName ?? '',
    description: req.description,
    howToUse: req.howToUse,
    copyable: req.copyable,
    status: req.status,
  });

  await setApiKey(teamId, exApp.exAppId, req.apiKey, APP_ENV);

  return { statusCode: 200, body: { ...exApp, apiKey: '' } };
});
