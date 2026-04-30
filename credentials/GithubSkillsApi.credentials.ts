import type {
  ICredentialDataDecryptedObject,
  ICredentialTestRequest,
  ICredentialType,
  IHttpRequestOptions,
  INodeProperties,
} from 'n8n-workflow';

export class GithubSkillsApi implements ICredentialType {
  name = 'githubSkillsApi';
  displayName = 'GitHub Skills API';
  documentationUrl = 'https://docs.github.com/rest';

  properties: INodeProperties[] = [
    {
      displayName: 'Personal Access Token',
      name: 'token',
      type: 'string',
      typeOptions: { password: true },
      required: true,
      default: '',
      description: 'GitHub PAT with repo:read scope',
    },
    {
      displayName: 'Default Owner',
      name: 'owner',
      type: 'string',
      default: '',
      description: 'Default GitHub user/org (e.g. lucasbrito-wdt)',
    },
  ];

  test: ICredentialTestRequest = {
    request: {
      baseURL: 'https://api.github.com',
      url: '/user',
      headers: {
        Authorization: '=Bearer {{$credentials.token}}',
      },
    },
  };

  async authenticate(
    credentials: ICredentialDataDecryptedObject,
    requestOptions: IHttpRequestOptions,
  ): Promise<IHttpRequestOptions> {
    requestOptions.headers = requestOptions.headers ?? {};
    requestOptions.headers['Authorization'] = `Bearer ${credentials.token}`;
    requestOptions.headers['Accept'] = 'application/vnd.github+json';
    return requestOptions;
  }
}
