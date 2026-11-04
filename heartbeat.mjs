import {fileURLToPath} from 'node:url';

export const WATCHDOG_KEY = 'club-monitor-runtime';

// Dedicated telemetry-only credential. No arbitrary host, message, recipient,
// probe details, timestamps from the checkpoint, or financial data are sent.
export async function postHeartbeat(state, {
  token, fetcher = fetch, wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  if (!['tick', 'fail'].includes(state) || typeof token !== 'string' ||
      token.length < 8 || token.length > 512 || /\s/.test(token)) return false;
  const url = `https://cronitor.link/p/${encodeURIComponent(token)}/${WATCHDOG_KEY}?state=${state}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetcher(url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      });
      if (response.ok) return true;
    } catch { /* Never log a credential-bearing URL or raw fetch error. */ }
    if (attempt === 0) await wait(1000);
  }
  return false;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ok = await postHeartbeat(process.argv[2], {token: process.env.MONITOR_WATCHDOG_TOKEN});
  console.log(ok ? 'Watchdog signal accepted.' : 'Watchdog signal not confirmed.');
  if (!ok) process.exitCode = 1;
}
