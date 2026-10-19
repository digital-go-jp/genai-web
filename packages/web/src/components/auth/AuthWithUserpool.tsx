import { Authenticator, translations, useAuthenticator } from '@aws-amplify/ui-react';
import { Amplify, type AmplifyContext } from 'aws-amplify';
import { type SignInInput, signIn } from 'aws-amplify/auth';
import { I18n } from 'aws-amplify/utils';
import React, { useEffect, useRef } from 'react';
import { APP_TITLE } from '@/constants';
import {
  isCustomPasswordResetEnabled,
  PASSWORD_POLICY,
  PASSWORD_POLICY_ERROR_MESSAGE,
  PASSWORD_RESET_COMPLETE_PATH,
  PASSWORD_RESET_REQUEST_PATH,
} from '@/features/password-reset/constants';
import { PageTitle } from '../PageTitle';
import { Button } from '../ui/dads/Button';

const selfSignUpEnabled: boolean = import.meta.env.VITE_APP_SELF_SIGN_UP_ENABLED === 'true';
const emailMfaRequired: boolean = import.meta.env.VITE_APP_EMAIL_MFA_REQUIRED === 'true';
const samlAuthEnabled: boolean = import.meta.env.VITE_APP_SAMLAUTH_ENABLED === 'true';
const customPasswordResetEnabled = isCustomPasswordResetEnabled(emailMfaRequired, samlAuthEnabled);
const passwordPolicyMinimumLengthErrorKey = `Password must have at least ${PASSWORD_POLICY.minLength} characters`;
const passwordPolicyConstraintErrorKey = `1 validation error detected: Value at 'password' failed to satisfy constraint: Member must have length greater than or equal to ${PASSWORD_POLICY.minLength}`;

export const isUserPoolPublicPath = (pathname: string, customPasswordResetEnabled: boolean) =>
  pathname === '/signed-out' ||
  (customPasswordResetEnabled &&
    (pathname === PASSWORD_RESET_REQUEST_PATH || pathname === PASSWORD_RESET_COMPLETE_PATH));

type Props = {
  children: React.ReactNode;
};

