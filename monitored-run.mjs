import {fileURLToPath} from 'node:url';
import {run, environmentConfig} from './run.mjs';
import {publicFailureCode} from './diagnostics.mjs';
import {postHeartbeat} from './heartbeat.mjs';

const heartbeatError = () => Object.assign(new Error('Watchdog signal not confirmed'),
  {code: 'MONITOR_HEARTBEAT_FAILED'});

export async function execute(config, {monitor = run, signal = postHeartbeat,
  token, monitorOptions = {}} = {}) {
  let result;
  try {
    // This resolves only after actual probes, alert policy, and checkpoint save.
    // A failed platform probe is NOT a failed monitoring worker.
    result = await monitor(config, monitorOptions);
    if (result.mailOperationalOk !== true) {
      throw Object.assign(new Error('Monitoring mail transport remains failed'),
        {code: 'MONITOR_EMAIL_DELIVERY_FAILED'});
    }
  } catch (error) {
    try {await signal('fail', {token});} catch { /* Independent timeout remains armed. */ }
    throw error;
  }
  let confirmed = false;
  try {confirmed = await signal('tick', {token});} catch { /* Do not expose raw errors. */ }
  if (!confirmed) throw heartbeatError();
  return {...result, watchdogConfirmed: true};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await execute(environmentConfig(), {
      token: process.env.MONITOR_WATCHDOG_TOKEN,
      monitorOptions: {testEmail: process.env.MONITOR_TEST_EMAIL === 'true'},
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error('Club monitor operational failure: ' +
      (error?.code === 'MONITOR_HEARTBEAT_FAILED' ? error.code : publicFailureCode(error)));
    process.exitCode = 1;
  }
}
