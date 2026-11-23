const MAIL_DIAGNOSTICS = new Set([
  'NOTISEND_INVALID_CONFIG',
  'NOTISEND_NETWORK_ERROR',
  'NOTISEND_TIMEOUT',
  'NOTISEND_INVALID_JSON',
  'NOTISEND_UNSUPPORTED_STATUS',
  'NOTISEND_UNKNOWN',
]);

export function safeMailDiagnostic(value) {
  if (typeof value !== 'string') return 'NOTISEND_UNKNOWN';
  if (MAIL_DIAGNOSTICS.has(value)) return value;
  if (/^NOTISEND_HTTP_[45]\d\d$/.test(value)) return value;
  if ([
    'MESSAGE_SKIPPED',
    'MESSAGE_SOFT_BOUNCED',
    'MESSAGE_HARD_BOUNCED',
    'MESSAGE_QUEUED_OVER_1H',
    'MESSAGE_SENT_OVER_1H',
  ].includes(value)) return value;
  return 'NOTISEND_UNKNOWN';
}

export async function sendMail(config, text, fetcher = fetch) {
  if (!config.mailToken || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(config.mailFrom || '') ||
      !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(config.recipient || '')) {
    throw new Error('Monitoring email configuration incomplete');
  }
  const r = await fetcher('https://api.notisend.ru/v1/email/messages', {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: {Authorization: 'Bearer ' + config.mailToken, 'Content-Type': 'application/json'},
    body: JSON.stringify({from_email: config.mailFrom, from_name: 'Мониторинг клуба',
      to: config.recipient, subject: 'Фабрика заготовок: контроль работы платформы',
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
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(receipt.messageId) || !config.mailToken) {
      return {status: 'unavailable', failed: true, diagnostic: 'NOTISEND_INVALID_CONFIG'};
    }
    const r = await fetcher('https://api.notisend.ru/v1/email/messages/' + encodeURIComponent(receipt.messageId), {
      headers: {Authorization: 'Bearer ' + config.mailToken}, signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return {
      status: 'unavailable', failed: true,
      diagnostic: safeMailDiagnostic(`NOTISEND_HTTP_${r.status}`),
    };
    let body;
    try {body = await r.json();}
    catch {return {status: 'unavailable', failed: true, diagnostic: 'NOTISEND_INVALID_JSON'};}
    const allowed = ['queued', 'sent', 'delivered', 'skipped', 'soft_bounced', 'hard_bounced'];
    if (!allowed.includes(body?.status)) {
      return {status: 'unavailable', failed: true, diagnostic: 'NOTISEND_UNSUPPORTED_STATUS'};
    }
    return {
      status: body.status,
      failed: ['skipped', 'soft_bounced', 'hard_bounced'].includes(body.status),
    };
  } catch (error) {
    const diagnostic = error?.name === 'TimeoutError' || error?.name === 'AbortError' ?
      'NOTISEND_TIMEOUT' : 'NOTISEND_NETWORK_ERROR';
    return {status: 'unavailable', failed: true, diagnostic};
  }
}
