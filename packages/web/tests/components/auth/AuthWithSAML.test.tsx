import { Authenticator } from '@aws-amplify/ui-react';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readOAuthItem = (name: string) => {
  const key = Object.keys(localStorage).find((k) => k.endsWith(`.${name}`));
  return key ? localStorage.getItem(key) : null;
};

const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('AuthWithSAML', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubEnv('VITE_APP_USER_POOL_ID', 'ap-northeast-1_test');
    vi.stubEnv('VITE_APP_USER_POOL_CLIENT_ID', 'test-client');
    vi.stubEnv('VITE_APP_IDENTITY_POOL_ID', 'ap-northeast-1:00000000-0000-0000-0000-000000000000');
    vi.stubEnv(
      'VITE_APP_SAML_COGNITO_DOMAIN_NAME',
      'example.auth.ap-northeast-1.amazoncognito.com',
    );
    vi.stubEnv('VITE_APP_SAML_COGNITO_FEDERATED_IDENTITY_PRIMARY_PROVIDER_NAME', 'test-idp');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('再レンダーされてもリダイレクト中のサインインを破棄しない', async () => {
    const { AuthWithSAML } = await import('@/components/auth/AuthWithSAML');
    const renderTree = () => (
      <Authenticator.Provider>
        <AuthWithSAML>
          <div />
        </AuthWithSAML>
      </Authenticator.Provider>
    );

    const { rerender } = render(renderTree());
    await screen.findByText('ログインページにリダイレクトします');
    await vi.waitFor(() => expect(readOAuthItem('inflightOAuth')).toBe('true'));

    rerender(renderTree());
    await flushAsync();

    expect(readOAuthItem('inflightOAuth')).toBe('true');
    expect(readOAuthItem('oauthState')).not.toBeNull();
    expect(readOAuthItem('oauthPKCE')).not.toBeNull();
  });
});
