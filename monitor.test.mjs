import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {evaluate, initialState, messageFor, HOURS} from './engine.mjs';
import {encryptState, decryptState, stateStore} from './state.mjs';
import {normalizeBilling, checkHttp, checkDatabase, checkBilling, collect, CHECK_CODES} from './probes.mjs';
import {sendMail, checkMailDelivery} from './mail.mjs';
import {run} from './run.mjs';
import {privateRunReport, publicFailureCode, FAILURE_CODES} from './diagnostics.mjs';
const now = Date.parse('2026-10-11T09:00:00Z');
const bill = {periodStart: now - 20 * 24 * HOURS, periodEnd: now + 3 * 24 * HOURS,
  gross: 91992, included: 250000, extra: 0, forecast: 102832};
const healthy = () => ({http: {ok: true}, login: {ok: true}, cabinet: {ok: true},
  database: {ok: true}, billing: {ok: true, value: {...bill}}});
const clean = () => ({...initialState(), heartbeatAt: now, lastRun: now});
test('public operational failure codes cannot expose raw exception details', () => {
  for (const code of FAILURE_CODES.filter(code => code !== 'NONE')) {
    assert.equal(publicFailureCode({code, message: 'private message', cause: 'private cause'}), code);
  }
  for (const value of [undefined, null, {}, {code: 'NONE'}, {code: 'private provider error'},
    {code: {toString: () => 'MONITOR_STATE_LOAD_FAILED'}}, {message: 'private message'}]) {
    assert.equal(publicFailureCode(value), 'MONITOR_INTERNAL_FAILED');
  }
});
test('brief failure produces no incident; two consecutive failures produce one', () => {
  const obs = healthy(); obs.database.ok = false;
  let s = evaluate(clean(), obs, now);
  assert.equal(s.pending.length, 0);
  s = evaluate(s, healthy(), now + 5 * 60000);
  assert.equal(s.pending.length, 0);
  s = evaluate(s, obs, now + 10 * 60000);
  s = evaluate(s, obs, now + 15 * 60000);
  assert.equal(s.pending.length, 1);
  s.pending = [];
  s = evaluate(s, obs, now + 20 * 60000);
  assert.equal(s.pending.length, 0);
  s = evaluate(s, healthy(), now + 25 * 60000);
  assert.match(s.pending[0].text, /восстановлено/);
});
test('simultaneous incidents aggregate and ongoing ones remind only after six hours', () => {
  const obs = healthy(); obs.http.ok = obs.login.ok = false;
  let s = evaluate(evaluate(clean(), obs, now), obs, now + 5 * 60000);
  assert.equal(s.pending.length, 1);
  assert.match(s.pending[0].text, /HTTP/); assert.match(s.pending[0].text, /Страница входа/);
  s.pending = [];
  s = evaluate(s, obs, now + 6 * HOURS + 5 * 60000);
  assert.match(s.pending[0].text, /сбой продолжается/);
});
test('thresholds use effective total budget, deduplicate and reset with period', () => {
  const obs = healthy(); obs.billing.value.gross = 220000;
  let s = evaluate(clean(), obs, now);
  assert.equal(s.budget.notifiedLevel, 85);
  s.pending = []; s = evaluate(s, obs, now + 60000); assert.equal(s.pending.length, 0);
  obs.billing.value.extra = 250000;
  s = evaluate(s, obs, now + 120000); assert.equal(s.budget.limit, 500000);
  obs.billing.value.periodStart = now; obs.billing.value.gross = 0;
  s = evaluate(s, obs, now + 180000); assert.equal(s.budget.notifiedLevel, 0);
  assert.equal(s.samples.length, 1);
});
test('forecast uses provider and daily velocity without negative reset spend', () => {
  const obs = healthy(); obs.billing.value.forecast = 270000;
  let s = evaluate(clean(), obs, now); assert.match(s.pending[0].text, /Риск исчерпания/);
  s.pending = []; s = evaluate(s, obs, now + 60000); assert.equal(s.pending.length, 0);
  const older = clean();
  older.budget.periodKey = `${bill.periodStart}/${bill.periodEnd}`;
  older.samples = [{at: now - 24 * HOURS, gross: 0}];
  obs.billing.value.gross = 150000; obs.billing.value.forecast = null;
  s = evaluate(older, obs, now); assert.ok(s.budget.latest.projected >= 250000);
});
test('stale, missing, malformed or non-RUB billing fails, never becomes zero', () => {
  const raw = {settlementProfile: 'SELF_SERVICE', period: {
    start: new Date(bill.periodStart).toISOString(), end: new Date(bill.periodEnd).toISOString()},
  projection: {status: 'FRESH', freshUntil: new Date(now + HOURS).toISOString()},
  money: {currency: 'RUB', grossUsageCents: '91992', includedUsageCreditCents: '250000',
    effectiveExtraBudgetCents: '0'}, snapshotToken: 'private-snapshot'};
  const value = normalizeBilling(raw, now);
  assert.equal(value.gross, 91992);
  assert.ok(!JSON.stringify(value).includes('private-snapshot'));
  for (const change of [
    {projection: {status: 'LAGGING'}}, {money: {...raw.money, currency: 'USD'}},
    {money: {...raw.money, grossUsageCents: null}},
    {projection: {status: 'FRESH', freshUntil: new Date(now - 1).toISOString()}},
  ]) assert.throws(() => normalizeBilling({...raw, ...change}, now));
});
test('AES-GCM rejects tampering and wrong key, encrypts all notification content', () => {
  const key = crypto.randomBytes(32).toString('base64');
  const state = clean(); state.pending = [{text: 'private-budget', id: '1'}];
  const enc = encryptState(state, key);
  assert.ok(!enc.includes('private-budget'));
  assert.deepEqual(decryptState(enc, key), state);
  assert.throws(() => decryptState(enc, crypto.randomBytes(32).toString('base64')));
  const tamper = JSON.parse(enc); tamper.data = Buffer.from('tampered').toString('base64');
  assert.throws(() => decryptState(JSON.stringify(tamper), key));
});
test('HTTP process is not DB health; login checks page and redirect stays on origin', async () => {
  assert.equal((await checkHttp('http', async () => new Response('{"ok":true}'))).ok, true);
  assert.equal((await checkHttp('login', async () => new Response('proxy placeholder'))).ok, false);
  assert.equal((await checkHttp('login', async () =>
    new Response('<h1>Фабрика</h1><input type="password"><form action="/api/auth/login">'))).ok, true);
  assert.equal((await checkHttp('cabinet', async () =>
    new Response('', {status: 302, headers: {location: '/?login=1'}}))).ok, true);
  assert.equal((await checkHttp('cabinet', async () =>
    new Response('', {status: 302, headers: {location: 'https://other.example/?login=1'}}))).ok, false);
});
test('DB query is bounded read-only, no customer fields, closes on failure', async () => {
  const queries = []; let ended = false;
  class Client {
    on() {} async connect() {} async query(sql) {queries.push(sql); return {rows: [{ok: 1}]};}
    async end() {ended = true;}
  }
  assert.equal((await checkDatabase('private://connection', Client)).ok, true);
  assert.equal(queries[0], 'BEGIN READ ONLY'); assert.ok(queries.includes('ROLLBACK'));
  assert.ok(!queries.some(x => /email|password|SELECT \*/.test(x))); assert.ok(ended);
  class Failing extends Client {async query() {throw new Error('private details');}}
  assert.deepEqual(await checkDatabase('private://connection', Failing), {ok: false});
});
test('API and mail errors never return raw bodies, accepted queued mail is not delivery', async () => {
  assert.deepEqual(await checkBilling('private-key', async () => new Response('private error', {status: 403})), {ok: false});
  const config = {mailToken: 'private-key', mailFrom: 'from@example.test', recipient: 'to@example.test'};
  await assert.rejects(sendMail(config, 'status', async () =>
    new Response('{"id":1,"status":"rejected"}')), /not accepted/);
  assert.deepEqual(await sendMail(config, 'status', async () =>
    new Response('{"id":1,"status":"queued"}')), {accepted: true, messageId: '1', status: 'queued'});
});
test('outbox saved before mail; failure keeps notification for next run', async () => {
  let saved = clean(), saves = 0;
  const store = {async load() {return saved;}, async save(s) {saved = structuredClone(s); saves++;}};
  await assert.rejects(run({}, {store, now, probe: async () => healthy(), testEmail: true,
    mail: async () => {assert.ok(saves); throw new Error('transport failed');}}));
  assert.equal(saved.pending.length, 1);
  await run({}, {store, now: now + 60000, probe: async () => healthy(), mail: async () => {}});
  assert.equal(saved.pending.length, 0); assert.equal(saved.mailAcceptedAt, now + 60000);
});
test('mail cooldown aggregates notices; healthy runs stay silent even after long gaps', async () => {
  let saved = {...clean(), mailAcceptedAt: now};
  const store = {async load() {return saved;}, async save(s) {saved = structuredClone(s);}};
  let sent = 0;
  const options = {store, probe: async () => healthy(), mail: async () => {sent++;}};
  await run({}, {...options, now: now + 60000, testEmail: true}); assert.equal(sent, 1);
  saved.pending.push({id: '2', createdAt: now, text: 'event'});
  await run({}, {...options, now: now + 2 * 60000}); assert.equal(sent, 1);
  await run({}, {...options, now: now + HOURS}); assert.equal(sent, 2);
  assert.equal(evaluate(initialState(), healthy(), now).pending.length, 0);
  const silent = evaluate(clean(), healthy(), now + 25 * HOURS);
  assert.equal(silent.pending.length, 0);
  assert.equal(silent.lastRun, now + 25 * HOURS);
  const explicit = evaluate(silent, healthy(), now + 25 * HOURS, {testEmail: true});
  assert.match(explicit.pending[0].text, /Тест уведомлений/);
  assert.match(messageFor(explicit.pending), /не контрольная покупка/);
  assert.doesNotMatch(messageFor(explicit.pending), /Если ежедневного/);
});
test('old queued routine reports are removed but mixed real warnings survive', () => {
  const state = clean();
  state.pending = [
    {id:'routine',text:'Ежедневный контроль мониторинга:\nВсе проверки пройдены.\n\nРасход 100 ₽.'},
    {id:'mixed',text:'Мониторинг возобновился после перерыва более 30 минут. Доступность клуба в перерыве неизвестна.\n\nМинимальный запрос к БД: восстановлено.\n\nБюджет: использовано 85%.\n\nЕжедневный контроль мониторинга:\nВсе проверки пройдены.\n\nРасход 100 ₽.'},
  ];
  const result = evaluate(state, healthy(), now);
  assert.equal(result.pending.length, 1);
  assert.equal(result.pending[0].id, 'mixed');
  assert.equal(result.pending[0].text, 'Минимальный запрос к БД: восстановлено.\n\nБюджет: использовано 85%.');
  assert.equal(state.pending.length, 2); // Never mutate the loaded checkpoint.
});
test('missing stored state is not silently initialized in normal operation', async () => {
  delete process.env.MONITOR_BOOTSTRAP;
  const store = stateStore({repo: 'owner/repo', token: 'private-key', key: 'key'},
    async () => new Response('', {status: 404}));
  await assert.rejects(store.load(), /state missing/);
});
test('provider delivery failures are recognized without exposing receipt or body', async () => {
  for (const status of ['soft_bounced', 'hard_bounced', 'skipped']) {
    assert.deepEqual(await checkMailDelivery({mailToken:'private-key'}, {messageId:'1'},
      async () => new Response(JSON.stringify({status, to:'private@example.test'}))),
      {status, failed:true});
  }
  assert.deepEqual(await checkMailDelivery({mailToken:'private-key'}, {messageId:'1'},
    async () => new Response('{"status":"delivered"}')), {status:'delivered', failed:false});
  assert.deepEqual(await checkMailDelivery({}, {messageId:'1'}), {status:'unavailable', failed:true});
});
test('bounced email fails visibly but still saves checks, does not resend into rejection', async () => {
  let saved = clean(), sent = 0;
  saved.mailReceipt = {messageId:'1',status:'queued',submittedAt:now};
  const store = {async load() {return saved;}, async save(s) {saved=structuredClone(s);}};
  await assert.rejects(run({}, {store, now:now+60000, probe:async()=>healthy(),
    delivery:async()=>({status:'soft_bounced',failed:true}), mail:async()=>{sent++;}}),
  {code:'MONITOR_EMAIL_DELIVERY_FAILED'});
  assert.equal(sent, 0); assert.equal(saved.lastRun, now+60000);
  assert.equal(saved.mailReceipt.status, 'soft_bounced');
  const result = await run({}, {store, now:now+120000, probe:async()=>healthy(),
    delivery:async()=>({status:'soft_bounced',failed:true}), mail:async()=>{sent++;}});
  assert.equal(result.emailDeliveryOk, false);
  assert.equal(result.deliveryStatus, 'soft_bounced');
  assert.equal(sent, 0);
});
test('queued receipt is not hidden by a newer email while notices wait', async () => {
  let saved = clean(), sent = 0;
  saved.mailReceipt = {messageId:'1',status:'queued',submittedAt:now};
  const store = {async load() {return saved;}, async save(s) {saved=structuredClone(s);}};
  const result = await run({}, {store, now:now+60000, probe:async()=>healthy(),
    delivery:async()=>({status:'queued',failed:false}), mail:async()=>{sent++;}});
  assert.equal(sent, 0); assert.equal(saved.mailReceipt.messageId, '1');
  assert.equal(result.deliveryStatus, 'queued');
  assert.equal(result.emailDeliveryOk, false);
});

