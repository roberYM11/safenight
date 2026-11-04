import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient, ClientFailure } from '../scripts/cloud-client.mjs';
import { drain, mirror } from '../scripts/pipeline-client.mjs';
const token = 'fixture-pipeline-client-token-0123456789';

test('does not report facility publication complete until D1 current and the pinned manifest agree', async () => {
  // Given: a successful mirror job whose final service pointer belongs to that job.
  let cursor = 0;
  const client = createClient(token, { fetch: async request => {
    if (request.method === 'GET') return Response.json(new URL(request.url).searchParams.has('job_id')
      ? { mirror_manifest_sha256: 'a'.repeat(64) } : { current: { id: 'snapshot' } });
    const input = await request.json();
    if (input.action === 'due') { cursor = 0; return Response.json({ id: 'job', status: 'running' }); }
    cursor++;
    return Response.json({ id: 'job', status: cursor === 4 ? 'succeeded' : 'running', snapshot_id: 'snapshot' });
  } });
  // When: driving the four source steps and verifying readback.
  const result = await mirror(client, 'a'.repeat(64));
  // Then: completion refers to the expected immutable manifest and current snapshot.
  assert.equal(cursor, 4); assert.equal(result.snapshot_id, 'snapshot');
  await assert.rejects(() => mirror(client, 'b'.repeat(64)), error => error instanceof ClientFailure && error.code === 'context_manifest_mismatch');
});

test('bounds outbox retries and treats a nonempty queue as incomplete', async () => {
  // Given: a worker that keeps returning pending work.
  let requests = 0;
  const client = createClient(token, { fetch: async () => { requests++; return Response.json({ status: 'pending' }); } });
  // When: the unattended runner exhausts its two-step budget.
  await assert.rejects(() => drain(client, 2), error => error instanceof ClientFailure && error.code === 'derivation_budget_exhausted');
  // Then: it stops with an explicit incomplete result rather than claiming success.
  assert.equal(requests, 2);
});
