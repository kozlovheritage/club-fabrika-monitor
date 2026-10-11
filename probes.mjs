import pg from 'pg';
const BASE = 'https://platform-clubfabrika3.ru';
const RPC = 'https://api.onreza.ru/trpc/';
export async function checkHttp(kind, fetcher = fetch) {
  const paths = {http: '/api/health', login: '/?login=1', cabinet: '/club'};
  try {
    const r = await fetcher(BASE + paths[kind], {
      redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: {'Cache-Control': 'no-cache', 'User-Agent': 'Club-independent-monitor/1.0'},
    });
    if (kind === 'cabinet') {
      const location = r.headers.get('location');
      if (![302, 303].includes(r.status) || !location) return {ok: false};
      const target = new URL(location, BASE);
      return {ok: target.origin === BASE && target.pathname === '/' && target.searchParams.get('login') === '1'};
    }
    if (r.status !== 200) return {ok: false};
    if (kind === 'http') return {ok: (await r.json()).ok === true};
    const html = await r.text();
    return {ok: html.includes('Фабрика') && /type=["']password["']/i.test(html) &&
      /\/api\/auth\/login/.test(html)};
  } catch { return {ok: false}; }
}
export async function checkDatabase(connectionString, Client = pg.Client) {
  let client;
  try {
    if (!connectionString) return {ok: false};
    client = new Client({connectionString, ssl: {rejectUnauthorized: true},
      connectionTimeoutMillis: 8000, query_timeout: 8000, statement_timeout: 5000,
      application_name: 'club_read_only_monitor'});
    // Swallow raw async errors: pg can include addresses and connection details.
    client.on('error', () => {});
    await client.connect();
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5000ms'");
    // Read actual application tables, but never select customer data.
    await client.query('SELECT 1 FROM club_users LIMIT 0');
    await client.query('SELECT 1 FROM club_sessions LIMIT 0');
    const result = await client.query('SELECT 1 AS ok');
    await client.query('ROLLBACK');
    return {ok: result.rows[0]?.ok === 1};
  } catch { return {ok: false}; }
  finally { if (client) await client.end().catch(() => {}); }
}
export async function rpcRead(procedure, token, fetcher = fetch) {
  if (!token) throw new Error('Monitoring configuration incomplete');
  const r = await fetcher(RPC + procedure, {
    headers: {Authorization: 'Bearer ' + token}, signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error('Billing read unavailable');
  const body = await r.json();
  if (body.error || !body.result) throw new Error('Billing read unavailable');
  return body.result.data?.json ?? body.result.data;
}
const cents = value => {
  if ((typeof value !== 'string' && typeof value !== 'number') ||
      !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new Error('Billing format unsupported');
  }
  return Number(value);
};
export function normalizeBilling(raw, now = Date.now()) {
  if (raw?.settlementProfile !== 'SELF_SERVICE' || raw.money?.currency !== 'RUB' ||
      raw.projection?.status !== 'FRESH' ||
      !Number.isFinite(Date.parse(raw.projection.freshUntil)) ||
      Date.parse(raw.projection.freshUntil) < now) throw new Error('Billing snapshot not fresh');
  const periodStart = Date.parse(raw.period?.start), periodEnd = Date.parse(raw.period?.end);
  if (!Number.isFinite(periodStart) || !Number.isFinite(periodEnd) ||
      periodStart > now || periodEnd <= now || periodStart >= periodEnd) {
    throw new Error('Billing period unsupported');
  }
  const forecast = raw.forecast && Date.parse(raw.forecast.periodEnd) === periodEnd &&
    Date.parse(raw.forecast.basisAt) <= now &&
    now - Date.parse(raw.forecast.basisAt) <= 24 * 3600000 ?
    cents(raw.forecast.grossUsageCents) : null;
  // Whitelist fields. snapshotToken and resource details never enter state.
  return {periodStart, periodEnd, gross: cents(raw.money.grossUsageCents),
    included: cents(raw.money.includedUsageCreditCents),
    extra: cents(raw.money.effectiveExtraBudgetCents), forecast};
}
export async function checkBilling(token, fetcher = fetch, now = Date.now()) {
  try { return {ok: true, value: normalizeBilling(await rpcRead('billing.usage.current', token, fetcher), now)}; }
  catch { return {ok: false}; }
}
export async function collect(config, {fetcher = fetch, database = checkDatabase} = {}) {
  const [http, login, cabinet, db, billing] = await Promise.all([
    checkHttp('http', fetcher), checkHttp('login', fetcher), checkHttp('cabinet', fetcher),
    database(config.databaseUrl), checkBilling(config.onrezaToken, fetcher),
  ]);
  return {http, login, cabinet, database: db, billing};
}
