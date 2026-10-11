import {fileURLToPath} from 'node:url';
import {evaluate, messageFor, HOURS} from './engine.mjs';
import {collect} from './probes.mjs';
import {stateStore} from './state.mjs';
import {sendMail, checkMailDelivery} from './mail.mjs';
export function environmentConfig(env = process.env) {
  return {databaseUrl: env.MONITOR_DATABASE_URL, onrezaToken: env.MONITOR_ONREZA_TOKEN,
    mailToken: env.MONITOR_NOTISEND_KEY, mailFrom: env.MONITOR_FROM_EMAIL,
    recipient: env.MONITOR_RECIPIENT, repo: env.GITHUB_REPOSITORY,
    token: env.GITHUB_TOKEN, key: env.MONITOR_STATE_KEY};
}
export async function run(config, {store = stateStore(config), probe = collect,
  mail = sendMail, delivery = checkMailDelivery, now = Date.now(), testEmail = false} = {}) {
  let state = await store.load();
  // Outstanding email survives failed mail transport, process death, and runner replacement.
  // Aggregate unsent events; one attempt per run, no raw mail response in logs.
  const observations = await probe(config);
  state = evaluate(state, observations, now, {testEmail});
  let deliveryStatus = 'none', deliveryFailed = false;
  if (state.mailReceipt) {
    const result = await delivery(config, state.mailReceipt);
    deliveryStatus = result.status;
    deliveryFailed = result.failed || (
      ['queued', 'sent'].includes(result.status) && now - state.mailReceipt.submittedAt > HOURS);
    state.mailReceipt.status = result.status;
    state.mailReceipt.checkedAt = now;
  }
  if (state.pending.length > 500) throw new Error('Monitoring outbox requires intervention');
  await store.save(state); // Persist outbox before attempting delivery.
  let accepted = false;
  const incident = Object.values(state.checks).some(x => x.active);
  const urgent = incident && (!state.incidentAcceptedAt || now - state.incidentAcceptedAt >= .5 * HOURS);
  if (state.pending.length && (!deliveryFailed || testEmail) &&
      (!state.mailAcceptedAt || now - state.mailAcceptedAt >= .5 * HOURS || urgent || testEmail)) {
    const receipt = await mail(config, messageFor(state.pending));
    accepted = true;
    state.pending = [];
    state.mailAcceptedAt = now;
    if (receipt?.messageId) state.mailReceipt = {
      messageId: receipt.messageId, status: receipt.status, submittedAt: now,
    };
    deliveryStatus = receipt?.status || 'accepted';
    deliveryFailed = false;
    if (incident) state.incidentAcceptedAt = now;
    await store.save(state);
  }
  if (deliveryFailed) {
    // Keep collecting and saving availability/budget state even if email is broken.
    // Do not retry into a bounce every five minutes. Native Actions failure is visible.
    const error = new Error('Monitoring email delivery not confirmed');
    error.code = 'MONITOR_EMAIL_DELIVERY_FAILED';
    throw error;
  }
  return {checksPassed: Object.values(observations).filter(x => x.ok).length,
    checksTotal: 5, accepted, deliveryStatus};
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await run(environmentConfig(), {testEmail: process.env.MONITOR_TEST_EMAIL === 'true'});
    // No amounts, recipient, raw errors, DB addresses or response bodies in public logs.
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error?.code === 'MONITOR_EMAIL_DELIVERY_FAILED' ?
      'Monitoring email delivery failed or status unavailable. Checks and queued notices were saved. Verify the sender; use test_email only after fixing delivery.' :
      'Club monitoring failed. Check private configuration and GitHub workflow status; no sensitive error details recorded.');
    process.exitCode = 1;
  }
}
