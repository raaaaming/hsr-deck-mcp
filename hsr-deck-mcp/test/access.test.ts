import test from 'node:test';
import assert from 'node:assert/strict';
import { accessKey, isAuthorized } from '../src/lib/access';

const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

test('접근 키: 설정이 없으면 누구나 허용', () => {
  assert.equal(accessKey({}), null);
  assert.ok(isAuthorized(req('https://x.test/mcp'), {}));
});

test('접근 키: ?key=, Bearer, x-api-key 중 하나가 맞으면 허용, 틀리거나 없으면 거절', () => {
  const env = { MCP_ACCESS_KEY: 's3cret-key-123456' };
  assert.ok(isAuthorized(req('https://x.test/mcp?key=s3cret-key-123456'), env));
  assert.ok(isAuthorized(req('https://x.test/mcp', { authorization: 'Bearer s3cret-key-123456' }), env));
  assert.ok(isAuthorized(req('https://x.test/mcp', { 'x-api-key': 's3cret-key-123456' }), env));
  assert.ok(!isAuthorized(req('https://x.test/mcp'), env));
  assert.ok(!isAuthorized(req('https://x.test/mcp?key=wrong'), env));
  assert.ok(!isAuthorized(req('https://x.test/mcp?key=s3cret-key-12345'), env), '길이가 다른 값');
  assert.ok(!isAuthorized(req('https://x.test/mcp', { authorization: 'Bearer nope' }), env));
});

test('접근 키: 이전 이름 HSR_API_KEY도 인식하고, MCP_ACCESS_KEY가 우선한다', () => {
  assert.equal(accessKey({ HSR_API_KEY: 'old' }), 'old');
  assert.equal(accessKey({ HSR_API_KEY: 'old', MCP_ACCESS_KEY: 'new' }), 'new');
  assert.ok(isAuthorized(req('https://x.test/api/call?key=old'), { HSR_API_KEY: 'old' }));
});
