/*
 *  Copyright 2025 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *  SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
 *  Licensed under the Amazon Software License  http://aws.amazon.com/asl/
 */
import * as cdk from 'aws-cdk-lib';
import { NestedStack, NestedStackProps } from 'aws-cdk-lib';
import { RestApi } from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { TeamAccessControl } from './construct/team-access-control';
import { StackInput } from './stack-input';

interface TeamAccessControlStackProps extends NestedStackProps {
  encryptionKey: kms.IKey;
  userPool: cognito.UserPool;
  vpcId: string | undefined;
  logLevel: StackInput['logLevel'];
  exAppInvokeTimeoutSeconds: number;
  exAppInvokableHostnames: StackInput['exAppInvokableHostnames'];
  s3FileExpirationDays: number;
  dynamoDbTtlDays: number;
  envName?: string;
  removalPolicy?: cdk.RemovalPolicy;
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

export class TeamAccessControlStack extends NestedStack {
  public readonly api: RestApi;
  public readonly table: ddb.Table;
  public readonly exAppTable: ddb.Table;
  public readonly invokeExAppHistoryTable: ddb.Table;
  public readonly artifactsBucket: s3.Bucket;
  /** 親スタックから cognito-identity:* の IAM を付与するため公開する */
  public readonly invokeExAppFunction: NodejsFunction;
  public readonly getArtifactFileFunction: NodejsFunction;
  constructor(scope: Construct, id: string, props: TeamAccessControlStackProps) {
    super(scope, id, props);

    const allowedSignUpEmailDomains: string[] | null | undefined = this.node.tryGetContext(
      'allowedSignUpEmailDomains',
    );

    const teamAccessControl = new TeamAccessControl(this, 'TeamAccessControl', {
      encryptionKey: props.encryptionKey,
      userPool: props.userPool,
      allowedSignUpEmailDomains,
      vpcId: props.vpcId,
      logLevel: props.logLevel,
      exAppInvokeTimeoutSeconds: props.exAppInvokeTimeoutSeconds,
      exAppInvokableHostnames: props.exAppInvokableHostnames,
      s3FileExpirationDays: props.s3FileExpirationDays,
      dynamoDbTtlDays: props.dynamoDbTtlDays,
      envName: props.envName,
      removalPolicy: props.removalPolicy,
      modelRegion: props.modelRegion,
      modelIds: props.modelIds,
      crossAccountBedrockRoleArn: props.crossAccountBedrockRoleArn,
      inferenceProfileMap: props.inferenceProfileMap,
      costConversion: props.costConversion,
    });
    this.api = teamAccessControl.api;
    this.table = teamAccessControl.table;
    this.exAppTable = teamAccessControl.exAppTable;
    this.invokeExAppHistoryTable = teamAccessControl.invokeExAppHistoryTable;
    this.artifactsBucket = teamAccessControl.artifactsBucket;
    this.invokeExAppFunction = teamAccessControl.invokeExAppFunction;
    this.getArtifactFileFunction = teamAccessControl.getArtifactFileFunction;
  }
}
