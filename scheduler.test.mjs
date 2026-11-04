import test from 'node:test';
import assert from 'node:assert/strict';
import {jobConfiguration, verifyConfiguration, schedulerClient, safeRunSummary,
  regularityEvidence, DISPATCH_URL, JOB_TITLE, readPrivateReport} from './scheduler.mjs';
import {run} from './run.mjs';
import {initialState} from './engine.mjs';
import {encryptState, decryptState} from './state.mjs';

const env = {CLUB_MONITOR_DISPATCH_TOKEN: 'fake-dispatch-key',
  CRON_JOB_ORG_API_KEY: 'fake-cron-key'};
const reply = (body, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), {status});

test('external schedule is fixed to the monitor, five minutes, no test mail or saved responses', () => {
  const job = jobConfiguration(env.CLUB_MONITOR_DISPATCH_TOKEN);
  assert.equal(job.url, DISPATCH_URL);
  assert.deepEqual(job.schedule.minutes, [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  assert.equal(job.enabled, true);
  assert.equal(job.saveResponses, false);
  assert.equal(job.notification.mode, 0);
  assert.equal(job.requestMethod, 1);
  assert.deepEqual(JSON.parse(job.extendedData.body), {ref: 'main', inputs: {test_email: false}});
  assert.equal(verifyConfiguration(job, env.CLUB_MONITOR_DISPATCH_TOKEN), true);
  job.extendedData.headers.authorization = job.extendedData.headers.Authorization;
  delete job.extendedData.headers.Authorization;
  assert.equal(verifyConfiguration(job, env.CLUB_MONITOR_DISPATCH_TOKEN), true);
  for (const mutate of [
    j => {j.url = 'https://elsewhere.example/';},
    j => {j.saveResponses = true;},
    j => {j.notification.mode = 1;},
    j => {j.notification.onFailure = true;},
    j => {j.extendedData.body = '{"ref":"main","inputs":{"test_email":true}}';},
    j => {j.extendedData.headers.Authorization = 'Bearer old-key';},
    j => {j.extendedData.headers.Extra = 'unexpected-secret';},
    j => {j.schedule.minutes = [0];},
  ]) {
    const modified = jobConfiguration(env.CLUB_MONITOR_DISPATCH_TOKEN);
    mutate(modified);
    assert.equal(verifyConfiguration(modified, env.CLUB_MONITOR_DISPATCH_TOKEN), false);
  }
});

test('setup reuses the existing job, proves dispatch permission, then reads back privately', async () => {
  for (const existing of [false, true]) {
    const calls = [];
    const client = schedulerClient(env, async (url, init) => {
      calls.push({url, init});
      if (url.endsWith('/jobs') && init.method === 'GET') {
        return reply({someFailed: false, jobs: existing ?
          [{jobId: 123, title: JOB_TITLE, url: DISPATCH_URL}] : []});
      }
      if (url.endsWith('/actions/workflows/monitor.yml')) return reply({state: 'active'});
      if (url === DISPATCH_URL) {
        assert.equal(init.headers.Authorization, 'Bearer fake-dispatch-key');
        return reply(null, 204);
      }
      assert.equal(init.headers.Authorization, 'Bearer fake-cron-key');
      if (init.method === 'PUT' || init.method === 'PATCH') {
        const job = JSON.parse(init.body).job;
        assert.equal(job.extendedData.headers.Authorization, 'Bearer fake-dispatch-key');
        return reply({jobId: 123});
      }
      return reply({jobDetails: {...jobConfiguration(env.CLUB_MONITOR_DISPATCH_TOKEN), jobId: 123}});
    });
    assert.deepEqual(await client.configure(),
      {jobId: 123, enabled: true, intervalMinutes: 5, responsesSaved: false});
    assert.equal(calls.filter(x => ['PUT', 'PATCH'].includes(x.init.method)).length, 1);
    assert.equal(calls[3].init.method, existing ? 'PATCH' : 'PUT');
    assert.ok(calls.every(x => x.init.redirect === 'error'));
  }
});

test('setup fails closed on incomplete, duplicate, or unrelated job listings', async () => {
  for (const list of [
    {someFailed: true, jobs: []},
    {someFailed: false, jobs: [{url: DISPATCH_URL}, {url: DISPATCH_URL}]},
    {someFailed: false, jobs: [{url: DISPATCH_URL, title: 'User-owned setup'}]},
  ]) {
    let writes = 0;
    const client = schedulerClient(env, async (url, init) => {
      if (init.method !== 'GET') writes++;
      return reply(list);
    });
    await assert.rejects(client.configure(), /no changes made/);
    assert.equal(writes, 0);
  }
});

test('denied dispatch never creates a cron job and provider secrets cannot enter errors', async () => {
  const writes = [];
  const client = schedulerClient(env, async (url, init) => {
    if (url.endsWith('/jobs')) return reply({someFailed: false, jobs: []});
    if (url === DISPATCH_URL) return new Response('private-provider-body', {status: 403});
    if (init.method !== 'GET') writes.push(url);
    return reply({state: 'active'});
  });
  await assert.rejects(client.configure(), /^Error: GitHub HTTP 403$/);
  assert.equal(writes.length, 0);
  const unavailable = schedulerClient(env, async () => {throw new Error('private-signed-url');});
  await assert.rejects(unavailable.configure(), /^Error: Cron request unavailable$/);
  assert.throws(() => schedulerClient({...env, CLUB_MONITOR_DISPATCH_TOKEN: 'bad\nkey'}), /malformed/);
});

test('run-log summary only exposes safe counters and delivery enums', () => {
  const v = {checksPassed: 5, checksTotal: 5, accepted: false,
    deliveryStatus: 'delivered', emailDeliveryOk: true};
  assert.deepEqual(safeRunSummary(`setup log\n2026-11-04T00:00:00Z ${JSON.stringify({
    ...v, recipient: 'private-recipient', secret: 'private-token',
  })}\ncleanup`), v);
  assert.equal(safeRunSummary(JSON.stringify({...v, deliveryStatus: 'private-address'})), null);
  assert.equal(safeRunSummary(JSON.stringify({...v, checksPassed: -1})), null);
  assert.equal(safeRunSummary(JSON.stringify({...v, checksPassed: 6})), null);
  assert.equal(safeRunSummary('private-provider-body'), null);
});

test('inspection correlates actual check steps, not manual runs or ambiguous dispatches', async () => {
  const at = Date.parse('2026-11-04T17:50:00Z');
  const summary = {checksPassed: 5, checksTotal: 5, accepted: false,
    deliveryStatus: 'delivered', emailDeliveryOk: true};
  const automatic = {id: 90, event: 'workflow_dispatch', head_branch: 'main',
    created_at: new Date(at + 1000).toISOString(), status: 'completed', conclusion: 'success'};
  for (const ambiguous of [false, true]) {
    let logReads = 0;
    const client = schedulerClient(env, async (url, init) => {
      if (url.endsWith('/jobs/123/history')) return reply({history: [{
        datePlanned: at / 1000, date: at / 1000 + 1, status: 1, httpStatus: 204,
        headers: 'private-headers-not-for-logs', body: 'private-response-not-for-logs',
      }]});
      if (url.endsWith('/jobs/123')) return reply({jobDetails: {
        ...jobConfiguration(env.CLUB_MONITOR_DISPATCH_TOKEN), jobId: 123,
      }});
      if (url.includes('/actions/workflows/monitor.yml/runs?')) {
        return reply({workflow_runs: [
          // Permission-test run before the cron dispatch is not counted.
          {...automatic, id: 89, created_at: new Date(at - 60000).toISOString()},
          {...automatic, id: 88, event: 'schedule'},
          automatic, ...(ambiguous ? [{...automatic, id: 91}] : []),
        ]});
      }
      if (url.endsWith('/actions/runs/90/jobs')) return reply({total_count: 1, jobs: [{
        id: 901, conclusion: 'success', steps: [{
          name: 'Read-only club checks and aggregated email',
          started_at: new Date(at + 30000).toISOString(),
        }],
      }]});
      if (url.endsWith('/actions/jobs/901/logs')) {
        logReads++;
        assert.equal(init.redirect, 'follow');
        return new Response(`setup\n2026-11-04T17:50:40Z ${JSON.stringify(summary)}\ncleanup`);
      }
      return reply({someFailed: false, jobs: [{jobId: 123, title: JOB_TITLE, url: DISPATCH_URL}]});
    });
    const inspected = await client.inspect();
    assert.equal(inspected.configurationOk, true);
    assert.equal(inspected.executions.length, 1);
    const execution = inspected.executions[0];
    assert.equal(execution.dispatchOk, true);
    assert.equal(execution.runId, ambiguous ? null : 90);
    assert.equal(execution.checkedAt, ambiguous ? null : new Date(at + 30000).toISOString());
    assert.deepEqual(execution.summary, ambiguous ? null : summary);
    assert.equal(logReads, ambiguous ? 0 : 1);
    assert.equal(JSON.stringify(inspected).includes('private-'), false);
  }
});

const start = Date.parse('2026-11-04T17:50:00Z');
function snapshot() {
  return {configurationOk: true, executions: Array.from({length: 3}, (_, i) => ({
    plannedAt: new Date(start + i * 300000).toISOString(),
    dispatchedAt: new Date(start + i * 300000 + 1000).toISOString(),
    checkedAt: new Date(start + i * 300000 + 25000).toISOString(),
    dispatchOk: true, runId: i + 1, conclusion: 'success',
    summary: {checksPassed: 5, checksTotal: 5, accepted: false,
      deliveryStatus: 'delivered', emailDeliveryOk: true},
  }))};
}

test('regularity requires three distinct consecutive automatic checks and delivery, not HTTP 204 alone', () => {
  const since = new Date(start - 1000).toISOString();
  const good = regularityEvidence(snapshot(), since);
  assert.equal(good.confirmed, true);
  assert.equal(good.allChecksHealthy, true);
  assert.deepEqual(good.checkIntervalsSeconds, [300, 300]);
  for (const mutate of [
    s => {s.executions.pop();},
    s => {s.configurationOk = false;},
    s => {s.executions[1].runId = s.executions[0].runId;},
    s => {s.executions[1].dispatchOk = false;},
    s => {s.executions[1].checkedAt = null;},
    s => {s.executions[1].conclusion = 'failure';},
    s => {s.executions[1].summary.emailDeliveryOk = false;},
    s => {s.executions[1].summary.deliveryStatus = 'queued';},
    s => {s.executions[1].summary.checksPassed = -1;},
    s => {s.executions[1].summary = null;},
    s => {s.executions[1].plannedAt = new Date(start + 600000).toISOString();},
    s => {s.executions[1].checkedAt = new Date(start + 300000 + 240000).toISOString();},
  ]) {
    const changed = snapshot(); mutate(changed);
    assert.equal(regularityEvidence(changed, since).confirmed, false);
  }
  assert.equal(regularityEvidence(snapshot(), new Date(start + 1).toISOString()).confirmed, false);
  assert.throws(() => regularityEvidence(snapshot(), 'invalid'), /valid cutoff/);
  assert.throws(() => regularityEvidence(snapshot(), since, 2), /at least three/);
});

test('regularity of completed outage checks is distinct from cabinet health', () => {
  const s = snapshot();
  for (const execution of s.executions) execution.summary.checksPassed = 4;
  const evidence = regularityEvidence(s, new Date(start - 1000).toISOString());
  assert.equal(evidence.confirmed, true);
  assert.equal(evidence.allChecksHealthy, false);
  assert.ok(evidence.executions.every(x => x.summary.checksPassed === 4));
});

test('a sustained outage enters email outbox by the second five-minute check without changing live state', async () => {
  // Isolated encrypted store and fake mail transport. No production probe,
  // network, provider write, live receipt or encrypted checkpoint is used.
  const key = Buffer.alloc(32, 42).toString('base64');
  let encrypted = encryptState(initialState(), key);
  const store = {async load() {return decryptState(encrypted, key);},
    async save(state) {encrypted = encryptState(state, key);}};
  const observations = () => ({http: {ok: true}, login: {ok: true},
    cabinet: {ok: true}, database: {ok: false}, billing: {ok: true, value: {
      periodStart: start - 86400000, periodEnd: start + 86400000,
      gross: 0, included: 250000, extra: 250000, forecast: 0,
    }}});
  const submitted = [];
  const options = {store, probe: async () => observations(), mail: async (config, text) => {
    assert.equal(decryptState(encrypted, key).pending.length, 1);
    submitted.push(text);
    return {messageId: 'isolated-test', status: 'queued'};
  }};
  await run({}, {...options, now: start});
  assert.equal(submitted.length, 0);
  await run({}, {...options, now: start + 300000});
  assert.equal(submitted.length, 1);
  assert.match(submitted[0], /два последовательных запуска/);
  assert.equal(encrypted.includes('Минимальный запрос'), false);
  assert.equal(decryptState(encrypted, key).pending.length, 0);
  const last = await run({}, {...options, now: start + 600000,
    delivery: async () => ({status: 'delivered', failed: false})});
  assert.equal(last.emailDeliveryOk, true);
  assert.equal(submitted.length, 1);
});

test('private inspection reads only encrypted report, needs no cron credentials and refuses public CI', async () => {
  const key = Buffer.alloc(32, 21).toString('base64');
  let encrypted = encryptState(initialState(), key), reads = 0;
  const store = {async load() {reads++; return decryptState(encrypted, key);},
    async save(s) {encrypted = encryptState(s, key);}};
  const observations = {http: {ok: true}, login: {ok: true}, cabinet: {ok: false},
    database: {ok: true}, billing: {ok: false}};
  await run({}, {store, now: start, probe: async () => observations});
  const report = await readPrivateReport({}, store);
  assert.equal(report.checks.cabinet.code, 'CABINET_FAILED');
  assert.equal(report.checks.billing.code, 'BILLING_FAILED');
  assert.equal(report.jobStatus, 'completed');
  const before = reads;
  for (const env of [{GITHUB_ACTIONS: 'true'}, {CI: 'true'}, {CI: '1'}]) {
    await assert.rejects(readPrivateReport(env, store), /disabled in CI/);
  }
  assert.equal(reads, before);
  const secret = 'recipient@example.test signed-url?signature=private provider-body';
  await assert.rejects(readPrivateReport({}, {async load() {throw new Error(secret);}}),
    /^Error: Private diagnostic report unavailable; check protected configuration and monitor release$/);
  // The public parser does not promote the private schema to public log output.
  assert.equal(safeRunSummary(JSON.stringify(report)), null);
  const publicSummary = {checksPassed: 3, checksTotal: 5, accepted: false,
    deliveryStatus: 'none', emailDeliveryOk: true};
  assert.deepEqual(safeRunSummary(JSON.stringify({...publicSummary, diagnostic: report,
    error: secret})), publicSummary);
});
