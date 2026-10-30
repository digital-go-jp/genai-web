# AI アプリ登録手順書

## 概要

デプロイ時点では AI アプリが登録されていないため、本手順に従って登録作業を実施してください。

## 前提条件

- 源内 Web の管理者権限を持つユーザーアカウント
- AWSマネジメントコンソールへのアクセス権限
- AIアプリのデプロイ完了

## 注意事項

- AI アプリ側で源内 Web の外部アプリ利用用 IP アドレスを登録する必要がある
- AI アプリは特定の IP からのリクエストのみ受け付けるよう制限されている

## 1. 源内 Web 側で外部アプリ用 IP アドレスを確認

### 1.1 使用する VPC の種類を判定

`packages/cdk/env-parameters/` 配下の使用するパラメーターファイルを確認し、`vpcIdForInvokeExApp` の指定有無を確認します。

- **指定あり** → 手順1.2（共有VPC利用）へ
- **指定なし** → 手順1.3（スタック内VPC利用）へ

### 1.2 共有VPCを利用する場合

1. `packages/cdk/env-parameters/` の使用するパラメーターファイルで VPC ID を確認

```json
// コスト最適化のため外部アプリ起動Lambdaは共有VPCを利用
vpcIdForInvokeExApp: 'vpc-12345678901234567',
```