const sensitive = '999999 private@example.test postgres://user:pass@host/db ' +
  'provider-secret snapshotToken https://pdf.example/doc?signature=private';
function memoryStore(state = clean()) {
  let saved = structuredClone(state);
  return {async load() {return structuredClone(saved);},
    async save(s) {saved = structuredClone(s);}, get state() {return saved;}};
}
test('private report identifies each probe, transient failure, incident and recovery without public disclosure', async () => {
  for (const [key, code] of Object.entries(CHECK_CODES)) {
    const store = memoryStore();
    const bad = healthy();
    bad[key] = {ok: false, error: sensitive, value: {snapshotToken: sensitive}};
    const options = {store, probe: async () => bad,
      mail: async () => ({messageId: 'fake', status: 'queued'})};
    const first = await run({}, {...options, now});
    assert.deepEqual(first, {checksPassed: 4, checksTotal: 5, accepted: false,
      deliveryStatus: 'none', emailDeliveryOk: true});
    let report = privateRunReport(store.state);
    assert.equal(report.jobStatus, 'completed');
    assert.equal(report.health, 'partial');
    assert.equal(report.incidentStatus, 'suspected');
    assert.deepEqual(report.checks[key], {ok: false, code, phase: 'transient_failure'});
    assert.equal(store.state.pending.length, 0);
    assert.equal(JSON.stringify(first).includes(code), false);
    assert.equal(JSON.stringify(report).includes('private'), false);

    const second = await run({}, {...options, now: now + 300000});
    report = privateRunReport(store.state);
    assert.equal(report.jobStatus, 'completed'); // Successful execution, unhealthy probe.
    assert.equal(report.incidentStatus, 'confirmed');
    assert.equal(report.checks[key].phase, 'incident');
    assert.equal(second.accepted, true);
    assert.deepEqual(report.mail, {accepted: true, deliveryStatus: 'queued', emailDeliveryOk: false});

    await run({}, {store, now: now + 600000, probe: async () => healthy(),
      delivery: async () => ({status: 'delivered', failed: false})});
    report = privateRunReport(store.state);
    assert.equal(report.health, 'healthy');
    assert.equal(report.incidentStatus, 'recovered');
    assert.deepEqual(report.checks[key], {ok: true, code: 'OK', phase: 'recovered'});
    assert.equal(report.mail.accepted, false); // Delivery of older mail, no new acceptance.
    assert.equal(report.mail.emailDeliveryOk, true);
    await run({}, {store, now: now + 900000, probe: async () => healthy(),
      delivery: async () => ({status: 'delivered', failed: false})});
    assert.equal(privateRunReport(store.state).incidentStatus, 'none');
  }
});
test('a lone failure clears silently; mixed recovery and active outage remain distinct', async () => {
  const store = memoryStore();
  const bad = healthy(); bad.database.ok = false;
  await run({}, {store, now, probe: async () => bad});
  await run({}, {store, now: now + 300000, probe: async () => healthy()});
  assert.equal(privateRunReport(store.state).incidentStatus, 'none');
  assert.equal(store.state.pending.length, 0); // Not a confirmed recovery notice.
  bad.http.ok = false;
  const options = {store, probe: async () => bad,
    mail: async () => ({messageId: 'fake', status: 'queued'})};
  await run({}, {...options, now: now + 600000});
  await run({}, {...options, now: now + 900000});
  bad.database.ok = true;
  await run({}, {...options, now: now + 1200000,
    delivery: async () => ({status: 'queued', failed: false})});
  const report = privateRunReport(store.state);
  assert.equal(report.incidentStatus, 'confirmed');
  assert.equal(report.checks.database.phase, 'recovered');
  assert.equal(report.checks.http.phase, 'incident');
});
test('all failing probes are unhealthy, and nonboolean truthy status is never a pass', async () => {
  const store = memoryStore();
  await run({}, {store, now, probe: async () => Object.fromEntries(
    Object.keys(CHECK_CODES).map(key => [key, {ok: 'true', error: sensitive}]))});
  const report = privateRunReport(store.state);
  assert.equal(report.health, 'unhealthy');
  assert.equal(report.checksPassed, 0);
  assert.equal(report.incidentStatus, 'suspected');
});
test('exceptions at operational boundaries have fixed codes and no raw message, cause or stack', async () => {
  const fail = () => {throw Object.assign(new Error(sensitive), {code: sensitive, cause: sensitive});};
  for (const [options, code] of [
    [{store: {load: fail}}, 'MONITOR_STATE_LOAD_FAILED'],
    [{probe: fail}, 'MONITOR_PROBES_FAILED'],
    [{store: {...memoryStore(), save: fail}}, 'MONITOR_STATE_SAVE_FAILED'],
    [{testEmail: true, mail: fail}, 'MONITOR_MAIL_SUBMISSION_FAILED'],
    [{testEmail: true, mail: async () => ({messageId: sensitive, status: sensitive})},
      'MONITOR_MAIL_SUBMISSION_FAILED'],
  ]) {
    const store = memoryStore();
    await assert.rejects(run({}, {store, now, probe: async () => healthy(), ...options}), error => {
      assert.equal(error.code, code);
      assert.equal(error.cause, undefined);
      assert.equal(error.stack.includes(sensitive), false);
      return true;
    });
    if (code === 'MONITOR_MAIL_SUBMISSION_FAILED') {
      const report = privateRunReport(store.state);
      assert.equal(report.jobStatus, 'failed');
      assert.equal(report.failureCode, code);
      assert.equal(report.health, 'healthy'); // Mail failure is not club downtime.
      assert.equal(report.mail.emailDeliveryOk, false);
      assert.equal(store.state.pending.length, 1);
    }
  }
});
test('delivery failure report survives thrown job and reminder-suppressed successful job', async () => {
  const state = clean();
  state.mailReceipt = {messageId: 'fake', submittedAt: now, status: 'queued'};
  const store = memoryStore(state);
  const options = {store, probe: async () => healthy(),
    delivery: async () => ({status: 'hard_bounced', failed: true})};
  await assert.rejects(run({}, {...options, now}), {code: 'MONITOR_EMAIL_DELIVERY_FAILED'});
  let report = privateRunReport(store.state);
  assert.equal(report.jobStatus, 'failed');
  assert.equal(report.failureCode, 'MONITOR_EMAIL_DELIVERY_FAILED');
  assert.equal(report.health, 'healthy');
  assert.equal(report.mail.emailDeliveryOk, false);
  await run({}, {...options, now: now + 300000});
  report = privateRunReport(store.state);
  assert.equal(report.jobStatus, 'completed');
  assert.equal(report.failureCode, 'NONE');
  assert.equal(report.mail.emailDeliveryOk, false);
});
test('diagnostic projection strips unapproved fields and rejects injected status/error codes', async () => {
  const store = memoryStore();
  await run({}, {store, now, probe: async () => healthy()});
  const state = store.state;
  state.diagnostic.secret = state.diagnostic.mail.recipient = sensitive;
  state.diagnostic.checks.http.error = sensitive;
  state.diagnostic.checks.extra = {ok: true, error: sensitive};
  const report = privateRunReport(state);
  assert.equal(JSON.stringify(report).includes(sensitive), false);
  assert.equal(Object.keys(report.checks).length, 5);
  const key = crypto.randomBytes(32).toString('base64');
  const encrypted = encryptState(state, key);
  assert.equal(encrypted.includes('HTTP_FAILED'), false);
  assert.deepEqual(privateRunReport(decryptState(encrypted, key)), report);
  for (const mutate of [
    r => {r.failureCode = sensitive;},
    r => {r.mail.deliveryStatus = sensitive;},
    r => {r.checks.http.code = sensitive;},
    r => {r.checks.http.phase = sensitive;},
    r => {r.checksPassed = 4;},
    r => {r.health = 'partial';},
    r => {r.mail.emailDeliveryOk = false;},
  ]) {
    const changed = structuredClone(state); mutate(changed.diagnostic);
    assert.throws(() => privateRunReport(changed), /unavailable or invalid/);
  }
  assert.throws(() => privateRunReport(clean()), /unavailable or invalid/);
});
test('probe exceptions and database adapter rejection discard all sensitive details', async () => {
  const fail = () => {throw new Error(sensitive);};
  assert.deepEqual(await checkHttp('http', fail), {ok: false});
  assert.deepEqual(await checkBilling('fake', fail), {ok: false});
  const config = {databaseUrl: sensitive, onrezaToken: sensitive};
  const observations = await collect(config, {fetcher: fail, database: fail});
  assert.deepEqual(observations, Object.fromEntries(
    Object.keys(CHECK_CODES).filter(key => key !== 'billing').map(key => [key, {ok: false}])));
});
test('live collection performs only four checks and never reads or requests billing', async () => {
  const urls = [];
  const config = {databaseUrl: 'fake'};
  Object.defineProperty(config, 'onrezaToken', {get() {throw new Error('Billing must not be used');}});
  const fetcher = async url => {
    urls.push(url);
    assert.ok(url.startsWith('https://platform-clubfabrika3.ru/'));
    if (url.endsWith('/club')) return new Response(null, {
      status: 302, headers: {location: '/?login=1'},
    });
    if (url.endsWith('/api/health')) return Response.json({ok: true});
    return new Response('Фабрика <input type="password"><form action="/api/auth/login">');
  };
  const observations = await collect(config, {fetcher, database: async () => ({ok: true})});
  assert.equal(urls.length, 3);
  assert.deepEqual(Object.keys(observations), ['http', 'login', 'cabinet', 'database']);
  assert.ok(Object.values(observations).every(value => value.ok));
  const store = memoryStore();
  const result = await run({}, {store, now, probe: async () => observations});
  assert.deepEqual(result, {checksPassed: 4, checksTotal: 4, accepted: false,
    deliveryStatus: 'none', emailDeliveryOk: true});
  const report = privateRunReport(store.state);
  assert.equal(report.health, 'healthy');
  assert.equal(report.checks.billing, undefined);
});
test('billing cutover removes only budget notices and keeps unrelated incidents and receipt evidence', async () => {
  const previous = clean();
  previous.checks.billing = {active: true, failures: 5, notifiedAt: now};
  previous.budget = {notifiedLevel: 95};
  previous.samples = [{at: now, gross: 10}];
  previous.mailReceipt = {messageId: 'fake', status: 'delivered', submittedAt: now};
  previous.pending = [
    {id: 'mixed', text: 'HTTP-процесс клуба: сбой.\n\nЧтение актуального бюджета ONREZA: сбой продолжается.\n\nБюджет: использовано 95%.\n\nРиск исчерпания бюджета до конца периода: оценка.'},
    {id: 'budget-only', text: 'Чтение актуального бюджета ONREZA: восстановлено.'},
  ];
  const core = healthy(); delete core.billing;
  const migrated = evaluate(previous, core, now + 1000);
  assert.equal(migrated.pending.length, 1);
  assert.equal(migrated.pending[0].text, 'HTTP-процесс клуба: сбой.');
  assert.equal(migrated.checks.billing, undefined);
  assert.deepEqual(migrated.budget, {});
  assert.deepEqual(migrated.samples, []);
  assert.deepEqual(migrated.mailReceipt, previous.mailReceipt);
  assert.equal(previous.pending.length, 2);
  const tested = evaluate(migrated, core, now + 2000, {testEmail: true});
  assert.doesNotMatch(tested.pending.at(-1).text, /бюджет|ONREZA/i);
  core.database = {ok: false};
  const first = evaluate(clean(), core, now);
  const second = evaluate(first, core, now + 300000);
  assert.match(second.pending[0].text, /Минимальный запрос к БД/);
});
test('private report distinguishes transient mail-status failure, confirmed failure and delivered recovery', async () => {
  const state = clean();
  state.mailReceipt = {messageId: 'fake', submittedAt: now, status: 'queued'};
  const store = memoryStore(state);
  const options = {store, probe: async () => healthy(),
    delivery: async () => ({status: 'unavailable', failed: true})};
  await run({}, {...options, now});
  assert.equal(privateRunReport(store.state).jobStatus, 'completed');
  assert.equal(privateRunReport(store.state).mail.emailDeliveryOk, false);
  await assert.rejects(run({}, {...options, now: now + 300000}),
    {code: 'MONITOR_EMAIL_DELIVERY_FAILED'});
  await run({}, {...options, now: now + 600000,
    delivery: async () => ({status: 'delivered', failed: false})});
  const report = privateRunReport(store.state);
  assert.equal(report.jobStatus, 'completed');
  assert.equal(report.mail.emailDeliveryOk, true);
  assert.equal(report.health, 'healthy');
  assert.equal(store.state.mailStatusReadFailures, 0);
});
test('thrown or malformed mail status cannot inject raw details or claim successful delivery', async () => {
  for (const delivery of [
    async () => {throw new Error(sensitive);},
    async () => ({status: sensitive, failed: true}),
  ]) {
    const state = clean();
    state.mailReceipt = {messageId: 'fake', submittedAt: now, status: 'queued'};
    const store = memoryStore(state);
    await assert.rejects(run({}, {store, now, probe: async () => healthy(), delivery}),
      {code: 'MONITOR_MAIL_STATUS_FAILED'});
    const report = privateRunReport(store.state);
    assert.equal(report.mail.deliveryStatus, 'unavailable');
    assert.equal(report.mail.emailDeliveryOk, false);
    assert.equal(JSON.stringify(report).includes(sensitive), false);
  }
});
