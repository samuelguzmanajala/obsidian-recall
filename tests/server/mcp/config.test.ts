import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { readMcpConfig } from '../../../src/server/mcp/config';

describe('readMcpConfig', () => {
  it('is disabled unless configured', () => {
    expect(readMcpConfig({}, '/data/recall.sqlite')).toBeUndefined();
    expect(readMcpConfig({ RECALL_PORT: '27124', RECALL_TOKEN: 'x' }, '/data/recall.sqlite')).toBeUndefined();
  });
  it('derives issuer, resource and the OAuth database path', () => {
    expect(readMcpConfig({ RECALL_MCP_PORT: '27125', RECALL_MCP_PUBLIC_URL: 'https://host.example.ts.net:10000/' }, '/data/recall.sqlite')).toEqual({
      port: 27125, host: '127.0.0.1', issuer: 'https://host.example.ts.net:10000', resource: 'https://host.example.ts.net:10000/mcp',
      oauthDb: resolve('/data/recall-oauth.sqlite'),
    });
    expect(readMcpConfig({ RECALL_MCP_PORT: '27125', RECALL_MCP_PUBLIC_URL: 'https://h.example', RECALL_MCP_OAUTH_DB: '/x/o.sqlite' }, '/d/r.sqlite')?.oauthDb)
      .toBe(resolve('/x/o.sqlite'));
  });
  it('rejects incomplete or unsafe settings', () => {
    const bad = [
      { RECALL_MCP_PORT: '27125' },
      { RECALL_MCP_PUBLIC_URL: 'https://h.example' },
      { RECALL_MCP_PORT: '0', RECALL_MCP_PUBLIC_URL: 'https://h.example' },
      { RECALL_MCP_PORT: '27124', RECALL_MCP_PUBLIC_URL: 'https://h.example' },
      { RECALL_MCP_PORT: '27125', RECALL_MCP_PUBLIC_URL: 'http://h.example' },
      { RECALL_MCP_PORT: '27125', RECALL_MCP_PUBLIC_URL: 'https://h.example/recall' },
    ];
    for (const env of bad) expect(() => readMcpConfig(env, '/d/r.sqlite'), JSON.stringify(env)).toThrow();
    expect(readMcpConfig({ RECALL_MCP_PORT: '27125', RECALL_MCP_PUBLIC_URL: 'http://localhost:27125' }, '/d/r.sqlite')?.issuer).toBe('http://localhost:27125');
  });
});
