// Administrative tool only: never executed by the monitor workflow itself.
// Responses, credentials and provider error bodies must not be printed.
import {fileURLToPath} from 'node:url';
import {privateRunReport} from './diagnostics.mjs';
import {environmentConfig} from './run.mjs';
import {stateStore} from './state.mjs';

export const REPO = 'kozlovheritage/club-fabrika-monitor';
const GITHUB = `https://api.github.com/repos/${REPO}`;
const CRON = 'https://api.cron-job.org';
export const DISPATCH_URL = `${GITHUB}/actions/workflows/monitor.yml/dispatches`;
export const JOB_TITLE = 'Club monitor - external five-minute dispatch';
const MINUTES = Array.from({length: 12}, (_, i) => i * 5);
const BODY = JSON.stringify({ref: 'main', inputs: {test_email: false}});

// Read-only, operator-local command. Never run in public CI or upload its output.
export async function readPrivateReport(env = process.env, store) {
  if (env.GITHUB_ACTIONS === 'true' || (env.CI && env.CI !== 'false')) {
    throw new Error('Private diagnostics are disabled in CI');
  }
  try {
    store ??= stateStore({...environmentConfig(env), repo: REPO});
    return privateRunReport(await store.load());
  } catch {
    throw new Error('Private diagnostic report unavailable; check protected configuration and monitor release');
  }
}

