import { StackInput } from '../lib/stack-input';

/**
 * 環境設定パラメータテンプレート
 *
 * 使用方法:
 * 1. このファイルをコピーして新しい環境設定ファイルを作成してください
 * 2. 各設定項目を自分の環境に合わせて変更してください
 * 3. センシティブな情報（認証情報、IPアドレスなど）は適切に管理してください
 */

export const selfHostingTemplateParams: Partial<StackInput> = {
  // ============================================================================
  // 基本設定
  // ============================================================================

  /**
   * 環境名
   * 必須: Yes
   * 例: 'prd', 'stg', 'dev'
   * この値はリソース名のプレフィックスとして使用されます
   */
  appEnv: 'your-environment-name',

  /**
   * ExApp（AIアプリ）が登録・実行できる API エンドポイントのホスト名ホワイトリスト
   * 必須: No（未指定・空配列は deny-all = ExApp 全停止）
   * 許可される値: ホスト完全一致 / '*.suffix' / '*'（全許可）/ { regex } (hostname 完全アンカー)
   *   文字列はホスト名だけを書く（https://・パス・ポートは書けない。ポートでは絞れず、どのポートにも一致する）
   *   日本語ドメインは punycode（xn--…）、IPv6 は角括弧付き（[2001:db8::1]）で書く。全体 253 文字・ラベル 63 文字まで
   * 例:
   *   ['api.example.com']                         … api.example.com だけを許可
   *   ['*.example.com']                           … example.com のサブドメインすべて（example.com 自体は含まない）
   *   ['example.com', '*.example.com']            … example.com とそのサブドメインすべて
   *   [{ regex: 'app-[0-9]+\\.example\\.com' }]  … app-1.example.com, app-42.example.com など
   * 注意: '*.suffix' と regex は、配下のサブドメインをすべて自組織で管理しているドメインにだけ使う。
   *       AWS API Gateway（*.execute-api.<region>.amazonaws.com）や GCP API Gateway（*.gateway.dev）は
   *       誰でもサブドメインを作れる共有ドメインなので、まとめて許可すると第三者の API まで通る。完全一致で列挙する
   * 注意: できるだけ完全一致・'*.suffix' で書く。regex では量指定子を入れ子にしない（例: '(.*\\.)*example\\.com'）。
   *       入れ子にすると、長いホスト名の登録で照合時間が指数的に増え、ExApp の Lambda が止まる
   * 注意: '*' を外してホスト名の列挙に変える前に、登録済みの全チームの AI アプリのエンドポイントを棚卸しする。
   *       列挙から漏れた AI アプリは、実行も編集もできなくなる
   */
  exAppInvokableHostnames: [],

  /**
   * ログレベル
   * 必須: Yes
   * 許可される値: 'DEBUG', 'INFO', 'WARN', 'ERROR'
   * デフォルト: 'INFO'
   * 本番環境では 'INFO' または 'WARN' を推奨
   */
  logLevel: 'INFO',

  // ============================================================================
  // 認証設定
  // ============================================================================

  /**
   * セルフサインアップ有効化
   * オプション
   * デフォルト: false
   * ユーザーが自分でアカウントを作成できるようにするかどうか
   * SAML認証を使用する場合は false に設定してください
   */
  selfSignUpEnabled: false,

  /**
   * サインアップ許可メールドメイン
   * オプション
   * デフォルト: null (全てのドメインを許可)
   * セルフサインアップを許可するメールドメインのリスト
   * 例: ['example.com', 'ministry.go.jp']
   */
  // allowedSignUpEmailDomains: ['digital.go.jp'],

  /**
   * SAML認証有効化
   * オプション
   * デフォルト: false
   * SAML 2.0による外部IdP（Identity Provider）との連携を有効にする
   * Azure AD (Entra ID) などに対応
   */
  samlAuthEnabled: false,

  /**
   * カスタムメール送信設定（Same-Account SES + Tenant）
   * オプション
   * デフォルト: null (Cognito デフォルトメール)
   * 同一アカウントの検証済み SES Domain Identity を利用してメールを送信する設定
   * SES Tenant によるレピュテーション分離、Cognito Custom Email Sender Lambda Trigger を利用
   *
   * sesIdentityName: 同一アカウントの検証済み SES Domain Identity 名
   * fromAddress: 送信元メールアドレス（SES で検証済みのドメイン）
   *
   * SES Tenant 名は appEnv から自動生成されます（genai-${appEnv} 形式）
   *
   * 設定パターン:
   * - 既存動作維持: コメントアウトのまま（customEmailSender 未設定）
   * - Custom Sender のみ: customEmailSender を設定、emailMfaRequired は false
   * - フル構成: customEmailSender + emailMfaRequired: true
   *
   * 注意: emailMfaRequired を true にする場合は customEmailSender が必須です
   *
   * 前提条件:
   * - SES Domain Identity が同一アカウントで検証済みであること
   * - 本番環境では SES サンドボックス解除が必要
   */
  // customEmailSender: {
  //   sesIdentityName: 'example.go.jp',
  //   fromAddress: 'noreply@example.go.jp',
  // },

  /**
   * Email MFA 必須化
   * オプション
   * デフォルト: false
   * true にすると userid/password ユーザーのログイン時に Email MFA を必須化
   * SAML/フェデレーテッドユーザーには適用されません（AWS仕様）
   * 注意: true にする場合は customEmailSender の設定が必須です
   */
  // emailMfaRequired: true,

  /**
   * 再認証間隔（日数）
   * オプション
   * デフォルト: 7日
   * Refresh Token の有効期間（ユーザーが認証情報を確認する周期）
   * この期間を過ぎるとユーザーは再ログインが必要になります
   * 設定可能範囲: 1〜365日
   */
  // reauthenticationIntervalDays: 7,

  /**
   * パスワードポリシー
   * オプション
   * デフォルト: minLength 8 / lowercase, uppercase, digits, symbols 全て必須
   * Cognito User Pool とカスタムパスワード再設定画面の両方に反映されます
   */
  // passwordPolicy: {
  //   minLength: 8,
  //   requireLowercase: true,
  //   requireUppercase: true,
  //   requireDigits: true,
  //   requireSymbols: true,
  // },

  /**
   * SAML Cognitoドメイン名
   * 条件付き必須: samlAuthEnabled が true の場合
   * Cognito User Pool のカスタムドメイン名
   * 例: 'your-app.auth.ap-northeast-1.amazoncognito.com'
   */
  // samlCognitoDomainName: 'your-app.auth.ap-northeast-1.amazoncognito.com',

  /**
   * SAMLフェデレーションIdPプロバイダー名
   * 条件付き必須: samlAuthEnabled が true の場合
   * Cognitoに登録したIdPの名前
   * 例: 'EntraID'
   */
  // samlCognitoFederatedIdentityProviderName: 'EntraID',

  // ============================================================================
  // セキュリティ設定
  // ============================================================================

  /**
   * 許可IPv4アドレス範囲
   * オプション
   * デフォルト: null (全てのIPアドレスを許可)
   * WAFで許可するIPv4アドレス範囲のリスト（CIDR形式）
   * null の場合、IP制限は行われません
   * 例: ['203.0.113.0/24', '198.51.100.10/32']
   */
  allowedIpV4AddressRanges: null,
  // allowedIpV4AddressRanges: [
  //   '203.0.113.0/24',        // オフィスネットワーク
  //   '198.51.100.10/32',      // 特定のIPアドレス
  // ],

  /**
   * 許可IPv6アドレス範囲
   * オプション
   * デフォルト: null (全てのIPアドレスを許可)
   * WAFで許可するIPv6アドレス範囲のリスト（CIDR形式）
   */
  allowedIpV6AddressRanges: null,
  // allowedIpV6AddressRanges: [
  //   '2001:db8::/32',
  // ],

  // ============================================================================
  // カスタムドメイン設定
  // ============================================================================

  /**
   * ホスト名
   * 条件付き必須: カスタムドメインを使用する場合
   * サブドメイン部分（例: 'genai'）
   */
  // hostName: 'genai',

  /**
   * ドメイン名
   * 条件付き必須: カスタムドメインを使用する場合
   * ベースドメイン名（例: 'example.com'）
   */
  // domainName: 'example.com',

  /**
   * Hosted Zone ID
   * 条件付き必須: useHostedZone が true の場合
   * Route 53 Hosted ZoneのID
   * 例: 'Z1234567890ABC'
   */
  // hostedZoneId: 'Z1234567890ABC',

  /**
   * 証明書ARN
   * 条件付き必須: カスタムドメインを使用する場合
   * AWS Certificate Manager（ACM）で発行したSSL/TLS証明書のARN
   * 注意: CloudFront用の証明書は us-east-1 リージョンで作成する必要があります
   * 例: 'arn:aws:acm:us-east-1:123456789012:certificate/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
   */
  // certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/your-certificate-id',

  // ============================================================================
  // VPC設定
  // ============================================================================

  /**
   * 外部アプリ起動用VPC ID
   * オプション
   * 外部アプリケーション（ExApp）を起動するLambda関数が使用するVPCのID
   * コスト最適化のため、共有VPCを使用できます
   * 例: 'vpc-0123456789abcdef0'
   */
  // vpcIdForInvokeExApp: 'vpc-0123456789abcdef0',

  // ============================================================================
  // フロントエンド設定
  // ============================================================================

  /**
   * 非表示ユースケース
   * オプション
   * デフォルトで提供される機能を非表示にする設定
   * 各機能を個別に非表示にできます
   */
  // hiddenUseCases: {
  //   generate: false,    // テキスト生成
  //   summarize: false,   // 要約
  //   editorial: false,   // 文章校正
  //   translate: false,   // 翻訳
  //   webContent: false,  // Webコンテンツ取得
  //   image: false,       // 画像生成
  //   video: false,       // 動画解析
  //   diagram: false,     // ダイアグラム生成
  // },

  /**
   * ホームページ用おすすめGovAI情報
   * オプション
   * ホームページに表示する外部アプリケーションのリスト
   * 各項目には title（タイトル）、description（説明）、exAppId（外部アプリID）が必要
   */
  govais_for_homepage: [
    // {
    //   title: 'サンプルアプリ',
    //   teamId: '00000000-0000-0000-0000-000000000000' as const,
    //   exAppId: 'your-app-id-here',
    //   description: 'このアプリの説明をここに記載',
    // },
  ],

  /**
   * トップチャット用システムプロンプト
   * オプション
   * トップページのチャット入力からチャットページに遷移する際に使用されるシステムプロンプト
   * 例: 'あなたはチャットでユーザを支援するAIアシスタントです。'
   */
  top_chat_system_prompt: `あなたはチャットでユーザを支援するAIアシスタントです。`,
  /**
   * オプション
   * トップページのチャットで使用するシステムプロンプトの表示タイトル
   * 例: 'AIアシスタント'
   */
  top_chat_system_prompt_title: 'AIアシスタント',

  // ============================================================================
  // モデル設定
  // ============================================================================

  /**
   * モデルリージョン
   * オプション
   * デフォルト: 'ap-northeast-1'
   * Amazon Bedrockのモデルを使用するリージョン
   * クロスリージョン推論を利用する場合は 'us-east-1' などを指定
   */
  modelRegion: 'ap-northeast-1',

  /**
   * モデルID一覧
   * オプション
   * デフォルト: Claude 3.5 Sonnet, Claude 3.5 Haiku, Amazon Nova models
   * 使用するBedrockモデルのIDリスト
   * 利用可能なモデルはリージョンによって異なります
   */
  modelIds: [
    'amazon.nova-lite-v1:0',
    'jp.anthropic.claude-haiku-4-5-20251001-v1:0',
    'jp.anthropic.claude-sonnet-4-5-20250929-v1:0',
  ],

  /**
   * 画像生成モデルID一覧
   * オプション
   * デフォルト: ['amazon.nova-canvas-v1:0']
   * 画像生成に使用するモデルのIDリスト
   */
  imageGenerationModelIds: ['amazon.nova-canvas-v1:0'],

  // ============================================================================
  // 監視設定
  // ============================================================================

  /**
   * 監視有効化
   * オプション
   * デフォルト: true
   * CloudWatchアラームによる監視を有効にする
   * エラー率、レイテンシなどを監視し、しきい値を超えたら通知
   */
  monitoring: true,

  /**
   * Slack通知設定
   * オプション
   * CloudWatchアラームをSlackに通知する設定
   * AWS Chatbot経由でSlackに通知されます
   */
  // slack: {
  //   enabled: false,
  //   workspaceId: 'T01234567',      // Slack Workspace ID
  //   channelId: 'C01234567',        // Slack Channel ID
  // },

  /**
   * クロスリージョンSNSトピックエクスポート名
   * オプション
   * デフォルト: 'MonitoringAlertsTopic'
   * CloudFormationエクスポート名
   * 複数リージョンで監視を行う場合に使用
   */
  // monitoringCrossRegionSnsTopicExportName: 'MonitoringAlertsTopic',

  // ============================================================================
  // メンテナンスモード
  // ============================================================================

  /**
   * メンテナンスモード有効化
   * オプション
   * デフォルト: false
   * true にすると、全てのユーザーに対してメンテナンス中の画面が表示され、サービスが利用できなくなります
   * メンテナンス作業や障害対応の際に一時的にサービスを停止するための設定
   * メンテナンス画面のカスタマイズは maintenance.html を編集してください
   */
  // maintenance: true
};