const AuthWithUserpoolContent = (props: Props) => {
  const { children } = props;

  const { route } = useAuthenticator((context) => [context.route]);
  const prevRoute = useRef<string | undefined>(undefined);

  const savedPasswordRef = useRef<string | undefined>(undefined);
  const withSavedPassword = (input: SignInInput): SignInInput => {
    if (input.password) {
      savedPasswordRef.current = input.password;
      return input;
    }

    if (savedPasswordRef.current) {
      const { options: _options, ...rest } = input;
      return { ...rest, password: savedPasswordRef.current };
    }

    return input;
  };
  const services = {
    handleSignIn: (...args: [SignInInput] | [AmplifyContext, SignInInput]) =>
      args.length === 1
        ? signIn(withSavedPassword(args[0]))
        : signIn(args[0], withSavedPassword(args[1])),
  };

  useEffect(() => {
    // 初期表示やサインアップとのタブ切り替えの際はフォーカスは移動させないために除外条件を設定
    const isIgnoredTransition =
      !prevRoute.current ||
      prevRoute.current === 'idle' ||
      prevRoute.current === 'setup' ||
      prevRoute.current === 'signUp';

    if (route === 'signIn' && !isIgnoredTransition && prevRoute.current !== 'signIn') {
      // 他画面からサインイン画面に戻ってきた場合のみフォーカス
      const title = document.getElementById('auth-sign-in-header');
      title?.focus();
      window.scrollTo(0, 0);
    }
    prevRoute.current = route;
  }, [route]);

  // サインアウト後のページとカスタムパスワードリセットは認証不要でレンダリング
  if (isUserPoolPublicPath(window.location.pathname, customPasswordResetEnabled)) {
    return <>{children}</>;
  }

  return (
    <Authenticator
      hideSignUp={!selfSignUpEnabled}
      services={services}
      components={{
        Header: () => {
          return (
            <>
              <PageTitle title={`サインイン${APP_TITLE ? ` | ${APP_TITLE}` : ''}`} />
              <h1 className='mt-8 mb-6 flex justify-center text-std-32B-150 text-solid-gray-900'>
                ここにロゴが入る
              </h1>
            </>
          );
        },
        SignIn: {
          Header() {
            return (
              <h2
                id='auth-sign-in-header'
                tabIndex={-1}
                className='mx-8 mt-8 text-std-24B-150 text-solid-gray-800 focus-visible:rounded-4 focus-visible:bg-yellow-300 focus-visible:ring-[calc(2/16*1rem)] focus-visible:ring-yellow-300 focus-visible:outline-4 focus-visible:outline-offset-[calc(2/16*1rem)] focus-visible:outline-black focus-visible:outline-solid'
              >
                サインイン
              </h2>
            );
          },
          ...(customPasswordResetEnabled
            ? {
                Footer() {
                  return (
                    <div className='my-4 text-center'>
                      <Button variant='text' size='lg' asChild>
                        <a href={PASSWORD_RESET_REQUEST_PATH}>パスワードをお忘れですか？</a>
                      </Button>
                    </div>
                  );
                },
              }
            : {}),
        },
        SignUp: {
          Header() {
            return (
              <h2 className='mx-8 mt-8 text-std-24B-150 text-solid-gray-800 focus-visible:rounded-4 focus-visible:bg-yellow-300 focus-visible:ring-[calc(2/16*1rem)] focus-visible:ring-yellow-300 focus-visible:outline-4 focus-visible:outline-offset-[calc(2/16*1rem)] focus-visible:outline-black focus-visible:outline-solid'>
                アカウントを作る
              </h2>
            );
          },
        },
        ForgotPassword: {
          Header() {
            const ref = useRef<HTMLHeadingElement>(null);

            useEffect(() => {
              ref.current?.focus();
            }, []);
            return (
              <>
                <h2
                  ref={ref}
                  tabIndex={-1}
                  className='text-std-24B-150 text-solid-gray-800 focus-visible:rounded-4 focus-visible:bg-yellow-300 focus-visible:ring-[calc(2/16*1rem)] focus-visible:ring-yellow-300 focus-visible:outline-4 focus-visible:outline-offset-[calc(2/16*1rem)] focus-visible:outline-black focus-visible:outline-solid'
                >
                  パスワードを再設定
                </h2>
                <p className='mb-2 text-solid-gray-700'>
                  登録しているメールアドレスを入力してください。確認コードを送信します
                </p>
              </>
            );
          },
        },
        ConfirmResetPassword: {
          Header() {
            const ref = useRef<HTMLHeadingElement>(null);

            useEffect(() => {
              ref.current?.focus();
            }, []);
            return (
              <>
                <h2
                  ref={ref}
                  tabIndex={-1}
                  className='text-std-24B-150 text-solid-gray-800 focus-visible:rounded-4 focus-visible:bg-yellow-300 focus-visible:ring-[calc(2/16*1rem)] focus-visible:ring-yellow-300 focus-visible:outline-4 focus-visible:outline-offset-[calc(2/16*1rem)] focus-visible:outline-black focus-visible:outline-solid'
                >
                  パスワードを再設定
                </h2>
                <p className='mb-2 text-solid-gray-800'>
                  登録しているメールアドレスに送信された6桁の確認コードを入力し、新しいパスワードを設定してください
                </p>
              </>
            );
          },
        },
      }}
      formFields={{
        signIn: {
          username: {
            placeholder: '',
          },
          password: {
            placeholder: '',
          },
        },
        forgotPassword: {
          username: {
            placeholder: '',
          },
        },
        confirmResetPassword: {
          confirmation_code: {
            placeholder: '',
          },
          password: {
            placeholder: '',
          },
          confirm_password: {
            placeholder: '',
          },
        },
      }}
    >
      {children}
    </Authenticator>
  );
};