function githubHeaders(token) {
  if (typeof token !== 'string' || !token || /\s/.test(token)) {
    throw new Error('GitHub dispatch credential missing or malformed');
  }
  return {Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28'};
}

export function jobConfiguration(token) {
  return {title: JOB_TITLE, url: DISPATCH_URL, enabled: true, saveResponses: false,
    requestMethod: 1, requestTimeout: 20, redirectSuccess: false,
    auth: {enable: false},
    // Do not send to an unverified cron account email. Independent heartbeat
    // notifications are a separate, owner-approved setup.
    notification: {onFailure: false, onSuccess: false, onDisable: false,
      onSslCertExpiry: false, mode: 0, selectedChannels: []},
    schedule: {timezone: 'UTC', expiresAt: 0, hours: [-1], mdays: [-1],
      minutes: [...MINUTES], months: [-1], wdays: [-1]},
    extendedData: {headers: githubHeaders(token), body: BODY}};
}

function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

export function verifyConfiguration(job, token) {
  const expected = jobConfiguration(token);
  const actualHeaders = Object.fromEntries(Object.entries(job?.extendedData?.headers || {})
    .map(([key, value]) => [key.toLowerCase(), value]));
  return !!job && ['title', 'url', 'enabled', 'saveResponses', 'requestMethod',
    'requestTimeout', 'redirectSuccess'].every(key => job[key] === expected[key]) &&
    Object.entries(expected.schedule).every(([key, value]) => same(job.schedule?.[key], value)) &&
    job.auth?.enable === false && job.notification?.mode === 0 &&
    ['onFailure', 'onSuccess', 'onDisable', 'onSslCertExpiry']
      .every(key => job.notification?.[key] === false) &&
    job.extendedData?.body === BODY &&
    Object.keys(actualHeaders).length === Object.keys(expected.extendedData.headers).length &&
    Object.entries(expected.extendedData.headers)
      .every(([key, value]) => actualHeaders[key.toLowerCase()] === value);
}

export function schedulerClient(env = process.env, fetcher = fetch) {
  const token = env.CLUB_MONITOR_DISPATCH_TOKEN;
  const ghHeaders = githubHeaders(token);
  if (!env.CRON_JOB_ORG_API_KEY || /\s/.test(env.CRON_JOB_ORG_API_KEY)) {
    throw new Error('Cron API credential missing or malformed');
  }
  const cronHeaders = {Authorization: `Bearer ${env.CRON_JOB_ORG_API_KEY}`,
    'Content-Type': 'application/json'};
  async function request(provider, path, {method = 'GET', body, logs = false} = {}) {
    try {
      const r = await fetcher((provider === 'GitHub' ? GITHUB : CRON) + path, {
        method, headers: provider === 'GitHub' ? ghHeaders : cronHeaders,
        redirect: logs ? 'follow' : 'error', signal: AbortSignal.timeout(20000),
        ...(body ? {body: JSON.stringify(body)} : {}),
      });
      if (!r.ok) throw new Error(`${provider} HTTP ${r.status}`);
      return logs ? await r.text() : r.status === 204 ? null : await r.json();
    } catch (error) {
      // A fetch error can contain a signed redirect URL. Never forward it.
      throw new Error(/^(GitHub|Cron) HTTP \d{3}$/.test(error?.message || '') ?
        error.message : `${provider} request unavailable`);
    }
  }
  async function find() {
    const list = await request('Cron', '/jobs');
    if (list.someFailed !== false || !Array.isArray(list.jobs)) {
      throw new Error('Cron listing incomplete; no changes made');
    }
    const matches = list.jobs.filter(job => job.url === DISPATCH_URL);
    if (matches.length > 1) throw new Error('Duplicate monitor schedules; no changes made');
    if (matches[0] && matches[0].title !== JOB_TITLE) {
      throw new Error('Existing schedule is not managed by this tool; no changes made');
    }
    return matches[0]?.jobId;
  }
  async function details(jobId) {
    if (!Number.isSafeInteger(jobId) || jobId <= 0) throw new Error('Invalid cron job ID');
    return (await request('Cron', `/jobs/${jobId}`)).jobDetails;
  }
  return {
    async configure() {
      const id = await find();
      const workflow = await request('GitHub', '/actions/workflows/monitor.yml');
      if (workflow.state !== 'active') throw new Error('Monitor workflow is not active');
      // Explicit admin check, not evidence of an automatic run. No test email.
      await request('GitHub', '/actions/workflows/monitor.yml/dispatches',
        {method: 'POST', body: {ref: 'main', inputs: {test_email: false}}});
      const result = await request('Cron', id ? `/jobs/${id}` : '/jobs',
        {method: id ? 'PATCH' : 'PUT', body: {job: jobConfiguration(token)}});
      const jobId = id || result?.jobId;
      if (!verifyConfiguration(await details(jobId), token)) {
        throw new Error('Schedule readback mismatch; inspect existing schedule before retrying');
      }
      return {jobId, enabled: true, intervalMinutes: 5, responsesSaved: false};
    },
    async inspect() {
      const jobId = await find();
      if (!jobId) throw new Error('External monitor schedule not found');
      const job = await details(jobId);
      if (!verifyConfiguration(job, token)) throw new Error('External schedule configuration mismatch');
      const history = await request('Cron', `/jobs/${jobId}/history`);
      const runs = await request('GitHub',
        '/actions/workflows/monitor.yml/runs?event=workflow_dispatch&per_page=50');
      if (!Array.isArray(history.history) || !Array.isArray(runs.workflow_runs)) {
        throw new Error('Execution history incomplete');
      }
      const executions = [];
      for (const h of history.history.slice(0, 5)) {
        const candidates = runs.workflow_runs.filter(r => r.event === 'workflow_dispatch' &&
          r.head_branch === 'main' &&
          Date.parse(r.created_at) >= h.date * 1000 - 1000 &&
          Date.parse(r.created_at) <= h.date * 1000 + 120000);
        const r = candidates.length === 1 ? candidates[0] : null;
        let checkedAt = null, summary = null;
        if (r?.status === 'completed') {
          const jobs = await request('GitHub', `/actions/runs/${r.id}/jobs`);
          if (jobs.total_count === 1 && jobs.jobs?.length === 1) {
            const job = jobs.jobs[0];
            checkedAt = job.steps?.find(s => s.name === 'Read-only club checks and aggregated email')?.started_at;
            if (job.conclusion === 'success') {
              const log = await request('GitHub', `/actions/jobs/${job.id}/logs`, {logs: true});
              summary = safeRunSummary(log);
            }
          }
        }
        executions.push({plannedAt: new Date(h.datePlanned * 1000).toISOString(),
          dispatchedAt: new Date(h.date * 1000).toISOString(),
          dispatchOk: h.status === 1 && h.httpStatus === 204,
          runId: r?.id || null, conclusion: r?.conclusion || null,
          checkedAt: checkedAt || null, summary});
      }
      return {observedAt: new Date().toISOString(), jobId, configurationOk: true, executions};
    },
  };
}

export function safeRunSummary(log) {
  for (const line of log.split('\n').reverse()) {
    const start = line.indexOf('{"checksPassed":');
    if (start < 0) continue;
    try {
      const v = JSON.parse(line.slice(start).trim());
      if (!Number.isInteger(v.checksPassed) || v.checksPassed < 0 ||
          v.checksPassed > 5 || v.checksTotal !== 5 ||
          typeof v.accepted !== 'boolean' || typeof v.emailDeliveryOk !== 'boolean' ||
          !['none', 'queued', 'sent', 'delivered', 'skipped', 'soft_bounced',
            'hard_bounced', 'unavailable', 'accepted'].includes(v.deliveryStatus)) continue;
      return {checksPassed: v.checksPassed, checksTotal: 5, accepted: v.accepted,
        deliveryStatus: v.deliveryStatus, emailDeliveryOk: v.emailDeliveryOk};
    } catch { /* Ignore raw log content. */ }
  }
  return null;
}

export function regularityEvidence(snapshot, since, count = 3) {
  if (!Number.isFinite(Date.parse(since)) || !Number.isInteger(count) || count < 3) {
    throw new Error('Evidence requires a valid cutoff and at least three runs');
  }
  const executions = snapshot.executions.filter(x => Date.parse(x.plannedAt) >= Date.parse(since))
    .sort((a, b) => Date.parse(a.plannedAt) - Date.parse(b.plannedAt)).slice(-count);
  const gaps = executions.slice(1).map((x, i) =>
    (Date.parse(x.checkedAt) - Date.parse(executions[i].checkedAt)) / 1000);
  const uniqueRuns = new Set(executions.map(x => x.runId)).size === count;
  const confirmed = snapshot.configurationOk === true && executions.length === count && uniqueRuns &&
    executions.every(x => x.dispatchOk && x.runId && x.conclusion === 'success' &&
      Number.isInteger(x.summary?.checksPassed) &&
      x.summary.checksPassed >= 0 && x.summary.checksPassed <= 5 &&
      x.summary.checksTotal === 5 && x.summary.emailDeliveryOk === true &&
      x.summary?.deliveryStatus === 'delivered' &&
      Number.isFinite(Date.parse(x.checkedAt)) &&
      Date.parse(x.checkedAt) >= Date.parse(x.plannedAt) - 1000 &&
      Date.parse(x.checkedAt) - Date.parse(x.plannedAt) <= 180000) &&
    executions.slice(1).every((x, i) =>
      Date.parse(x.plannedAt) - Date.parse(executions[i].plannedAt) === 300000) &&
    gaps.every(seconds => seconds >= 240 && seconds <= 360);
  // Cadence is not health. A completed run that detects an outage must still
  // count as a real check; expose probe health separately, never hide it.
  const allChecksHealthy = executions.length === count &&
    executions.every(x => x.summary?.checksPassed === 5);
  return {confirmed, allChecksHealthy, targetIntervalSeconds: 300, toleranceSeconds: 60,
    checkIntervalsSeconds: gaps.map(x => Number.isFinite(x) ? x : null), executions};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2];
    if (mode === 'private-report') console.log(JSON.stringify(await readPrivateReport()));
    else if (mode === 'configure') console.log(JSON.stringify(await schedulerClient().configure()));
    else if (mode === 'inspect' || mode === 'verify') {
      const snapshot = await schedulerClient().inspect();
      const result = mode === 'verify' ? regularityEvidence(snapshot, process.argv[3]) : snapshot;
      console.log(JSON.stringify(result));
      if (mode === 'verify' && !result.confirmed) process.exitCode = 1;
    } else throw new Error('Use configure, inspect, private-report, or verify followed by an ISO cutoff');
  } catch {
    // Never print an untrusted message, including malformed provider JSON errors.
    console.error('Monitor administration failed. Check protected configuration, command and release; no sensitive details recorded.');
    process.exitCode = 1;
  }
}
