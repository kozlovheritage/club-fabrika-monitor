import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {evaluate, initialState, messageFor, HOURS} from './engine.mjs';
import {encryptState, decryptState, stateStore} from './state.mjs';
import {normalizeBilling, checkHttp, checkDatabase, checkBilling} from './probes.mjs';
import {sendMail} from './mail.mjs';
import {run} from './run.mjs';
const now = Date.parse('2026-10-11T09:00:00Z');
const bill = {periodStart: now - 20 * 24 * HOURS, periodEnd: now + 3 * 24 * HOURS,
  gross: 91992, included: 250000, extra: 0, forecast: 102832};
const healthy = () => ({http: {ok: true}, login: {ok: true}, cabinet: {ok: true},
  database: {ok: true}, billing: {ok: true, value: {...bill}}});
const clean = () => ({...initialState(), heartbeatAt: now, lastRun: now});
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
    new Response('{"id":1,"status":"queued"}')), {accepted: true});
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
test('mail cooldown aggregates incidents and recovery, gap warning and daily heartbeat', async () => {
  let saved = {...clean(), mailAcceptedAt: now};
  const store = {async load() {return saved;}, async save(s) {saved = structuredClone(s);}};
  let sent = 0;
  const options = {store, probe: async () => healthy(), mail: async () => {sent++;}};
  await run({}, {...options, now: now + 60000, testEmail: true}); assert.equal(sent, 1);
  saved.pending.push({id: '2', createdAt: now, text: 'event'});
  await run({}, {...options, now: now + 2 * 60000}); assert.equal(sent, 1);
  await run({}, {...options, now: now + HOURS}); assert.equal(sent, 2);
  const daily = evaluate(clean(), healthy(), now + 25 * HOURS);
  assert.match(daily.pending[0].text, /Ежедневный/); assert.match(daily.pending[0].text, /перерыва/);
  assert.match(messageFor(daily.pending), /не контрольная покупка/);
});
test('missing stored state is not silently initialized in normal operation', async () => {
  delete process.env.MONITOR_BOOTSTRAP;
  const store = stateStore({repo: 'owner/repo', token: 'private-key', key: 'key'},
    async () => new Response('', {status: 404}));
  await assert.rejects(store.load(), /state missing/);
});
