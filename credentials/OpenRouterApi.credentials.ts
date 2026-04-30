import type {
  ICredentialDataDecryptedObject,
  ICredentialTestRequest,
  ICredentialType,
  IHttpRequestOptions,
  INodeProperties,
} from 'n8n-workflow';

export class OpenRouterApi implements ICredentialType {
  name = 'openRouterApi';
  displayName = 'OpenRouter API';
  documentationUrl = 'https://openrouter.ai/docs';

  properties: INodeProperties[] = [
    {
      displayName: 'API Key',
      name: 'apiKey',
      type: 'string',
      typeOptions: { password: true },
      required: true,
      default: '',
    },
    {
      displayName: 'Default Model',
      name: 'model',
      type: 'string',
      default: 'qwen/qwen3-235b-a22b',
      description: 'Model ID on OpenRouter (e.g. anthropic/claude-sonnet-4-5)',
    },
    {
      displayName: 'Base URL',
      name: 'baseUrl',
      type: 'string',
      default: 'https://openrouter.ai/api/v1',
    },
    {
      displayName: 'HTTP Referer',
      name: 'httpReferer',
      type: 'string',
      default: '',
      description: 'Optional. Sent as X-Title for OpenRouter rankings.',
    },
  ];

  test: ICredentialTestRequest = {
    request: {
      baseURL: '={{$credentials.baseUrl}}',
      url: '/models',
      headers: {
        Authorization: '=Bearer {{$credentials.apiKey}}',
      },
    },
  };

  async authenticate(
    credentials: ICredentialDataDecryptedObject,
    requestOptions: IHttpRequestOptions,
  ): Promise<IHttpRequestOptions> {
    requestOptions.headers = requestOptions.headers ?? {};
    requestOptions.headers['Authorization'] = `Bearer ${credentials.apiKey}`;
    if (credentials.httpReferer) {
      requestOptions.headers['X-Title'] = credentials.httpReferer as string;
    }
    return requestOptions;
  }
}
