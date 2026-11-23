import test from 'node:test';
import assert from 'node:assert/strict';
import {postHeartbeat, WATCHDOG_KEY} from './heartbeat.mjs';
import {execute} from './monitored-run.mjs';

const token = 'test-telemetry-only';
const healthy = {checksPassed: 4, checksTotal: 4, accepted: false,
  deliveryStatus: 'delivered', emailDeliveryOk: true, mailOperationalOk: true};

test('heartbeat sends only a fixed monitor identifier and tick/fail state', async () => {
  for (const state of ['tick', 'fail']) {
    const calls = [];
    assert.equal(await postHeartbeat(state, {token, fetcher: async (url, options) => {
      calls.push({url, options}); return {ok: true};
    }}), true);
    assert.equal(calls.length, 1);
    const url = new URL(calls[0].url);
    assert.equal(url.origin, 'https://cronitor.link');
    assert.equal(url.pathname, `/p/${token}/${WATCHDOG_KEY}`);
    assert.equal(url.search, '?state=' + state);
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.body, undefined);
  }
});
test('missing credentials, arbitrary states, redirects and provider exceptions cannot leak or fake success', async () => {
  let requests = 0;
  const fail = async () => {requests++; throw new Error('PRIVATE_TOKEN_AND_URL');};
  assert.equal(await postHeartbeat('tick', {token: '', fetcher: fail}), false);
  assert.equal(await postHeartbeat('customer-data', {token, fetcher: fail}), false);
  assert.equal(requests, 0);
  assert.equal(await postHeartbeat('tick', {token, fetcher: fail, wait: async () => {}}), false);
  assert.equal(requests, 2);
  assert.equal(await postHeartbeat('tick', {token, fetcher: async () => ({ok: false}),
    wait: async () => {}}), false);
});
test('successful tick occurs only after the real worker finishes and persists its result', async () => {
  const order = [];
  const result = await execute({}, {token, monitor: async () => {
    order.push('saved'); return healthy;
  }, signal: async state => {order.push(state); return true;}});
  assert.deepEqual(order, ['saved', 'tick']);
  assert.equal(result.watchdogConfirmed, true);
});
test('failed platform probes do not imply a dead monitoring worker', async () => {
  const signals = [];
  await execute({}, {token, monitor: async () => ({...healthy, checksPassed: 0}),
    signal: async state => {signals.push(state); return true;}});
  assert.deepEqual(signals, ['tick']);
});
test('checkpoint and probe failures report failure, never a healthy heartbeat', async () => {
  const signals = [];
  const failure = Object.assign(new Error('PRIVATE_STATE_DETAIL'), {code: 'MONITOR_STATE_LOAD_FAILED'});
  await assert.rejects(execute({}, {token, monitor: async () => {throw failure;},
    signal: async state => {signals.push(state); return true;}}), failure);
  assert.deepEqual(signals, ['fail']);
});
test('email-delivery failure remains visible but does not mark the worker watchdog red', async () => {
  const signals = [];
  const result = await execute({}, {token, monitor: async () => ({...healthy,
    deliveryStatus: 'unavailable', emailDeliveryOk: false, mailOperationalOk: false,
    deliveryDiagnostic:'NOTISEND_HTTP_401'}),
  signal: async state => {signals.push(state); return true;}});
  assert.deepEqual(signals, ['tick']);
  assert.equal(result.watchdogConfirmed, true);
  assert.equal(result.mailOperationalOk, false);
  assert.equal(result.deliveryDiagnostic, 'NOTISEND_HTTP_401');
});
test('saved mail-only failures keep a green worker signal and expose only safe summary fields', async () => {
  const signals = [];
  const result = await execute({}, {token, monitor: async () => {throw Object.assign(
    new Error('private provider response'), {code:'MONITOR_EMAIL_DELIVERY_FAILED',
      checksPassed:3, checksTotal:4, deliveryStatus:'hard_bounced',
      emailDeliveryOk:false, deliveryDiagnostic:'MESSAGE_HARD_BOUNCED',
      recipient:'private@example.test'});},
  signal: async state => {signals.push(state); return true;}});
  assert.deepEqual(signals, ['tick']);
  assert.deepEqual(result, {checksPassed:3, checksTotal:4, accepted:false,
    deliveryStatus:'hard_bounced', emailDeliveryOk:false, mailOperationalOk:false,
    deliveryDiagnostic:'MESSAGE_HARD_BOUNCED', watchdogConfirmed:true});
  assert.equal(JSON.stringify(result).includes('private'), false);
});
test('failed heartbeat submission fails visibly without discarding the completed worker result', async () => {
  let persisted = false;
  await assert.rejects(execute({}, {token,
    monitor: async () => {persisted = true; return healthy;},
    signal: async () => false}), {code: 'MONITOR_HEARTBEAT_FAILED'});
  assert.equal(persisted, true);
});
