import {fileURLToPath} from 'node:url';
import {evaluate, messageFor, HOURS} from './engine.mjs';
import {collect} from './probes.mjs';
import {stateStore} from './state.mjs';
import {sendMail, checkMailDelivery} from './mail.mjs';
import {diagnosticReport, monitorError, publicFailureCode, DELIVERY_STATUSES} from './diagnostics.mjs';
export function environmentConfig(env = process.env) {
  return {databaseUrl: env.MONITOR_DATABASE_URL,
    mailToken: env.MONITOR_NOTISEND_KEY, mailFrom: env.MONITOR_FROM_EMAIL,
    recipient: env.MONITOR_RECIPIENT, repo: env.GITHUB_REPOSITORY,
    token: env.GITHUB_TOKEN, key: env.MONITOR_STATE_KEY};
}
export async function run(config, {store, probe = collect,
  mail = sendMail, delivery = checkMailDelivery, now = Date.now(), testEmail = false} = {}) {
  let state, report, stage = 'MONITOR_STATE_LOAD_FAILED';
  async function save() {
    stage = 'MONITOR_STATE_SAVE_FAILED';
    state.diagnostic = report;
    await store.save(state);
  }
  try {
    store ??= stateStore(config);
    state = await store.load();
    // Outstanding email survives failed mail transport, process death, and runner replacement.
    // Aggregate unsent events; one attempt per run, no raw mail response in logs.
    stage = 'MONITOR_PROBES_FAILED';
    const observations = await probe(config);
    const previous = state;
    stage = 'MONITOR_POLICY_FAILED';
    state = evaluate(previous, observations, now, {testEmail});
    report = diagnosticReport(observations, previous, state, now);
    let deliveryStatus = 'none', deliveryFailed = false;
    function updateMail(accepted) {
      report.mail = {accepted, deliveryStatus,
        emailDeliveryOk: ['delivered', 'none'].includes(deliveryStatus)};
    }
    if (state.mailReceipt) {
      stage = 'MONITOR_MAIL_STATUS_FAILED';
      const result = await delivery(config, state.mailReceipt);
      if (!DELIVERY_STATUSES.includes(result?.status) || typeof result.failed !== 'boolean') {
        throw monitorError(stage);
      }
      deliveryStatus = result.status;
      deliveryFailed = result.failed || (
        ['queued', 'sent'].includes(result.status) && now - state.mailReceipt.submittedAt > HOURS);
      state.mailReceipt.status = result.status;
      state.mailReceipt.checkedAt = now;
    }
    updateMail(false);
    // Do not turn a single transient status-API problem into an incident.
    state.mailStatusReadFailures = deliveryStatus === 'unavailable' ?
      (state.mailStatusReadFailures || 0) + 1 : 0;
    if (deliveryStatus === 'unavailable' && state.mailStatusReadFailures < 2) deliveryFailed = false;
    if (['delivered', 'none'].includes(deliveryStatus)) state.mailFailureSignalledAt = null;
    stage = 'MONITOR_POLICY_FAILED';
    if (state.pending.length > 500) throw monitorError(stage);
    let accepted = false;
    const incident = Object.values(state.checks).some(x => x.active);
    const urgent = incident && (!state.incidentAcceptedAt || now - state.incidentAcceptedAt >= .5 * HOURS);
    // Do not overwrite an undelivered receipt with another: that would hide a
    // continually queued sender under a stream of newer accepted messages.
    const mailReady = !state.mailReceipt || deliveryStatus === 'delivered' || testEmail;
    if (state.pending.length && mailReady && (!deliveryFailed || testEmail) &&
        (!state.mailAcceptedAt || now - state.mailAcceptedAt >= .5 * HOURS || urgent || testEmail)) {
      await save(); // Persist outbox and private diagnostic before attempting delivery.
      stage = 'MONITOR_MAIL_SUBMISSION_FAILED';
      const receipt = await mail(config, messageFor(state.pending));
      if (receipt && (!receipt.messageId || !['queued', 'sent', 'delivered'].includes(receipt.status))) {
        throw monitorError(stage);
      }
      accepted = true;
      state.pending = [];
      state.mailAcceptedAt = now;
      if (receipt?.messageId) state.mailReceipt = {
        messageId: receipt.messageId, status: receipt.status, submittedAt: now,
      };
      deliveryStatus = receipt?.status || 'accepted';
      deliveryFailed = false;
      if (incident) state.incidentAcceptedAt = now;
      updateMail(accepted);
    }
    if (deliveryFailed) {
      // Keep collecting and saving availability state even if email is broken.
      // Do not retry into a bounce every five minutes. Native Actions failure is visible.
      if (!state.mailFailureSignalledAt || now - state.mailFailureSignalledAt >= 6 * HOURS) {
        state.mailFailureSignalledAt = now;
        stage = 'MONITOR_EMAIL_DELIVERY_FAILED';
        throw monitorError(stage);
      }
    }
    report.jobStatus = 'completed';
    updateMail(accepted);
    await save();
    return {checksPassed: report.checksPassed,
      checksTotal: report.checksTotal, accepted, deliveryStatus,
      emailDeliveryOk: ['delivered', 'none'].includes(deliveryStatus),
      mailOperationalOk: !deliveryFailed};
  } catch {
    // Never carry a provider's message, cause, stack or code across this boundary.
    const failure = monitorError(stage);
    if (state && report && stage !== 'MONITOR_STATE_SAVE_FAILED') {
      report.jobStatus = 'failed';
      report.failureCode = failure.code;
      if (['MONITOR_MAIL_STATUS_FAILED', 'MONITOR_MAIL_SUBMISSION_FAILED'].includes(stage)) {
        report.mail = {accepted: false, deliveryStatus: 'unavailable', emailDeliveryOk: false};
      }
      state.diagnostic = report;
      try {await store.save(state);} catch {throw monitorError('MONITOR_STATE_SAVE_FAILED');}
    }
    throw failure;
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await run(environmentConfig(), {testEmail: process.env.MONITOR_TEST_EMAIL === 'true'});
    if (!result.emailDeliveryOk) console.warn('::warning::Email delivery incident remains open or status is unconfirmed. Notices remain queued; failure reminders are limited to six-hour intervals.');
    // No amounts, recipient, raw errors, DB addresses or response bodies in public logs.
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error('Club monitor operational failure: ' + publicFailureCode(error));
    console.error(error?.code === 'MONITOR_EMAIL_DELIVERY_FAILED' ?
      'Monitoring email delivery failed or status unavailable. Checks and queued notices were saved. Verify the sender; use test_email only after fixing delivery.' :
      'Club monitoring failed. Check private configuration and GitHub workflow status; no sensitive error details recorded.');
    process.exitCode = 1;
  }
}