export const AuthWithUserpool = (props: Props) => {
  const { children } = props;

  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: import.meta.env.VITE_APP_USER_POOL_ID,
        userPoolClientId: import.meta.env.VITE_APP_USER_POOL_CLIENT_ID,
        identityPoolId: import.meta.env.VITE_APP_IDENTITY_POOL_ID,
      },
    },
  });

  I18n.putVocabularies(translations);
  I18n.setLanguage('ja');

  I18n.putVocabularies({
    ja: {
      Username: 'メールアドレス',
      'Password cannot be empty': 'パスワードは必須入力です',
      'password is required to signIn': 'パスワードは必須です',
      'User does not exist.': 'ユーザー名またはパスワードが違います',
      'Incorrect username or password.': 'ユーザー名またはパスワードが違います',
      'username is required to signIn': 'メールアドレスは必須です',
      'Username cannot be empty': 'メールアドレスは必須です',
      'username is required to resetPassword': 'メールアドレスは必須です',
      'Username/client id combination not found.': 'メールアドレスが登録されていません',
      'confirmationCode is required to confirmResetPassword': '確認コードは必須です',
      'newPassword is required to confirmResetPassword': '新しいパスワードは必須です',
      'Invalid verification code provided, please try again.':
        '無効な確認コードです。もう一度お試しください。',
      'Your passwords must match': 'パスワードが一致していません',
      [passwordPolicyMinimumLengthErrorKey]: PASSWORD_POLICY_ERROR_MESSAGE,
      'Password does not conform to policy: Password not long enough':
        PASSWORD_POLICY_ERROR_MESSAGE,
      'Password does not conform to policy: Password must have uppercase characters':
        PASSWORD_POLICY_ERROR_MESSAGE,
      'Password does not conform to policy: Password must have lowercase characters':
        PASSWORD_POLICY_ERROR_MESSAGE,
      'Password does not conform to policy: Password must have numeric characters':
        PASSWORD_POLICY_ERROR_MESSAGE,
      'Password does not conform to policy: Password must have symbol characters':
        PASSWORD_POLICY_ERROR_MESSAGE,
      [passwordPolicyConstraintErrorKey]: PASSWORD_POLICY_ERROR_MESSAGE,
      "1 validation error detected: Value at 'password' failed to satisfy constraint: Member must have length greater than or equal to 6":
        PASSWORD_POLICY_ERROR_MESSAGE,
      'Attempt limit exceeded, please try after some time.':
        '試行回数の上限を超えました。しばらくしてから再度お試しください。',
      // MFA 関連
      'Confirm MFA Code': '認証コードの確認',
      Code: '認証コード',
      Confirm: '確認',
      'Code *': '認証コード *',
      'Please confirm your Code': '認証コードを入力してください',
      'Invalid code or auth state for the user.': '認証コードが無効です。もう一度お試しください。',
      'Code mismatch': '認証コードが一致しません',
      'Invalid session for the user, session is expired.':
        'セッションが期限切れです。もう一度サインインしてください。',
      'The verification code you entered is incorrect. Please try again.':
        '入力された確認コードが正しくありません。もう一度お試しください。',
      'An error occurred during the sign in process. This most likely occurred due to: 1. signIn was not called before confirmSignIn. 2. signIn threw an exception. 3. page was refreshed during the sign in flow and session has expired.':
        'サインインのセッションが無効になりました。ページを再読み込みして、もう一度サインインしてください。',
      '\n\t\t\tAn error occurred during the sign in process.\n\n\t\t\tThis most likely occurred due to:\n\t\t\t1. signIn was not called before confirmSignIn.\n\t\t\t2. signIn threw an exception.\n\t\t\t3. page was refreshed during the sign in flow and session has expired.\n\t\t\t':
        'サインインのセッションが無効になりました。ページを再読み込みして、もう一度サインインしてください。',
    },
  });

  return (
    <Authenticator.Provider>
      <AuthWithUserpoolContent>{children}</AuthWithUserpoolContent>
    </Authenticator.Provider>
  );
};
