import {CHECK_CODES, checkStatuses} from './probes.mjs';

export const DELIVERY_STATUSES = Object.freeze(['none', 'queued', 'sent', 'delivered',
  'skipped', 'soft_bounced', 'hard_bounced', 'unavailable', 'accepted']);
export const FAILURE_CODES = Object.freeze(['NONE', 'MONITOR_STATE_LOAD_FAILED',
  'MONITOR_PROBES_FAILED', 'MONITOR_POLICY_FAILED', 'MONITOR_STATE_SAVE_FAILED',
  'MONITOR_MAIL_STATUS_FAILED', 'MONITOR_MAIL_SUBMISSION_FAILED',
  'MONITOR_EMAIL_DELIVERY_FAILED', 'MONITOR_INTERNAL_FAILED']);

export function monitorError(code) {
  return Object.assign(new Error('Club monitoring operation failed'), {
    code: FAILURE_CODES.includes(code) ? code : 'MONITOR_INTERNAL_FAILED',
  });
}

// Public logs may identify only an operational stage, never a raw exception or
// private diagnostic report. An unreadable checkpoint cannot store its own error.
export function publicFailureCode(error) {
  return FAILURE_CODES.includes(error?.code) && error.code !== 'NONE' ?
    error.code : 'MONITOR_INTERNAL_FAILED';
}

function healthSummary(checks) {
  const checksPassed = Object.values(checks).filter(x => x.ok).length;
  const phases = Object.values(checks).map(x => x.phase);
  return {checksPassed, checksTotal: 5,
    health: checksPassed === 5 ? 'healthy' : checksPassed === 0 ? 'unhealthy' : 'partial',
    incidentStatus: phases.includes('incident') ? 'confirmed' :
      phases.includes('transient_failure') ? 'suspected' :
        phases.includes('recovered') ? 'recovered' : 'none'};
}

export function diagnosticReport(observations, previous, state, now) {
  const checks = checkStatuses(observations, previous, state);
  return {version: 1, checkedAt: now, jobStatus: 'running', failureCode: 'NONE',
    ...healthSummary(checks), checks,
    mail: {accepted: false, deliveryStatus: 'none', emailDeliveryOk: true}};
}

// This is a PRIVATE projection of encrypted state, not a public run-log format.
// Reconstruct every field; even a modified checkpoint cannot inject raw details.
export function privateRunReport(state) {
  const r = state?.diagnostic;
  const invalid = () => {throw new Error('Private diagnostic report unavailable or invalid');};
  if (!r || r.version !== 1 || !Number.isSafeInteger(r.checkedAt) || r.checkedAt < 0 ||
      !['running', 'completed', 'failed'].includes(r.jobStatus) ||
      !FAILURE_CODES.includes(r.failureCode) ||
      (r.jobStatus === 'failed') !== (r.failureCode !== 'NONE') ||
      !Number.isInteger(r.checksPassed) || r.checksTotal !== 5 ||
      !['healthy', 'partial', 'unhealthy'].includes(r.health) ||
      !['none', 'suspected', 'confirmed', 'recovered'].includes(r.incidentStatus) ||
      typeof r.mail?.accepted !== 'boolean' ||
      typeof r.mail?.emailDeliveryOk !== 'boolean' ||
      !DELIVERY_STATUSES.includes(r.mail?.deliveryStatus)) return invalid();
  const checks = {};
  for (const [key, code] of Object.entries(CHECK_CODES)) {
    const c = r.checks?.[key];
    if (!c || typeof c.ok !== 'boolean' || c.code !== (c.ok ? 'OK' : code) ||
        !(c.ok ? ['healthy', 'recovered'] : ['transient_failure', 'incident']).includes(c.phase)) {
      return invalid();
    }
    checks[key] = {ok: c.ok, code: c.code, phase: c.phase};
  }
  const derived = healthSummary(checks);
  if (derived.checksPassed !== r.checksPassed || derived.health !== r.health ||
      derived.incidentStatus !== r.incidentStatus ||
      r.mail.emailDeliveryOk !== ['none', 'delivered'].includes(r.mail.deliveryStatus)) return invalid();
  return {version: 1, checkedAt: r.checkedAt, jobStatus: r.jobStatus,
    failureCode: r.failureCode, checksPassed: r.checksPassed, checksTotal: 5,
    checks, health: r.health, incidentStatus: r.incidentStatus,
    mail: {accepted: r.mail.accepted, deliveryStatus: r.mail.deliveryStatus,
      emailDeliveryOk: r.mail.emailDeliveryOk}};
}
