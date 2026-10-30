/*
 *  Copyright 2025 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *  SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
 *  Licensed under the Amazon Software License  http://aws.amazon.com/asl/
 */
import { Annotations, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import {
  AuthorizationType,
  CfnRestApi,
  CfnStage,
  CognitoUserPoolsAuthorizer,
  Cors,
  EndpointType,
  LambdaIntegration,
  LogGroupLogDestination,
  MethodLoggingLevel,
  ResponseType,
  RestApi,
} from 'aws-cdk-lib/aws-apigateway';
import { UserPool } from 'aws-cdk-lib/aws-cognito';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import { IVpc, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import {
  ApplicationLogLevel,
  LoggingFormat,
  Runtime,
  SystemLogLevel,
} from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { EXAPP_INVOKABLE_HOSTNAMES_ENV } from '../../lambda/utils/exAppAllowlist';
import { StackInput } from '../stack-input';
import { InvokeExAppLambdaVpc } from './invoke-exapp-lambda-vpc';
import { UserIdentifierHmacKey } from './kms';

export const EXAPP_INVOKABLE_HOSTNAMES_DENY_ALL_WARNING_ID =
  'genai:exapp:invokableHostnamesDenyAll';
const EXAPP_INVOKABLE_HOSTNAMES_DENY_ALL_WARNING =
  'exAppInvokableHostnames is empty: every ExApp endpoint is denied on create, update, copy and invoke, and status polling of in-flight async invocations ends in ERROR. Set it to ["*"] to allow any public endpoint, or list the allowed hostnames';

interface TeamAccessControlProps {
  encryptionKey: kms.IKey;
  userPool: UserPool;
  allowedSignUpEmailDomains: string[] | null | undefined;
  vpcId: string | undefined;
  logLevel: StackInput['logLevel'];
  exAppInvokeTimeoutSeconds: number;
  exAppInvokableHostnames: StackInput['exAppInvokableHostnames'];
  s3FileExpirationDays: number;
  dynamoDbTtlDays: number;
  envName?: string;
  /**
   * Removal policy for the DynamoDB table.
   * - DESTROY: Table will be deleted when the stack is deleted (default)
   * - RETAIN: Table will be retained when the stack is deleted
   */
  removalPolicy?: RemovalPolicy;
  modelRegion: string;
  modelIds: string[];
  crossAccountBedrockRoleArn?: string | null;
  inferenceProfileMap?: { [modelId: string]: string };
  costConversion?: {
    toCurrency: string;
    rate: number;
    allowedFromCurrencies: string[];
  };
}

/**  Class for construct of authorization resources. */
export class TeamAccessControl extends Construct {
  public readonly table: ddb.Table;
  public readonly exAppTable: ddb.Table;
  public readonly invokeExAppHistoryTable: ddb.Table;
  public readonly artifactsBucket: s3.Bucket;
  public readonly api: RestApi;
  public readonly userPoolId: string;
  /** 親スタックから cognito-identity:* の IAM を付与するため公開する */
  public readonly invokeExAppFunction: NodejsFunction;
  public readonly getArtifactFileFunction: NodejsFunction;
  private readonly appEnv: string;
  private readonly costConversionEnv: {
    COST_CONVERSION_TO_CURRENCY: string;
    COST_CONVERSION_RATE: string;
    COST_CONVERSION_ALLOWED_FROM: string;
  };
  private readonly exAppInvokableHostnamesJson: string;

  constructor(scope: Construct, id: string, props: TeamAccessControlProps) {
    super(scope, id);

    const { userPool } = props;
    this.userPoolId = userPool.userPoolId;
    this.appEnv = props.envName || '';
    this.exAppInvokableHostnamesJson = JSON.stringify(props.exAppInvokableHostnames);
    if (props.exAppInvokableHostnames.length === 0) {
      Annotations.of(this).addWarningV2(
        EXAPP_INVOKABLE_HOSTNAMES_DENY_ALL_WARNING_ID,
        EXAPP_INVOKABLE_HOSTNAMES_DENY_ALL_WARNING,
      );
    }

    this.costConversionEnv = {
      COST_CONVERSION_TO_CURRENCY: props.costConversion?.toCurrency ?? '',
      COST_CONVERSION_RATE: (props.costConversion?.rate ?? 0).toString(),
      COST_CONVERSION_ALLOWED_FROM: (props.costConversion?.allowedFromCurrencies ?? []).join(','),
    };
    const costConversionEnv = this.costConversionEnv;

    // LogLevelの文字列を cdkが提供する型に変換
    const applicationLogLevel = props.logLevel as ApplicationLogLevel;
    const systemLogLevel = props.logLevel as SystemLogLevel;

    /** DynamoDB stores the information about Teams and TeamMembers */
    const table = new ddb.Table(this, 'Table', {
      partitionKey: {
        name: 'pk',
        type: ddb.AttributeType.STRING,
      },
      sortKey: {
        name: 'sk',
        type: ddb.AttributeType.STRING,
      },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expire_at',
      encryption: ddb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: props.encryptionKey,
      removalPolicy: props.removalPolicy ?? RemovalPolicy.DESTROY,
    });
    const cfnTable = table.node.defaultChild as ddb.CfnTable;
    cfnTable.addPropertyOverride('PointInTimeRecoverySpecification', {
      PointInTimeRecoveryEnabled: true,
      RecoveryPeriodInDays: 8,
    });
    table.addGlobalSecondaryIndex({
      indexName: 'GSI-1',
      partitionKey: {
        name: 'sk',
        type: ddb.AttributeType.STRING,
      },
      sortKey: {
        name: 'pk',
        type: ddb.AttributeType.STRING,
      },
      projectionType: ddb.ProjectionType.ALL,
    });

    this.table = table;

    /** DynamoDB stores ExApp (AI App) master definitions */
    const exAppTable = new ddb.Table(this, 'ExAppTable', {
      partitionKey: {
        name: 'pk',
        type: ddb.AttributeType.STRING,
      },
      sortKey: {
        name: 'sk',
        type: ddb.AttributeType.STRING,
      },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      encryption: ddb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: props.encryptionKey,
      removalPolicy: props.removalPolicy ?? RemovalPolicy.DESTROY,
    });
    const cfnExAppTable = exAppTable.node.defaultChild as ddb.CfnTable;
    cfnExAppTable.addPropertyOverride('PointInTimeRecoverySpecification', {
      PointInTimeRecoveryEnabled: true,
      RecoveryPeriodInDays: 8,
    });
    this.exAppTable = exAppTable;

    /** DynamoDB stores ExApp invocation history */
    const invokeExAppHistoryTable = new ddb.Table(this, 'InvokeExAppHistoryTable', {
      partitionKey: {
        name: 'pk',
        type: ddb.AttributeType.STRING,
      },
      sortKey: {
        name: 'sk',
        type: ddb.AttributeType.STRING,
      },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expire_at',
      encryption: ddb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: props.encryptionKey,
      removalPolicy: props.removalPolicy ?? RemovalPolicy.DESTROY,
    });
    const cfnInvokeExAppHistoryTable = invokeExAppHistoryTable.node.defaultChild as ddb.CfnTable;
    cfnInvokeExAppHistoryTable.addPropertyOverride('PointInTimeRecoverySpecification', {
      PointInTimeRecoveryEnabled: true,
      RecoveryPeriodInDays: 8,
    });
    this.invokeExAppHistoryTable = invokeExAppHistoryTable;

    const artifactsAccessLogsBucket = new s3.Bucket(this, 'ArtifactsAccessLogsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: props.encryptionKey,
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY,
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      enforceSSL: true,
    });

    const artifactsBucket = new s3.Bucket(this, 'ArtifactsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: props.encryptionKey,
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY,
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      serverAccessLogsBucket: artifactsAccessLogsBucket,
      serverAccessLogsPrefix: 'AccessLogs/',
      enforceSSL: true,
      lifecycleRules: [
        {
          expiration: Duration.days(props.s3FileExpirationDays),
        },
      ],
    });

    this.artifactsBucket = artifactsBucket;

    // API Gateway
    const authorizer = new CognitoUserPoolsAuthorizer(this, 'Authorizer', {
      cognitoUserPools: [userPool],
    });

    const apiAccessLog = new LogGroup(this, 'TeamAccessControlApiAccessLogGroup', {
      encryptionKey: props.encryptionKey,
    });
    const api = new RestApi(this, 'Api', {
      endpointTypes: [EndpointType.REGIONAL],
      deployOptions: {
        stageName: 'api',
        loggingLevel: MethodLoggingLevel.INFO,
        accessLogDestination: new LogGroupLogDestination(apiAccessLog),
      },
      defaultCorsPreflightOptions: {
        allowOrigins: Cors.ALL_ORIGINS,
        allowMethods: Cors.ALL_METHODS,
      },
      cloudWatchRole: true,
    });

    api.addGatewayResponse('Api4XX', {
      type: ResponseType.DEFAULT_4XX,
      responseHeaders: {
        'Access-Control-Allow-Origin': "'*'",
      },
    });

    api.addGatewayResponse('Api5XX', {
      type: ResponseType.DEFAULT_5XX,
      responseHeaders: {
        'Access-Control-Allow-Origin': "'*'",
      },
    });

    /** functions of Team Access Control api */
    // POST /teams
    const createTeamFunction = this.createTeamAccessControlFunction(
      'CreateTeam',
      './lambda/createTeam.ts',
    );
    createTeamFunction.addEnvironment(
      'ALLOWED_SIGN_UP_EMAIL_DOMAINS_STR',
      JSON.stringify(props.allowedSignUpEmailDomains),
    );
    this.addCognitoAdminPolicy(createTeamFunction);

    // GET /teams
    const listTeamsFunction = this.createTeamAccessControlFunction(
      'ListTeams',
      './lambda/listTeams.ts',
      1024,
    );
    this.addCognitoReadOnlyPolicy(listTeamsFunction);

    // GET /teams/{id}
    const getTeamFunction = this.createTeamAccessControlFunction('GetTeam', './lambda/getTeam.ts');
    this.addCognitoReadOnlyPolicy(getTeamFunction);

    // PUT /teams/{id}
    const updateTeamFunction = this.createTeamAccessControlFunction(
      'UpdateTeam',
      './lambda/updateTeam.ts',
    );
    table.grantReadWriteData(updateTeamFunction);

    // DELETE /teams/{id}
    const deleteTeamFunction = this.createTeamAccessControlFunction(
      'DeleteTeam',
      './lambda/deleteTeam.ts',
    );
    this.addSecretsManagerPolicy(deleteTeamFunction);

    // GET /teams/{id}/raw
    const getRawTeamFunction = this.createTeamAccessControlFunction(
      'GetRawTeam',
      './lambda/getRawTeam.ts',
    );
    this.addCognitoReadOnlyPolicy(getRawTeamFunction);

    // GET /teams/{id}/exapps
    const listTeamExAppsFunction = this.createTeamAccessControlFunction(
      'ListTeamExApps',
      './lambda/listTeamExApps.ts',
      1024,
    );

    // POST /teams/{id}/exapps
    const createExAppFunction = this.createTeamAccessControlFunction(
      'CreateExApp',
      './lambda/createExApp.ts',
    );
    this.addSecretsManagerPolicy(createExAppFunction);

    // PUT /teams/{id}/exapps/{id}
    const updateExAppFunction = this.createTeamAccessControlFunction(
      'UpdateExApp',
      './lambda/updateExApp.ts',
    );
    this.addSecretsManagerPolicy(updateExAppFunction);

    // DELETE /teams/{id}/exapps/{id}
    const deleteExAppFunction = this.createTeamAccessControlFunction(
      'DeleteExApp',
      './lambda/deleteExApp.ts',
    );
    this.addSecretsManagerPolicy(deleteExAppFunction);

    // POST /teams/{id}/exapps/{id}/copy
    const copyExAppFunction = this.createTeamAccessControlFunction(
      'CopyExApp',
      './lambda/copyExApp.ts',
    );
    this.addSecretsManagerPolicy(copyExAppFunction);

    // DELETE /teams/{id}/exapps/{id}/history
    const deleteExAppInvokeHistoryFunction = this.createTeamAccessControlFunction(
      'DeleteExAppInvokeHistory',
      './lambda/deleteInvokeExAppHistory.ts',
    );
    this.addSecretsManagerPolicy(deleteExAppFunction);

    // GET /teams/{id}/exapps/{id}
    const getExAppFunction = this.createTeamAccessControlFunction(
      'GetExApp',
      './lambda/getExApp.ts',
      1024,
    );

    // GET /teams/{id}/exapps/{id}/raw
    const getRawTeamExAppFunction = this.createTeamAccessControlFunction(
      'GetRawTeamExApp',
      './lambda/getRawTeamApp.ts',
    );

    // GET /exapps
    const listExAppsFunction = this.createTeamAccessControlFunction(
      'ListExApps',
      './lambda/listExApps.ts',
      1024,
    );

    // GET /exapps/artifact-file
    // Cognito Identity Pool ID は実行時に Lambda が discovery するため env に含めない
    // （NestedStack → 親スタック所属の CfnIdentityPool への依存による循環を回避するため、
    //  cognito-identity:* の IAM も親スタック側で付与する）
    const getArtifactFileFunction = new NodejsFunction(this, 'GetArtifactFile', {
      runtime: Runtime.NODEJS_24_X,
      entry: './lambda/getArtifactFile.ts',
      timeout: Duration.seconds(15),
      environment: {
        ARTIFACTS_BUCKET_NAME: artifactsBucket.bucketName,
        USER_POOL_ID: this.userPoolId,
      },
    });
    artifactsBucket.grantRead(getArtifactFileFunction);

    NagSuppressions.addResourceSuppressions(
      getArtifactFileFunction.role!,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Lambda requires read access to artifacts bucket for generating signed URLs. Wildcard is necessary for accessing any object in the bucket.',
          appliesTo: [
            'Action::s3:GetBucket*',
            'Action::s3:GetObject*',
            'Action::s3:List*',
            `Resource::<${Stack.of(this).getLogicalId(artifactsBucket.node.defaultChild as s3.CfnBucket)}.Arn>/*`,
          ],
        },
      ],
      true,
    );

    // VPC For POST /exapps/{id}

    let vpcForLambda: IVpc;
    if (props.vpcId && props.vpcId !== '') {
      // 既存VPCを使用
      vpcForLambda = Vpc.fromLookup(this, 'LookupExistingVpc', {
        vpcId: props.vpcId,
      });
    } else {
      // 新しいVPCを作成し、そのvpcプロパティを使用
      const invokeExAppVpc = new InvokeExAppLambdaVpc(this, 'InvokeExAppVpc', {
        encryptionKey: props.encryptionKey,
        maxAzs: 2,
        cidr: '10.0.0.0/16',
        cidrMask: 24,
      });
      vpcForLambda = invokeExAppVpc.vpc;
    }

    const pollingDlq = new sqs.Queue(this, 'ExAppPollingDlq', {
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: props.encryptionKey,
    });

    // 非同期処理のための SQS キュー
    // visibilityTimeout（非同期処理のチェック間隔を設定）とmaxReceiveCount（最大再試行回数を設定）によって最大待機可能時間を構成する
    // ここの設定自体では、30秒の可視性タイムアウトと1000回の再試行で最大でも約8.3時間待機可能
    // 待機が長期間にわたる場合は pollExAppStatusFunction で ChangeMessageVisibility によってバックオフする
    const pollingQueue = new sqs.Queue(this, 'ExAppPollingQueue', {
      retentionPeriod: Duration.days(4),
      visibilityTimeout: Duration.seconds(30),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: props.encryptionKey,
      deadLetterQueue: {
        maxReceiveCount: 1000,
        queue: pollingDlq,
      },
    });

    const denyNonSecureTransportPolicy = new iam.PolicyStatement({
      effect: iam.Effect.DENY,
      actions: ['sqs:*'],
      principals: [new iam.AnyPrincipal()],
      resources: ['*'],
      conditions: {
        Bool: {
          'aws:SecureTransport': 'false',
        },
      },
    });

    pollingQueue.addToResourcePolicy(denyNonSecureTransportPolicy);
    pollingDlq.addToResourcePolicy(denyNonSecureTransportPolicy);

    // HMAC キーの作成（セッションIDハイジャック対策用）
    const userIdentifierHmacKey = new UserIdentifierHmacKey(this, 'UserIdentifierHmacKey', {
      appEnv: this.appEnv,
    });

    const pollExAppStatusFunction = new NodejsFunction(this, 'PollExAppStatus', {
      runtime: Runtime.NODEJS_24_X,
      entry: './lambda/pollExAppStatus.ts',
      timeout: Duration.seconds(15),
      vpc: vpcForLambda,
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_WITH_EGRESS,
      },
      environment: {
        TABLE_NAME: table.tableName,
        INVOKE_HISTORY_TABLE_NAME: invokeExAppHistoryTable.tableName,
        [EXAPP_INVOKABLE_HOSTNAMES_ENV]: this.exAppInvokableHostnamesJson,
        ARTIFACTS_BUCKET_NAME: artifactsBucket.bucketName,
        TTL_DAYS: props.dynamoDbTtlDays.toString(),
        APP_ENV: this.appEnv,
        USER_IDENTIFIER_HMAC_KEY_ID: userIdentifierHmacKey.key.keyId,
        MODEL_REGION: props.modelRegion,
        MODEL_IDS: JSON.stringify(props.modelIds),
        CROSS_ACCOUNT_BEDROCK_ROLE_ARN: props.crossAccountBedrockRoleArn ?? '',
        ...costConversionEnv,
        ...(props.inferenceProfileMap
          ? { INFERENCE_PROFILE_MAP: JSON.stringify(props.inferenceProfileMap) }
          : {}),
      },
      memorySize: 256,
      loggingFormat: LoggingFormat.JSON,
      systemLogLevelV2: systemLogLevel,
      applicationLogLevelV2: applicationLogLevel,
    });
    pollingQueue.grantConsumeMessages(pollExAppStatusFunction);
    table.grantReadWriteData(pollExAppStatusFunction);
    invokeExAppHistoryTable.grantReadWriteData(pollExAppStatusFunction);
    this.addSecretsManagerPolicy(pollExAppStatusFunction);

    // HMAC生成権限を付与
    userIdentifierHmacKey.grantGenerateMac(pollExAppStatusFunction.role!);
    pollExAppStatusFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject', 's3:AbortMultipartUpload'],
        resources: [artifactsBucket.arnForObjects('*')],
      }),
    );
    pollExAppStatusFunction.addEventSource(
      new SqsEventSource(pollingQueue, {
        batchSize: 1,
      }),
    );

    NagSuppressions.addResourceSuppressions(
      pollExAppStatusFunction.role!,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'The resource condition is specified in the IAM policy.',
          appliesTo: [
            `Resource::<${Stack.of(this).getLogicalId(artifactsBucket.node.defaultChild as s3.CfnBucket)}.Arn>/*`,
          ],
        },
      ],
      true,
    );

    // POST /exapps/{id}
    const invokeExAppFunction = new NodejsFunction(this, 'InvokeExApp', {
      runtime: Runtime.NODEJS_24_X,
      entry: './lambda/invokeExApp.ts',
      timeout: Duration.seconds(props.exAppInvokeTimeoutSeconds),
      vpc: vpcForLambda,
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_WITH_EGRESS,
      },
      // Cognito Identity Pool ID は Lambda が実行時に discovery で解決する
      environment: {
        TABLE_NAME: table.tableName,
        EXAPP_TABLE_NAME: exAppTable.tableName,
        INVOKE_HISTORY_TABLE_NAME: invokeExAppHistoryTable.tableName,
        POLLING_QUEUE_URL: pollingQueue.queueUrl,
        [EXAPP_INVOKABLE_HOSTNAMES_ENV]: this.exAppInvokableHostnamesJson,
        ARTIFACTS_BUCKET_NAME: artifactsBucket.bucketName,
        TTL_DAYS: props.dynamoDbTtlDays.toString(),
        APP_ENV: this.appEnv,
        USER_IDENTIFIER_HMAC_KEY_ID: userIdentifierHmacKey.key.keyId,
        USER_POOL_ID: this.userPoolId,
        MODEL_REGION: props.modelRegion,
        MODEL_IDS: JSON.stringify(props.modelIds),
        CROSS_ACCOUNT_BEDROCK_ROLE_ARN: props.crossAccountBedrockRoleArn ?? '',
        ...costConversionEnv,
        ...(props.inferenceProfileMap
          ? { INFERENCE_PROFILE_MAP: JSON.stringify(props.inferenceProfileMap) }
          : {}),
      },
      memorySize: 256,
      loggingFormat: LoggingFormat.JSON,
      systemLogLevelV2: systemLogLevel,
      applicationLogLevelV2: applicationLogLevel,
    });
    pollingQueue.grantSendMessages(invokeExAppFunction);
    table.grantReadWriteData(invokeExAppFunction);
    exAppTable.grantReadData(invokeExAppFunction);
    invokeExAppHistoryTable.grantReadWriteData(invokeExAppFunction);
    this.addSecretsManagerPolicy(invokeExAppFunction);

    // HMAC生成権限を付与
    userIdentifierHmacKey.grantGenerateMac(invokeExAppFunction.role!);
    // cognito-identity:* は親スタック側で付与（循環依存回避）
    invokeExAppFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject', 's3:AbortMultipartUpload'],
        resources: [artifactsBucket.arnForObjects('*')],
      }),
    );
    // Add CloudWatch permissions for error metrics publishing
    invokeExAppFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'cloudwatch:namespace': [
              `GenAI/ExApp/Errors-${this.appEnv}`,
              `GenAI/ExApp/Success-${this.appEnv}`,
            ],
          },
        },
      }),
    );

    // Bedrock permissions for title prediction
    if (
      typeof props.crossAccountBedrockRoleArn !== 'string' ||
      props.crossAccountBedrockRoleArn === ''
    ) {
      const bedrockPolicy = new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: ['*'],
        actions: ['bedrock:InvokeModel'],
      });
      invokeExAppFunction.role?.addToPrincipalPolicy(bedrockPolicy);
      pollExAppStatusFunction.role?.addToPrincipalPolicy(bedrockPolicy);
    } else {
      const assumeRolePolicy = new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['sts:AssumeRole'],
        resources: [props.crossAccountBedrockRoleArn],
      });
      invokeExAppFunction.role?.addToPrincipalPolicy(assumeRolePolicy);
      pollExAppStatusFunction.role?.addToPrincipalPolicy(assumeRolePolicy);
    }

    NagSuppressions.addResourceSuppressions(
      invokeExAppFunction.role!,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'The resource condition is specified in the IAM policy.',
          appliesTo: [
            `Resource::<${Stack.of(this).getLogicalId(artifactsBucket.node.defaultChild as s3.CfnBucket)}.Arn>/*`,
          ],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'CloudWatch PutMetricData requires wildcard resource access.',
          appliesTo: ['Resource::*'],
        },
      ],
      true,
    );

    // GET /exapps/histories
    const listInvokeExAppHisotriesFunction = this.createTeamAccessControlFunction(
      'ListInvokeExAppHisotries',
      './lambda/listInvokeExAppHistories.ts',
      1024,
    );

    // GET /exapps/history
    const getInvokeExAppHistoryFunction = this.createTeamAccessControlFunction(
      'GetInvokeExAppHistory',
      './lambda/getInvokeExAppHistory.ts',
    );

    // GET /teams/{id}/users
    const listTeamUsersFunction = this.createTeamAccessControlFunction(
      'ListTeamUsers',
      './lambda/listTeamUsers.ts',
      1024,
    );

    // GET /teams/{id}/users/{id}
    const getTeamUserFunction = this.createTeamAccessControlFunction(
      'GetTeamUser',
      './lambda/getTeamUser.ts',
    );

    // POST /teams/{id}/users
    const createTeamUserFunction = this.createTeamAccessControlFunction(
      'CreateTeamUser',
      './lambda/createTeamUser.ts',
    );
    createTeamUserFunction.addEnvironment(
      'ALLOWED_SIGN_UP_EMAIL_DOMAINS_STR',
      JSON.stringify(props.allowedSignUpEmailDomains),
    );
    this.addCognitoAdminPolicy(createTeamUserFunction);

    // PUT /teams/{id}/users/{id}
    const updateTeamUserFunction = this.createTeamAccessControlFunction(
      'UpdateTeamUser',
      './lambda/updateTeamUser.ts',
    );
    updateTeamUserFunction.addEnvironment(
      'ALLOWED_SIGN_UP_EMAIL_DOMAINS_STR',
      JSON.stringify(props.allowedSignUpEmailDomains),
    );
    this.addCognitoAdminPolicy(updateTeamUserFunction);

    // DELETE /teams/{id}/users/{id}
    const deleteTeamUserFunction = this.createTeamAccessControlFunction(
      'DeleteTeamUser',
      './lambda/deleteTeamUser.ts',
    );
    this.addCognitoAdminPolicy(deleteTeamUserFunction);

    /** API Gateway */
    const commonAuthorizerProps = {
      authorizationType: AuthorizationType.COGNITO,
      authorizer,
    };

    const teamsResource = api.root.addResource('teams');

    // POST: /teams
    teamsResource.addMethod(
      'POST',
      new LambdaIntegration(createTeamFunction),
      commonAuthorizerProps,
    );
    // GET: /teams
    teamsResource.addMethod('GET', new LambdaIntegration(listTeamsFunction), commonAuthorizerProps);
    const teamIdResource = teamsResource.addResource('{teamId}');
    // GET: /teams/{id}
    teamIdResource.addMethod('GET', new LambdaIntegration(getTeamFunction), commonAuthorizerProps);
    // PUT: /teams/{id}
    teamIdResource.addMethod(
      'PUT',
      new LambdaIntegration(updateTeamFunction),
      commonAuthorizerProps,
    );
    // DELETE: /teams/{id}
    teamIdResource.addMethod(
      'DELETE',
      new LambdaIntegration(deleteTeamFunction),
      commonAuthorizerProps,
    );

    // GET: /teams/{id}/raw
    const teamIdRawResource = teamIdResource.addResource('raw');
    teamIdRawResource.addMethod(
      'GET',
      new LambdaIntegration(getRawTeamFunction),
      commonAuthorizerProps,
    );

    const teamExAppsResource = teamIdResource.addResource('exapps');

    // POST: /teams/{id}/exapps
    teamExAppsResource.addMethod(
      'GET',
      new LambdaIntegration(listTeamExAppsFunction),
      commonAuthorizerProps,
    );

    // POST: /teams/{id}/exapps
    teamExAppsResource.addMethod(
      'POST',
      new LambdaIntegration(createExAppFunction),
      commonAuthorizerProps,
    );

    const teamExAppIdResource = teamExAppsResource.addResource('{exAppId}');

    // PUT: /teams/{id}/exapps/{id}
    teamExAppIdResource.addMethod(
      'PUT',
      new LambdaIntegration(updateExAppFunction),
      commonAuthorizerProps,
    );
    // DELETE: /teams/{id}/exapps/{id}
    teamExAppIdResource.addMethod(
      'DELETE',
      new LambdaIntegration(deleteExAppFunction),
      commonAuthorizerProps,
    );
    // GET: /teams/{id}/exapps/{id}
    teamExAppIdResource.addMethod(
      'GET',
      new LambdaIntegration(getExAppFunction),
      commonAuthorizerProps,
    );

    const teamExAppRawIdResource = teamExAppIdResource.addResource('raw');
    // GET: /teams/{id}/exapps/{id}
    teamExAppRawIdResource.addMethod(
      'GET',
      new LambdaIntegration(getRawTeamExAppFunction),
      commonAuthorizerProps,
    );

    const teamExAppCopyResource = teamExAppIdResource.addResource('copy');
    // POST: /teams/{id}/exapps/{id}/copy
    teamExAppCopyResource.addMethod(
      'POST',
      new LambdaIntegration(copyExAppFunction),
      commonAuthorizerProps,
    );

    const teamExAppHistoryDeleteResource = teamExAppIdResource.addResource('history');
    // DELETE: /teams/{id}/exapps/{id}/history
    teamExAppHistoryDeleteResource.addMethod(
      'DELETE',
      new LambdaIntegration(deleteExAppInvokeHistoryFunction),
      commonAuthorizerProps,
    );

    const teamUsersResource = teamIdResource.addResource('users');

    // GET: /teams/{id}/users
    teamUsersResource.addMethod(
      'GET',
      new LambdaIntegration(listTeamUsersFunction),
      commonAuthorizerProps,
    );
    // POST: /teams/{id}/users
    teamUsersResource.addMethod(
      'POST',
      new LambdaIntegration(createTeamUserFunction),
      commonAuthorizerProps,
    );

    const teamUserIdResource = teamUsersResource.addResource('{userId}');

    // GET: /teams/{id}/users/{id}
    teamUserIdResource.addMethod(
      'GET',
      new LambdaIntegration(getTeamUserFunction),
      commonAuthorizerProps,
    );

    // PUT: /teams/{id}/users/{id}
    teamUserIdResource.addMethod(
      'PUT',
      new LambdaIntegration(updateTeamUserFunction),
      commonAuthorizerProps,
    );

    // DELETE: /teams/{id}/users/{id}
    teamUserIdResource.addMethod(
      'DELETE',
      new LambdaIntegration(deleteTeamUserFunction),
      commonAuthorizerProps,
    );

    const exAppsResource = api.root.addResource('exapps');

    // GET: /exapps
    exAppsResource.addMethod(
      'GET',
      new LambdaIntegration(listExAppsFunction),
      commonAuthorizerProps,
    );

    // POST: /exapps/invoke
    exAppsResource.addResource('invoke').addMethod(
      'POST',
      new LambdaIntegration(invokeExAppFunction, {
        timeout: Duration.seconds(props.exAppInvokeTimeoutSeconds),
      }),
      commonAuthorizerProps,
    );

    // GET: /exapps/histories
    exAppsResource.addResource('histories').addMethod(
      'GET',
      new LambdaIntegration(listInvokeExAppHisotriesFunction, {
        timeout: Duration.seconds(props.exAppInvokeTimeoutSeconds),
      }),
      commonAuthorizerProps,
    );

    // GET: /exapps/history
    exAppsResource.addResource('history').addMethod(
      'GET',
      new LambdaIntegration(getInvokeExAppHistoryFunction, {
        timeout: Duration.seconds(props.exAppInvokeTimeoutSeconds),
      }),
      commonAuthorizerProps,
    );

    // GET: /exapps/artifact-file
    exAppsResource
      .addResource('artifact-file')
      .addMethod('GET', new LambdaIntegration(getArtifactFileFunction), commonAuthorizerProps);

    this.api = api;
    this.invokeExAppFunction = invokeExAppFunction;
    this.getArtifactFileFunction = getArtifactFileFunction;

    /** cdk-nag */
    NagSuppressions.addResourceSuppressions(
      api,
      [
        {
          id: 'AwsSolutions-APIG2',
          reason: 'Request validation is implemented in each lambda functions.',
        },
        {
          id: 'AwsSolutions-IAM4',
          reason: 'Need to use managed policy to make code simple.',
        },
        {
          id: 'AwsSolutions-APIG3',
          reason: 'WAF will be associated in GenerativeAiUseCasesStack',
        },
      ],
      true,
    );
    NagSuppressions.addStackSuppressions(
      Stack.of(this),
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'Need to use managed policy to make code simple.',
        },
        {
          id: 'AwsSolutions-L1',
          reason:
            'NODEJS_24_X is the latest runtime but cdk-nag has not yet been updated to recognize it.',
        },
      ],
      true,
    );
    NagSuppressions.addStackSuppressions(
      Stack.of(this),
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'DynamoDB wants index/* and this workload could not detect specific secrets manager resource arn when it is deployed. KMS wildcard permissions are required for data key generation and re-encryption operations.',
          appliesTo: [
            'Resource::*',
            `Resource::<${Stack.of(this).getLogicalId(this.table.node.defaultChild as ddb.CfnTable)}.Arn>/index/*`,
            `Resource::arn:aws:execute-api:${Stack.of(this).region}:${Stack.of(this).account}:<${Stack.of(this).getLogicalId(this.api.node.defaultChild as CfnRestApi)}>/<${Stack.of(this).getLogicalId(this.api.deploymentStage.node.defaultChild as CfnStage)}>/*/*`,
            {
              regex: `/^Resource::arn:aws:secretsmanager:${Stack.of(this).region}:${Stack.of(this).account}:secret:.*$/g`,
            },
            'Action::kms:GenerateDataKey*',
            'Action::kms:ReEncrypt*',
          ],
        },
      ],
      true,
    );
    NagSuppressions.addResourceSuppressions(
      table,
      [
        {
          id: 'AwsSolutions-DDB3',
          reason:
            'PITR is enabled but cdk-nag could not check the resource that was override by addPropertyOverride method.',
        },
      ],
      true,
    );
    NagSuppressions.addResourceSuppressions(
      exAppTable,
      [
        {
          id: 'AwsSolutions-DDB3',
          reason:
            'PITR is enabled but cdk-nag could not check the resource that was override by addPropertyOverride method.',
        },
      ],
      true,
    );
    NagSuppressions.addResourceSuppressions(
      invokeExAppHistoryTable,
      [
        {
          id: 'AwsSolutions-DDB3',
          reason:
            'PITR is enabled but cdk-nag could not check the resource that was override by addPropertyOverride method.',
        },
      ],
      true,
    );
  }

  createTeamAccessControlFunction(
    id: string,
    entry: string,
    memorySize: number = 256,
  ): NodejsFunction {
    const lambdaFunc = new NodejsFunction(this, id, {
      runtime: Runtime.NODEJS_24_X,
      entry,
      timeout: Duration.seconds(15),
      memorySize,
      environment: {
        TABLE_NAME: this.table.tableName,
        EXAPP_TABLE_NAME: this.exAppTable.tableName,
        INVOKE_HISTORY_TABLE_NAME: this.invokeExAppHistoryTable.tableName,
        APP_ENV: this.appEnv,
        [EXAPP_INVOKABLE_HOSTNAMES_ENV]: this.exAppInvokableHostnamesJson,
        ...this.costConversionEnv,
      },
    });
    this.table.grantReadWriteData(lambdaFunc);
    this.exAppTable.grantReadWriteData(lambdaFunc);
    this.invokeExAppHistoryTable.grantReadWriteData(lambdaFunc);
    return lambdaFunc;
  }

  addSecretsManagerPolicy(lambdaFunc: NodejsFunction): void {
    // ポリシー1: リスト操作（全Secretを対象）
    lambdaFunc.addToRolePolicy(
      new PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:ListSecrets'],
        resources: ['*'],
      }),
    );

    // ポリシー2: 読み取り・削除操作（移行期間中は全てのSecretにアクセス可能）
    // 移行完了後は、resourcesを新命名規則のみ（${this.appEnv}/*）に変更することで環境分離を強化できる
    lambdaFunc.addToRolePolicy(
      new PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DeleteSecret'],
        resources: [
          `arn:aws:secretsmanager:${Stack.of(this).region}:${Stack.of(this).account}:secret:*`,
        ],
      }),
    );

    // ポリシー3: 書き込み・更新操作（新命名規則のみ）
    // 新規作成を${appEnv}/*に制限することで環境分離を実現
    const writeResources = this.appEnv
      ? [
          // 新命名規則のみ: {appEnv}/{teamId}/{exAppId}
          `arn:aws:secretsmanager:${Stack.of(this).region}:${Stack.of(this).account}:secret:${this.appEnv}/*`,
        ]
      : [
          // appEnvなしの場合（後方互換性）
          `arn:aws:secretsmanager:${Stack.of(this).region}:${Stack.of(this).account}:secret:*`,
        ];

    lambdaFunc.addToRolePolicy(
      new PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'secretsmanager:CreateSecret',
          'secretsmanager:PutSecretValue',
          'secretsmanager:TagResource',
        ],
        resources: writeResources,
      }),
    );
  }

  addCognitoReadOnlyPolicy(lambdaFunc: NodejsFunction): void {
    lambdaFunc.addToRolePolicy(
      new PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cognito-idp:ListUsers'],
        resources: [
          `arn:aws:cognito-idp:${Stack.of(this).region}:${Stack.of(this).account}:userpool/${this.userPoolId}`,
        ],
      }),
    );
    lambdaFunc.addEnvironment('USER_POOL_ID', this.userPoolId);
  }
  addCognitoAdminPolicy(lambdaFunc: NodejsFunction): void {
    lambdaFunc.addToRolePolicy(
      new PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'cognito-idp:ListUsers',
          'cognito-idp:AdminAddUserToGroup',
          'cognito-idp:AdminRemoveUserFromGroup',
          'cognito-idp:AdminDeleteUser',
        ],
        resources: [
          `arn:aws:cognito-idp:${Stack.of(this).region}:${Stack.of(this).account}:userpool/${this.userPoolId}`,
        ],
      }),
    );
    lambdaFunc.addEnvironment('USER_POOL_ID', this.userPoolId);
  }
}
