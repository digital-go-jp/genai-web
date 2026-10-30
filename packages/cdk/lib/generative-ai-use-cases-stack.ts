import * as cdk from 'aws-cdk-lib';
import { Aspects, CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import {
  Api,
  Auth,
  BedrockInferenceProfiles,
  CommonWebAcl,
  Database,
  Monitoring,
  PasswordResetApi,
  PasswordResetDatabase,
  Transcribe,
  Web,
} from './construct';
import { EncryptionKey } from './construct/kms';
import { LoggingStack } from './logging-stack';
import { StackInput } from './stack-input';
import { TeamAccessControlStack } from './team-access-control-stack';

export interface GenerativeAiUseCasesStackProps extends StackProps {
  params: StackInput;
  // Guardrail
  guardrailIdentifier?: string;
  guardrailVersion?: string;
  // WAF
  webAclId?: string;
  // Custom Domain
  cert?: ICertificate;
  hostedZoneId?: string;
}

export class GenerativeAiUseCasesStack extends Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly encryptionKey: kms.IKey;

  constructor(scope: Construct, id: string, props: GenerativeAiUseCasesStackProps) {
    super(scope, id, props);
    process.env.overrideWarningsEnabled = 'false';

    const params = props.params;
    const passwordResetEnabled = params.emailMfaRequired;

    // KMS Key for encryption (CMEK)
    const encryptionKey = new EncryptionKey(this, 'EncryptionKey', {
      appEnv: params.appEnv,
    });
    this.encryptionKey = encryptionKey.key;

    // SAML OAuth: IdP名のリストを構築
    const samlIdentityProviderNames = params.samlAuthEnabled
      ? [
          params.samlCognitoFederatedIdentityPrimaryProviderName,
          ...(params.samlCognitoFederatedIdentityAdditionalProviderNames?.map(
            (p) => p.providerName,
          ) ?? []),
        ].filter((name): name is string => !!name)
      : undefined;

    // SAML OAuth: コールバックURL（カスタムドメインがある場合のみ事前に解決可能）
    const samlOAuthCallbackUrls =
      params.samlAuthEnabled && params.hostName && params.domainName
        ? [`https://${params.hostName}.${params.domainName}`]
        : undefined;

    // Auth
    const auth = new Auth(this, 'Auth', {
      encryptionKey: encryptionKey.key,
      selfSignUpEnabled: params.selfSignUpEnabled,
      allowedIpV4AddressRanges: params.allowedIpV4AddressRanges,
      allowedIpV6AddressRanges: params.allowedIpV6AddressRanges,
      allowedSignUpEmailDomains: params.allowedSignUpEmailDomains,
      samlAuthEnabled: params.samlAuthEnabled,
      samlOAuthCallbackUrls,
      samlIdentityProviderNames,
      customEmailSender: params.customEmailSender ?? null,
      emailMfaRequired: params.emailMfaRequired,
      passwordPolicy: params.passwordPolicy,
      reauthenticationIntervalDays: params.reauthenticationIntervalDays,
      appEnv: params.appEnv,
    });

    // Database
    const database = new Database(this, 'Database', {
      encryptionKey: encryptionKey.key,
      removalPolicy:
        params.databaseRemovalPolicy === 'RETAIN'
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
    });
    database.table.tableName;

    const passwordResetDatabase = passwordResetEnabled
      ? new PasswordResetDatabase(this, 'PasswordResetDatabase', {
          encryptionKey: encryptionKey.key,
          removalPolicy:
            params.databaseRemovalPolicy === 'RETAIN'
              ? cdk.RemovalPolicy.RETAIN
              : cdk.RemovalPolicy.DESTROY,
        })
      : undefined;

    // Bedrock Inference Profiles for cost allocation tagging
    // Creates Application Inference Profiles with Environment tags for each model
    const inferenceProfiles = params.appEnv
      ? new BedrockInferenceProfiles(this, 'BedrockInferenceProfiles', {
          modelIds: params.modelIds,
          imageGenerationModelIds: params.imageGenerationModelIds,
          modelRegion: params.modelRegion,
          appEnv: params.appEnv,
        })
      : null;

    // API
    const api = new Api(this, 'API', {
      encryptionKey: encryptionKey.key,
      modelRegion: params.modelRegion,
      modelIds: params.modelIds,
      imageGenerationModelIds: params.imageGenerationModelIds,
      endpointNames: params.endpointNames,
      crossAccountBedrockRoleArn: params.crossAccountBedrockRoleArn,
      s3FileExpirationDays: params.dataRetentionDays.s3FileExpiration,
      dynamoDbTtlDays: params.dataRetentionDays.dynamoDbTtl,

      // Inference Profile mappings for cost allocation tagging
      inferenceProfileMap: inferenceProfiles?.profileMapping,
      imageInferenceProfileMap: inferenceProfiles?.imageProfileMapping,

      userPool: auth.userPool,
      authenticatedRole: auth.authenticatedRole,
      userPoolClient: auth.client,
      table: database.table,
      guardrailIdentify: props.guardrailIdentifier,
      guardrailVersion: props.guardrailVersion,
      costConversion: params.costConversion,
    });
    api.predictStreamFunction.grantInvoke(auth.systemAdminRole);
    api.predictStreamFunction.grantInvoke(auth.teamAdminRole);
    api.predictStreamFunction.grantInvoke(auth.userRole);

    /***
     * GenerativeA IUseCasesStackのリソース数が上限を超えてしまうため、Construct から NestedStackに切り出す
     */
    const teamAccessControl = new TeamAccessControlStack(this, `TeamAccessControlStack`, {
      encryptionKey: encryptionKey.key,
      userPool: auth.userPool,
      vpcId: params.vpcIdForInvokeExApp,
      logLevel: params.logLevel,
      exAppInvokeTimeoutSeconds: params.exAppInvokeTimeoutSeconds,
      exAppInvokableHostnames: params.exAppInvokableHostnames,
      s3FileExpirationDays: params.dataRetentionDays.s3FileExpiration,
      dynamoDbTtlDays: params.dataRetentionDays.dynamoDbTtl,
      envName: params.appEnv,
      removalPolicy:
        params.databaseRemovalPolicy === 'RETAIN'
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
      modelRegion: params.modelRegion,
      modelIds: params.modelIds,
      crossAccountBedrockRoleArn: params.crossAccountBedrockRoleArn,
      inferenceProfileMap: inferenceProfiles?.profileMapping,
      costConversion: params.costConversion,
    });

    // TeamAccessControl API のポリシーを各ロールにアタッチ
    // （NestedStack → 親スタックのロール変更による循環依存を回避するため、親スタックで実施）
    const teamAccessControlApiArn = `arn:aws:execute-api:${this.region}:${this.account}:${teamAccessControl.api.restApiId}/${teamAccessControl.api.deploymentStage.stageName}`;

    // For System Admin Group
    const systemAdminPolicy = new iam.Policy(this, 'TeamAccessControlSystemAdminPolicy', {
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['execute-api:Invoke'],
          resources: [`${teamAccessControlApiArn}/*/*`],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['s3:GetObject'],
          resources: [
            teamAccessControl.artifactsBucket.arnForObjects(
              '${cognito-identity.amazonaws.com:sub}/*',
            ),
          ],
        }),
      ],
    });
    auth.systemAdminRole.attachInlinePolicy(systemAdminPolicy);

    // For Team Admin Group
    const teamAdminPolicy = new iam.Policy(this, 'TeamAccessControlTeamAdminPolicy', {
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.DENY,
          actions: ['execute-api:Invoke'],
          resources: [
            `${teamAccessControlApiArn}/POST/teams`,
            `${teamAccessControlApiArn}/DELETE/teams/*`,
          ],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['execute-api:Invoke'],
          resources: [`${teamAccessControlApiArn}/*/*`],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['s3:GetObject'],
          resources: [
            teamAccessControl.artifactsBucket.arnForObjects(
              '${cognito-identity.amazonaws.com:sub}/*',
            ),
          ],
        }),
      ],
    });
    auth.teamAdminRole.attachInlinePolicy(teamAdminPolicy);

    // For User Group
    const userPolicy = new iam.Policy(this, 'TeamAccessControlUserPolicy', {
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.DENY,
          actions: ['execute-api:Invoke'],
          resources: [`${teamAccessControlApiArn}/*/teams/*`],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['execute-api:Invoke'],
          resources: [`${teamAccessControlApiArn}/*/*`],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['s3:GetObject'],
          resources: [
            teamAccessControl.artifactsBucket.arnForObjects(
              '${cognito-identity.amazonaws.com:sub}/*',
            ),
          ],
        }),
      ],
    });
    auth.userRole.attachInlinePolicy(userPolicy);

    // cdk-nag suppressions for TeamAccessControl policies
    NagSuppressions.addResourceSuppressions(
      [systemAdminPolicy, teamAdminPolicy, userPolicy],
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'This policy allows a user to access only their own objects in the S3 bucket. The use of the cognito-identity variable requires a wildcard.',
        },
      ],
      true,
    );

    // Prototyping の範囲だけ CDK-NAG を適用します
    Aspects.of(teamAccessControl).add(new AwsSolutionsChecks({ verbose: true }));

    if (
      params.allowedIpV4AddressRanges ||
      params.allowedIpV6AddressRanges ||
      params.allowedCountryCodes
    ) {
      const regionalWaf = new CommonWebAcl(this, 'RegionalWaf', {
        encryptionKey: encryptionKey.key,
        scope: 'REGIONAL',
        allowedIpV4AddressRanges: params.allowedIpV4AddressRanges,
        allowedIpV6AddressRanges: params.allowedIpV6AddressRanges,
        allowedCountryCodes: params.allowedCountryCodes,
        appEnv: params.appEnv,
      });
      new CfnWebACLAssociation(this, 'ApiWafAssociation', {
        resourceArn: api.api.deploymentStage.stageArn,
        webAclArn: regionalWaf.webAclArn,
      });
      new CfnWebACLAssociation(this, 'UserPoolWafAssociation', {
        resourceArn: auth.userPool.userPoolArn,
        webAclArn: regionalWaf.webAclArn,
      });
      // Added by prototyping
      new CfnWebACLAssociation(this, 'TeamAccessControlApiWafAssociation', {
        resourceArn: teamAccessControl.api.deploymentStage.stageArn,
        webAclArn: regionalWaf.webAclArn,
      });
    }

    // Web Frontend
    const web = new Web(this, 'Api', {
      encryptionKey: encryptionKey.key,
      appEnv: params.appEnv,
      teamAccessControlApiEndpointUrl: teamAccessControl.api.url, // Added by prototyping
      userPoolId: auth.userPool.userPoolId,
      userPoolClientId: auth.client.userPoolClientId,
      idPoolId: auth.idPool.attrId,
      selfSignUpEnabled: params.selfSignUpEnabled,
      emailMfaRequired: params.emailMfaRequired,
      passwordPolicy: params.passwordPolicy,
      samlAuthEnabled: params.samlAuthEnabled,
      samlCognitoDomainName: params.samlCognitoDomainName,
      samlCognitoFederatedIdentityPrimaryProviderName:
        params.samlCognitoFederatedIdentityPrimaryProviderName,
      samlCognitoFederatedIdentityAdditionalProviderNames:
        params.samlCognitoFederatedIdentityAdditionalProviderNames,
      // Backend
      apiEndpointUrl: api.api.url,
      predictStreamFunctionArn: api.predictStreamFunction.functionArn,
      webAclId: props.webAclId,
      modelRegion: api.modelRegion,
      modelIds: api.modelIds,
      defaultModelId: params.defaultModelId,
      imageGenerationModelIds: api.imageGenerationModelIds,
      endpointNames: api.endpointNames,
      recentlyUsedAppsEnabled: params.recentlyUsedAppsEnabled,
      // Frontend
      hiddenUseCases: params.hiddenUseCases,
      govais_for_homepage: params.govais_for_homepage,
      topChatSystemPrompt: params.top_chat_system_prompt,
      topChatSystemPromptTitle: params.top_chat_system_prompt_title,
      // Custom Domain
      cert: props.cert,
      hostName: params.hostName,
      domainName: params.domainName,
      hostedZoneId: props.hostedZoneId,
      // Maintenance Mode
      maintenance: params.maintenance,
    });

    if (passwordResetDatabase && params.customEmailSender) {
      new PasswordResetApi(this, 'PasswordResetApi', {
        api: api.api,
        passwordResetTable: passwordResetDatabase.table,
        emailHashIndexName: passwordResetDatabase.emailHashIndexName,
        userPool: auth.userPool,
        sesIdentityName: params.customEmailSender.sesIdentityName,
        sesFromAddress: params.customEmailSender.fromAddress,
        sesConfigurationSetName: params.customEmailSender.sesConfigurationSetName,
        sesTenantName: auth.sesTenantName,
        passwordPolicy: params.passwordPolicy,
      });
    }

    // SAML有効かつカスタムドメインがない場合、CloudFront URL をコールバックURLに設定
    if (params.samlAuthEnabled && !params.hostName && samlIdentityProviderNames?.length) {
      const cfnClient = auth.client.node.defaultChild as cognito.CfnUserPoolClient;
      cfnClient.addPropertyOverride('CallbackURLs', [`https://${web.distribution.domainName}`]);
      cfnClient.addPropertyOverride('LogoutURLs', [
        `https://${web.distribution.domainName}/signed-out`,
      ]);
      cfnClient.addPropertyOverride('SupportedIdentityProviders', samlIdentityProviderNames);
    }

    // Transcribe
    const transcribe = new Transcribe(this, 'Transcribe', {
      encryptionKey: encryptionKey.key,
      userPool: auth.userPool,
      authenticatedRole: auth.authenticatedRole,
      api: api.api,
      appEnv: params.appEnv,
    });

    const cognitoIdentityLambdas = [
      teamAccessControl.invokeExAppFunction,
      teamAccessControl.getArtifactFileFunction,
      api.getSignedUrlFunction,
      api.getFileDownloadSignedUrlFunction,
      api.deleteFileFunction,
      transcribe.getSignedUrlFunction,
      transcribe.startTranscriptionFunction,
    ];
    const cognitoIdentityPolicyStatement = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cognito-identity:GetId',
        'cognito-identity:ListIdentityPools',
        'cognito-identity:DescribeIdentityPool',
      ],
      // ListIdentityPools does not support resource-level permissions.
      // DescribeIdentityPool target ARN is not determinable at synth time.
      resources: ['*'],
    });
    for (const fn of cognitoIdentityLambdas) {
      fn.addToRolePolicy(cognitoIdentityPolicyStatement);
      NagSuppressions.addResourceSuppressions(
        fn.role!,
        [
          {
            id: 'AwsSolutions-IAM5',
            reason:
              'cognito-identity:ListIdentityPools does not support resource-level permissions. DescribeIdentityPool target ARN is not determinable at synth time. Scope is limited to the current AWS account. No secrets or credentials are exposed through these read-only APIs.',
            appliesTo: [
              'Action::cognito-identity:ListIdentityPools',
              'Action::cognito-identity:DescribeIdentityPool',
              'Resource::*',
            ],
          },
        ],
        true,
      );
    }

    // Logging
    if (params.destination) {
      new LoggingStack(this, `SourceStack${params.env}`, {
        encryptionKey: encryptionKey.key,
        env: {
          account: process.env.CDK_DEFAULT_ACCOUNT,
          region: process.env.CDK_DEFAULT_REGION,
        },
        params,
        // TODO: s3BucketInvocationLog は Bedrock の実行ログを収集しているバケット。
        // 現在はアカウント一つに対して `bedrock-logs-bucket-${this.account}` 一つが紐づいており、
        // スタックごとの設定になっていないため、外部からバケット名を指定する必要がある。
        // この設定方法については今後検討が必要なため、一旦無効化しておく。
        // s3BucketInvocationLog: `bedrock-logs-bucket-${this.account}`
        dynamoTableChatLog: database.table.tableName,
        dynamoTableGovAiLog: teamAccessControl.table.tableName,
        dynamoTableExAppLog: teamAccessControl.exAppTable.tableName,
        dynamoTableInvokeHistoryLog: teamAccessControl.invokeExAppHistoryTable.tableName,
        userPoolId: auth.userPool.userPoolId,
        cognitoLogGroupName: auth.cognitoLogGroupName,
      });
    }

    // Monitoring (CloudWatch Alarms and Slack Notifications)
    if (params.monitoring) {
      new Monitoring(this, 'Monitoring', {
        encryptionKey: encryptionKey.key,
        appEnvName: params.appEnv,
        slackEnabled: params.slack.enabled,
        slackChannelId: params.slack.channelId,
        slackWorkspaceId: params.slack.workspaceId,
      });
    }

    // Cfn Outputs
    new CfnOutput(this, 'Region', {
      value: this.region,
    });

    if (params.hostName && params.domainName) {
      new CfnOutput(this, 'WebUrl', {
        value: `https://${params.hostName}.${params.domainName}`,
      });
    } else {
      new CfnOutput(this, 'WebUrl', {
        value: `https://${web.distribution.domainName}`,
      });
    }

    new CfnOutput(this, 'ApiEndpoint', {
      value: api.api.url,
    });

    new CfnOutput(this, 'TeamAccessControlApiEndpoint', {
      value: teamAccessControl.api.url,
    });

    new CfnOutput(this, 'TeamAccessControlTableName', {
      value: teamAccessControl.table.tableName,
      description: 'Team/TeamUser management DynamoDB table name',
    });

    new CfnOutput(this, 'ExAppTableName', {
      value: teamAccessControl.exAppTable.tableName,
      description: 'ExApp (AI App) definitions DynamoDB table name',
    });

    new CfnOutput(this, 'InvokeExAppHistoryTableName', {
      value: teamAccessControl.invokeExAppHistoryTable.tableName,
      description: 'ExApp invocation history DynamoDB table name',
    });

    new CfnOutput(this, 'UserPoolId', {
      value: auth.userPool.userPoolId,
    });

    new CfnOutput(this, 'UserPoolClientId', {
      value: auth.client.userPoolClientId,
    });

    new CfnOutput(this, 'IdPoolId', { value: auth.idPool.attrId });

    new CfnOutput(this, 'PredictStreamFunctionArn', {
      value: api.predictStreamFunction.functionArn,
    });

    new CfnOutput(this, 'SelfSignUpEnabled', {
      value: params.selfSignUpEnabled.toString(),
    });

    new CfnOutput(this, 'EmailMfaRequired', {
      value: params.emailMfaRequired.toString(),
    });

    new CfnOutput(this, 'PasswordPolicy', {
      value: JSON.stringify(params.passwordPolicy),
    });

    new CfnOutput(this, 'ModelRegion', {
      value: api.modelRegion,
    });

    new CfnOutput(this, 'ModelIds', {
      value: JSON.stringify(api.modelIds),
    });

    new CfnOutput(this, 'ImageGenerateModelIds', {
      value: JSON.stringify(api.imageGenerationModelIds),
    });

    new CfnOutput(this, 'EndpointNames', {
      value: JSON.stringify(api.endpointNames),
    });

    new CfnOutput(this, 'SamlAuthEnabled', {
      value: params.samlAuthEnabled.toString(),
    });

    new CfnOutput(this, 'SamlCognitoDomainName', {
      value: params.samlCognitoDomainName ?? '',
    });

    new CfnOutput(this, 'SamlCognitoFederatedIdentityPrimaryProviderName', {
      value: params.samlCognitoFederatedIdentityPrimaryProviderName ?? '',
    });

    new CfnOutput(this, 'SamlCognitoFederatedIdentityAdditionalProviderNames', {
      value: JSON.stringify(params.samlCognitoFederatedIdentityAdditionalProviderNames ?? []),
    });

    new CfnOutput(this, 'HiddenUseCases', {
      value: JSON.stringify(params.hiddenUseCases),
    });

    new CfnOutput(this, 'AppEnv', {
      value: params.appEnv,
    });

    new CfnOutput(this, 'GovaisForHomepage', {
      value: Buffer.from(JSON.stringify(params.govais_for_homepage)).toString('base64'),
    });

    new CfnOutput(this, 'TopChatSystemPrompt', {
      value: Buffer.from(params.top_chat_system_prompt).toString('base64'),
    });

    new CfnOutput(this, 'TopChatSystemPromptTitle', {
      value: Buffer.from(params.top_chat_system_prompt_title).toString('base64'),
    });

    new CfnOutput(this, 'RecentlyUsedAppsEnabled', {
      value: params.recentlyUsedAppsEnabled.toString(),
    });

    // DynamoDB Table Names
    new CfnOutput(this, 'GenUusecasesTableName', {
      value: database.table.tableName,
      description: 'Chat log DynamoDB table name',
    });

    new CfnOutput(this, 'InvokeExAppTableName', {
      value: teamAccessControl.table.tableName,
      description: 'AI App invocation DynamoDB table name',
    });

    if (auth.customEmailSenderLambdaRoleArn) {
      new CfnOutput(this, 'CustomEmailSenderLambdaRoleArn', {
        value: auth.customEmailSenderLambdaRoleArn,
        description: 'Custom Email Sender Lambda execution role ARN for SES email sending',
      });
    }

    if (auth.sesTenantName) {
      new CfnOutput(this, 'SesTenantName', {
        value: auth.sesTenantName,
        description: 'SES Tenant name for reputation isolation',
      });
    }

    this.userPool = auth.userPool;
    this.userPoolClient = auth.client;
  }
}
