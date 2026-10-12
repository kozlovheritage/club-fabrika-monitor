// Pure alert policy. State contains no recipient, credential, customer or URL.
export const HOURS = 3600000;
const labels = {
  http: 'HTTP-процесс клуба', login: 'Страница входа',
  cabinet: 'Защита кабинета и переход на вход', database: 'Минимальный запрос к БД',
  billing: 'Чтение актуального бюджета ONREZA',
};
export function initialState() {
  return {version: 1, checks: {}, samples: [], budget: {}, pending: [], sequence: 0};
}
export function evaluate(previous, observations, now, {testEmail = false} = {}) {
  const state = structuredClone(previous);
  // Remove old routine reports from the outbox without losing mixed incident
  // or budget notices. Explicitly requested test messages remain deliverable.
  state.pending = state.pending.map(notice => ({
    ...notice,
    text: notice.text.split('\n\n').filter(paragraph =>
      !paragraph.startsWith('Ежедневный контроль мониторинга:') &&
      !paragraph.startsWith('Мониторинг возобновился после перерыва более 30 минут.') &&
      !paragraph.startsWith('Расход ')).join('\n\n'),
  })).filter(notice => notice.text.trim());
  const events = [];
  function event(text) { events.push(text); }
  for (const [key, label] of Object.entries(labels)) {
    const old = state.checks[key] || {failures: 0, active: false};
    const good = observations[key]?.ok === true;
    if (good) {
      if (old.active) event(`${label}: восстановлено.`);
      state.checks[key] = {failures: 0, active: false};
    } else {
      old.failures += 1;
      if (old.failures >= 2 && (!old.active || now - old.notifiedAt >= 6 * HOURS)) {
        event(`${label}: два последовательных запуска не прошли проверку${old.active ? ' (сбой продолжается)' : ''}.`);
        old.active = true;
        old.notifiedAt = now;
      }
      state.checks[key] = old;
    }
  }
  const bill = observations.billing?.ok && observations.billing.value;
  if (bill) {
    const {periodStart, periodEnd, gross, included, extra, forecast} = bill;
    const limit = included + extra;
    const periodKey = `${periodStart}/${periodEnd}`;
    if (state.budget.periodKey !== periodKey) {
      state.budget = {periodKey, notifiedLevel: 0, forecastAlerted: false};
      state.samples = [];
    }
    // Retain a seven-day bounded window; do not count a period reset as negative spend.
    const last = state.samples.at(-1);
    if (!last || now - last.at >= HOURS) state.samples.push({at: now, gross});
    state.samples = state.samples.filter(x => now - x.at <= 7 * 24 * HOURS).slice(-170);
    let projected = forecast;
    const baseline = state.samples.find(x => now - x.at >= 24 * HOURS);
    if (baseline && gross >= baseline.gross) {
      const rate = (gross - baseline.gross) / (now - baseline.at);
      projected = Math.max(projected ?? 0, gross + rate * Math.max(0, periodEnd - now));
    }
    const percent = limit > 0 ? 100 * gross / limit : (gross > 0 ? 100 : 0);
    const level = [70, 85, 95, 100].filter(x => percent >= x).at(-1) || 0;
    if (level > state.budget.notifiedLevel) {
      event(`Бюджет: использовано ${(gross / 100).toFixed(2)} ₽ из ${(limit / 100).toFixed(2)} ₽ (${percent.toFixed(1)}%). Включено ${(included / 100).toFixed(2)} ₽, действующая доплата ${(extra / 100).toFixed(2)} ₽.`);
      state.budget.notifiedLevel = level;
    }
    if (projected != null && projected >= limit && !state.budget.forecastAlerted) {
      event(`Риск исчерпания бюджета до конца периода: оценка ${(projected / 100).toFixed(2)} ₽ при лимите ${(limit / 100).toFixed(2)} ₽. Прогноз приблизительный.`);
      state.budget.forecastAlerted = true;
    }
    // Reset the forecast warning only after meaningful headroom returns.
    if (projected != null && projected < limit * .85) state.budget.forecastAlerted = false;
    if (state.budget.limit != null && state.budget.limit !== limit) {
      event(`Действующий общий бюджет изменился: ${(limit / 100).toFixed(2)} ₽. Мониторинг сам финансовые настройки не меняет.`);
      state.budget.notifiedLevel = level;
    }
    state.budget.limit = limit;
    state.budget.latest = {gross, included, extra, projected, at: now, periodEnd};
  }
  if (testEmail) {
    const statuses = Object.entries(labels).map(([key, label]) =>
      `${label}: ${observations[key]?.ok ? 'проверка пройдена' : 'проверка не пройдена'}`);
    event(`Тест уведомлений:\n${statuses.join('\n')}`);
    if (bill) event(`Расход ${(bill.gross / 100).toFixed(2)} ₽; включено ${(bill.included / 100).toFixed(2)} ₽; действующая доплата ${(bill.extra / 100).toFixed(2)} ₽. Период заканчивается ${new Date(bill.periodEnd).toISOString()}.`);
    state.heartbeatAt = now;
  }
  if (events.length) {
    state.sequence += 1;
    state.pending.push({id: `club-monitor-${now}-${state.sequence}`, createdAt: now, text: events.join('\n\n')});
  }
  state.lastRun = now;
  return state;
}
export function messageFor(pending) {
  return pending.map(x => x.text).join('\n\n') +
    '\n\nЭто технический мониторинг, не контрольная покупка. ' +
    'БД проверяется отдельным read-only соединением, не через сессию участницы. ' +
    'Оплата, выдача доступа, доставка писем участницам и PDF не проверяются. ' +
    'Обычные отчёты отключены. Расписание GitHub может задерживаться; отсутствие писем не подтверждает работу мониторинга.';
}
