import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizedCollection } from '../app/server/cloud/auth.ts';

const expected='fixture-operator-secret-with-at-least-thirty-two-characters';
test('accepts the configured operator credential',async()=>{
  const request=new Request('https://example.test/api/internal/collection',{headers:{'X-SafeNight-Collection-Token':expected}});
  assert.equal(await authorizedCollection(request,expected),true);
});
test('rejects a different credential despite authenticated Site access',async()=>{
  const request=new Request('https://example.test/api/internal/collection',{headers:{'X-SafeNight-Collection-Token':'a-different-fixture-operator-secret'}});
  assert.equal(await authorizedCollection(request,expected),false);
});
test('rejects missing caller credentials',async()=>{
  assert.equal(await authorizedCollection(new Request('https://example.test'),expected),false);
});
test('fails closed when operator configuration is absent',async()=>{
  const request=new Request('https://example.test',{headers:{'X-SafeNight-Collection-Token':expected}});
  assert.equal(await authorizedCollection(request,undefined),false);
});
