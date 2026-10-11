export async function sendMail(config, text, fetcher = fetch) {
  if (!config.mailToken || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(config.mailFrom || '') ||
      !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(config.recipient || '')) {
    throw new Error('Monitoring email configuration incomplete');
  }
  const r = await fetcher('https://api.notisend.ru/v1/email/messages', {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: {Authorization: 'Bearer ' + config.mailToken, 'Content-Type': 'application/json'},
    body: JSON.stringify({from_email: config.mailFrom, from_name: 'Мониторинг клуба',
      to: config.recipient, subject: 'Фабрика заготовок: контроль работы и бюджета',
      text, payment: 'subscriber_priority'}),
  });
  if (!r.ok) throw new Error('Monitoring email not accepted');
  const body = await r.json();
  if (!body.id || !['queued', 'sent', 'delivered'].includes(body.status)) {
    throw new Error('Monitoring email not accepted');
  }
  return {accepted: true}; // Acceptance is not proof of inbox delivery.
}
