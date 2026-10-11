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
  return {accepted: true, messageId: String(body.id), status: body.status};
  // Receipt stays in encrypted state. Acceptance is not proof of inbox delivery.
}

export async function checkMailDelivery(config, receipt, fetcher = fetch) {
  if (!receipt?.messageId) return {status: 'none', failed: false};
  try {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(receipt.messageId) || !config.mailToken) throw new Error();
    const r = await fetcher('https://api.notisend.ru/v1/email/messages/' + encodeURIComponent(receipt.messageId), {
      headers: {Authorization: 'Bearer ' + config.mailToken}, signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error();
    const body = await r.json();
    const allowed = ['queued', 'sent', 'delivered', 'skipped', 'soft_bounced', 'hard_bounced'];
    if (!allowed.includes(body.status)) throw new Error();
    return {status: body.status, failed: ['skipped', 'soft_bounced', 'hard_bounced'].includes(body.status)};
  } catch { return {status: 'unavailable', failed: true}; }
}
