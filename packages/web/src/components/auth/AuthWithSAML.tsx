import { useAuthenticator } from '@aws-amplify/ui-react';
import { Amplify } from 'aws-amplify';
import { signInWithRedirect } from 'aws-amplify/auth';
import React, { useEffect, useId, useState } from 'react';
import { Button } from '../ui/dads/Button';
import { ProgressIndicator, ProgressIndicatorSpinner } from '../ui/dads/ProgressIndicator';

const samlCognitoDomainName: string = import.meta.env.VITE_APP_SAML_COGNITO_DOMAIN_NAME;

const samlPrimaryProviderName: string = import.meta.env
  .VITE_APP_SAML_COGNITO_FEDERATED_IDENTITY_PRIMARY_PROVIDER_NAME;

type AdditionalProvider = {
  providerName: string;
  signinPath: string;
};

const samlAdditionalProviders: AdditionalProvider[] = (() => {
  const raw = import.meta.env.VITE_APP_SAML_COGNITO_FEDERATED_IDENTITY_ADDITIONAL_PROVIDER_NAMES;
  if (!raw?.trim()) return [];

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}
  return [];
})();

/**
 * 現在のURLパスから使用すべきIdPプロバイダー名を決定する
 * - /login/{signinPath} にマッチする場合: 対応する additionalProvider の providerName
 * - それ以外: primaryProviderName
 */
const normalizeSigninPath = (value: string): string =>
  value.replace(/^\/+/, '').replace(/\/+$/, '');

const resolveProviderName = (): string | undefined => {
  const path = window.location.pathname;
  const loginPrefix = '/login/';

  if (path.startsWith(loginPrefix)) {
    const signinPath = normalizeSigninPath(path.slice(loginPrefix.length));
    const matched = samlAdditionalProviders.find(
      (p) => normalizeSigninPath(p.signinPath) === signinPath,
    );
    if (matched) {
      return matched.providerName;
    }
    return undefined;
  }

  return samlPrimaryProviderName || undefined;
};

const isAdditionalProviderPath = (): boolean => {
  const path = window.location.pathname;
  const loginPrefix = '/login/';

  if (!path.startsWith(loginPrefix)) {
    return false;
  }

  const signinPath = normalizeSigninPath(path.slice(loginPrefix.length));
  return samlAdditionalProviders.some((p) => normalizeSigninPath(p.signinPath) === signinPath);
};

const isAuthSkipPath = (): boolean => {
  const path = window.location.pathname;
  return path === '/signed-out' || path === '/auth-error';
};

const hasOAuthErrorInUrl = (): boolean => {
  const params = new URLSearchParams(window.location.search);
  return params.has('error') || params.has('error_description');
};

let isAmplifyConfigured = false;

const configureAmplify = () => {
  if (isAmplifyConfigured) {
    return;
  }
  isAmplifyConfigured = true;

  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: import.meta.env.VITE_APP_USER_POOL_ID,
        userPoolClientId: import.meta.env.VITE_APP_USER_POOL_CLIENT_ID,
        identityPoolId: import.meta.env.VITE_APP_IDENTITY_POOL_ID,
        loginWith: {
          oauth: {
            domain: samlCognitoDomainName,
            scopes: ['openid', 'email', 'profile'],
            redirectSignIn: [window.location.origin],
            redirectSignOut: [`${window.location.origin}/signed-out`],
            responseType: 'code',
          },
        },
      },
    },
  });
};

type Props = {
  children: React.ReactNode;
};

export const AuthWithSAML = (props: Props) => {
  const { children } = props;
  const { authStatus } = useAuthenticator((context) => [context.authStatus]);

  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | undefined>(undefined);
  const loadingId = useId();
  const redirectingId = useId();

  const signIn = (providerName: string) => {
    signInWithRedirect({
      provider: {
        custom: providerName,
      },
    });
  };

  useEffect(() => {
    if (authStatus === 'configuring') {
      setLoading(true);
      setAuthenticated(false);
    } else if (authStatus === 'authenticated') {
      if (isAdditionalProviderPath()) {
        window.location.replace('/');
        return;
      }
      setLoading(false);
      setAuthenticated(true);
    } else {
      setLoading(false);
      setAuthenticated(false);

      if (isAuthSkipPath()) {
        return;
      }

      if (hasOAuthErrorInUrl()) {
        window.location.replace('/auth-error');
        return;
      }

      const providerName = resolveProviderName();

      if (providerName) {
        signIn(providerName);
      } else {
        setAuthError('認証プロバイダーが見つかりません');
      }
    }
  }, [authStatus]);

  configureAmplify();

  // サインアウト後・認証エラーページは認証不要でレンダリング
  if (isAuthSkipPath() && !authenticated) {
    return <>{children}</>;
  }

  if (authError) {
    return (
      <div className='fixed inset-0 m-auto grid h-screen w-screen place-content-center'>
        <div className='flex flex-col items-center gap-8' role='alert'>
          <p className='text-std-18B-160 text-error-1'>{authError}</p>
          <Button
            size='lg'
            variant='solid-fill'
            onClick={() => {
              setAuthError(undefined);
              window.location.reload();
            }}
          >
            再試行
          </Button>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className='fixed inset-0 m-auto grid h-screen w-screen place-content-center'>
        <ProgressIndicator type='stacked' aria-labelledby={loadingId}>
          <ProgressIndicatorSpinner size='lg' />
          <span id={loadingId}>読み込み中...</span>
        </ProgressIndicator>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className='fixed inset-0 m-auto grid h-screen w-screen place-content-center'>
        <ProgressIndicator type='stacked' aria-labelledby={redirectingId}>
          <ProgressIndicatorSpinner size='lg' />
          <span id={redirectingId}>ログインページにリダイレクトします</span>
        </ProgressIndicator>
      </div>
    );
  }

  return <>{children}</>;
};
