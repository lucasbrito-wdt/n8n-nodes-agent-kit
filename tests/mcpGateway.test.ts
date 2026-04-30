import { McpTool } from '../nodes/McpGateway/McpGateway.node';

// Tests for server-mode webhook tool logic (no real SSE connection needed)
describe('McpGateway server mode tool', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('{"result":"ok"}'),
    } as Response);
  });

  afterEach(() => fetchMock.mockRestore());

  function makeWebhookTool(toolName: string, webhookUrl: string): McpTool {
    return {
      name: toolName,
      description: toolName,
      inputSchema: { type: 'object', properties: { input: { type: 'string' } }, additionalProperties: true },
      call: async (args) => {
        const res = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args),
        });
        if (!res.ok) throw new Error(`Webhook error: ${res.status}`);
        return await res.text();
      },
    };
  }

  it('calls webhook URL with POST and returns response text', async () => {
    const tool = makeWebhookTool('search_leads', 'http://n8n.local/webhook/search');
    const result = await tool.call({ query: 'acme' });
    expect(result).toBe('{"result":"ok"}');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://n8n.local/webhook/search',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('sends args as JSON body', async () => {
    const tool = makeWebhookTool('send_email', 'http://n8n.local/webhook/email');
    await tool.call({ to: 'test@example.com', subject: 'Hello' });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ to: 'test@example.com', subject: 'Hello' }),
      }),
    );
  });

  it('throws on non-ok webhook response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 } as Response);
    const tool = makeWebhookTool('failing_tool', 'http://n8n.local/webhook/fail');
    await expect(tool.call({})).rejects.toThrow('Webhook error: 500');
  });

  it('tool has correct McpTool shape', () => {
    const tool = makeWebhookTool('my_tool', 'http://localhost/wh');
    expect(tool.name).toBe('my_tool');
    expect(typeof tool.call).toBe('function');
    expect(tool.inputSchema).toHaveProperty('type', 'object');
  });
});