2. [AWS VPCコンソール](https://ap-northeast-1.console.aws.amazon.com/vpcconsole/home?region=ap-northeast-1#Home:)を開く
3. サイドバーの **[NAT gateways]** に移動
4. 検索窓に手順1で確認した VPC ID を入力して検索
5. 以下の2つのサブネットを確認
   - `SharedVpcStack/InvokeExAppVpc/vpc/public-subnetSubnet1`
   - `SharedVpcStack/InvokeExAppVpc/vpc/public-subnetSubnet2`
6. 各サブネットの **"Primary public IPv4 address"** 列の値を記録します（計 2 つの IP アドレス）。

> これらの IP アドレスを外部アプリ用 IP アドレスとして使用します。

### 1.3 共有VPCを利用しない場合

1. [AWS CloudFormationコンソール](https://console.aws.amazon.com/cloudformation)を開く
2. 検索窓に **"TeamAccessControl"** と入力して対象スタックを検索
3. 対象スタックを選択
4. **[Resources]** タブを開く
5. 以下のリソース階層を展開

   ```
   TeamAccessControlStack
   └─ TeamAccessControl
      └─ InvokeExAppVpc
         └─ InvokeExAppVpc-nat-eip1

   ```

6. `Type` が `AWS::EC2::EIP` の 2 つのリソースの物理 ID を記録します（計 2 つの IP アドレス）。

> これらの IP アドレスを外部アプリ用 IP アドレスとして使用します。

## 2. AIアプリ側でIPアドレスを登録

**各AIアプリごとに以下の作業を実施**

### 2.1. Google Cloud で AI アプリを構成している場合

#### 2.1.1. IPアドレスの追加

1. 対象AIアプリの設定ファイルを開く
   - 例: `google-cloud/gemini-playground/envs/prd/locals.tf`
2. `allowed_ip_addresses` パラメーターに、手順1で取得した 2 つの IP アドレスを追加

#### 2.1.2. 再デプロイ

1. AIアプリを再デプロイ
2. Google Cloud コンソール上で API キーが生成されたら、その API キーをコピー

#### 2.1.3. 源内 Web の env-parameters の修正

対象環境の env-parameters を開き、 `exAppInvokableHostnames` 配列に、AI アプリのエンドポイントのホスト名を追加してください（例: `https://xxxx-0000-gateway-abcd1234.an.gateway.dev/invoke` なら `xxxx-0000-gateway-abcd1234.an.gateway.dev`）。`https://` やパスは付けません。エンドポイント URL の確認方法は手順2.1.4 を参照してください。  
デフォルトでは空の配列になっており、許可されていないホスト名のエンドポイントは登録・実行できません。  
ホスト名の記述形式は `packages/cdk/env-parameters/self-hosting-template.ts` を参考にしてください。  
変更したら源内 Web を再デプロイしてください。再デプロイするまで、追加したホスト名は反映されません。

> **注意: `*.gateway.dev` でまとめて許可しないでください**  
> Google Cloud API Gateway の既定のホスト名（`<ゲートウェイ ID>-<ハッシュ>.<リージョン>.gateway.dev`）は、誰でもサブドメインを作れる共有ドメインにあります。`*.gateway.dev` や `*.an.gateway.dev` のように書くと、第三者が自分のプロジェクトで作った API まで許可され、ホワイトリストの効果がほとんどなくなります。  
> ホスト名は、AI アプリごとに完全一致で追加してください。`*.` は、配下のサブドメインをすべて自組織で管理しているドメインにだけ使ってください。

#### 2.1.4. 源内 Web 側での登録

1. 源内 Web にアクセス
2. **[アカウント]** > **[チーム管理]** > **[チーム一覧]** へ移動
3. 対象チームを選択
4. **[アプリの作成]** から AI アプリを登録
   1. 手順2.1.2でコピーした API キーを使用します。
   2. エンドポイント URL やアプリ説明などは、すでにアプリが登録されている別の環境からコピーします。
   3. 別の環境からエンドポイント URL をコピーできない場合は、Google Cloud コンソールの API Gateway ページの API 一覧から対象のアプリを選択し、「ゲートウェイ」タブのゲートウェイ URL の末尾に「/invoke」を追加して使用します（例: https://xxxx-0000-gateway-abcd1234.an.gateway.dev/invoke）。

### 2.2. AWS で AI アプリを構成している場合

#### 2.2.1. API エンドポイントと API キーの取得

1. AIアプリをデプロイしている AWS アカウントの CloudFormation コンソールにアクセスします。
2. 対象のAIアプリのAPIスタックを選択
3. `Outputs` タブの `ApiEndpoint` の値を控える
4. ターミナル上で、`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`、`AWS_SESSION_TOKEN` のアクセス情報を設定します。

   ```bash
   export AWS_ACCESS_KEY_ID=""
   export AWS_SECRET_ACCESS_KEY=""
   export AWS_SESSION_TOKEN=""
   ```

5. `ApiKeyValue` の値の CLI コマンドを実行して API キーを取得します。

#### 2.2.2. 源内 Web の env-parameters の修正

対象環境の env-parameters を開き、 `exAppInvokableHostnames` 配列に、手順2.2.1で取得した API エンドポイントのホスト名を追加してください（例: `https://xxxxxxxxxx.execute-api.ap-northeast-1.amazonaws.com/prod/` なら `xxxxxxxxxx.execute-api.ap-northeast-1.amazonaws.com`）。`https://` やパスは付けません。  
デフォルトでは空の配列になっており、許可されていないホスト名のエンドポイントは登録・実行できません。  
ホスト名の記述形式は `packages/cdk/env-parameters/self-hosting-template.ts` を参考にしてください。  
変更したら源内 Web を再デプロイしてください。再デプロイするまで、追加したホスト名は反映されません。

> **注意: 共有ドメインを `*.` でまとめて許可しないでください**  
> AWS API Gateway（`<API ID>.execute-api.<リージョン>.amazonaws.com`）や Google Cloud API Gateway（`<ゲートウェイ ID>-<ハッシュ>.<リージョン>.gateway.dev`）の既定のホスト名は、誰でもサブドメインを作れる共有ドメインにあります。`*.execute-api.ap-northeast-1.amazonaws.com` や `*.gateway.dev` のように書くと、第三者が自分のアカウントで作った API まで許可され、ホワイトリストの効果がほとんどなくなります。  
> これらのホスト名は、AI アプリごとに完全一致で追加してください。`*.` は、配下のサブドメインをすべて自組織で管理しているドメインにだけ使ってください。

#### 2.2.3. 源内 Web 側での登録

1. 源内 Web にアクセス
2. **[アカウント]** > **[チーム管理]** > **[チーム一覧]** へ移動
3. 対象チームを選択
4. **[アプリの作成]** から AI アプリを登録します（手順2.2.1でコピーした API エンドポイントと API キーを使用します）。
   1. 非同期 API を使う AI アプリでは、API エンドポイントの末尾に `/requests/` を追加する必要があります。

## 3. 源内 Web 側で「おすすめアプリ」登録

### 3.1 アプリIDの取得

1. 源内 Web 画面上で AI アプリ画面を表示
2. ブラウザのURLから最後のスラッシュ以降の文字列（UUID）を取得
   - 例: `https://example.com/apps/00000000-0000-0000-0000-000000000000/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`
   - この場合のアプリID: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`

### 3.2 パラメーターファイルへの追加

1. `packages/cdk/env-parameters/` 配下の使用するパラメーターファイルを開く
2. `govais_for_homepage` 配列に、手順3.1で取得したアプリ ID を追加

```tsx
// ホーム画面用のおすすめ GovAI 情報
govais_for_homepage: [
   'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', // 例: 追加するアプリ ID
],

```

3. デプロイして設定を反映