import crypto from 'node:crypto';
import {initialState} from './engine.mjs';
export function encryptState(state, key) {
  const bytes = Buffer.from(key || '', 'base64');
  if (bytes.length !== 32) throw new Error('State key invalid');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', bytes, iv);
  cipher.setAAD(Buffer.from('club-monitor-state-v1'));
  const data = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
  return JSON.stringify({version: 1, iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64')});
}
export function decryptState(encoded, key) {
  try {
    const value = JSON.parse(encoded), bytes = Buffer.from(key || '', 'base64');
    if (value.version !== 1 || bytes.length !== 32) throw new Error();
    const decipher = crypto.createDecipheriv('aes-256-gcm', bytes, Buffer.from(value.iv, 'base64'));
    decipher.setAAD(Buffer.from('club-monitor-state-v1'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    const state = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(value.data, 'base64')), decipher.final(),
    ]).toString('utf8'));
    if (state.version !== 1 || !Array.isArray(state.pending) || !Array.isArray(state.samples) ||
        !state.checks || !state.budget || !Number.isInteger(state.sequence)) throw new Error();
    return state;
  } catch { throw new Error('Encrypted monitoring state unavailable'); }
}
export function stateStore({repo, token, key}, fetcher = fetch) {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo || '') || !token || !key) {
    throw new Error('Monitoring storage configuration incomplete');
  }
  const url = `https://api.github.com/repos/${repo}/contents/state.enc`;
  const headers = {Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'};
  let sha;
  return {
    async load() {
      const r = await fetcher(url + '?ref=main', {headers, signal: AbortSignal.timeout(15000)});
      if (r.status === 404) {
        // A deleted state must not silently reset alerts. Only explicit bootstrap is allowed.
        if (process.env.MONITOR_BOOTSTRAP !== 'true') throw new Error('Monitoring state missing');
        return initialState();
      }
      if (!r.ok) throw new Error('Monitoring state read failed');
      const body = await r.json();
      sha = body.sha;
      return decryptState(Buffer.from(body.content, 'base64').toString('utf8'), key);
    },
    async save(state) {
      const r = await fetcher(url, {method: 'PUT', headers: {...headers, 'Content-Type': 'application/json'},
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({message: 'Update encrypted monitoring checkpoint [skip ci]',
          branch: 'main', ...(sha ? {sha} : {}),
          content: Buffer.from(encryptState(state, key)).toString('base64')})});
      if (!r.ok) throw new Error('Monitoring state save failed');
      sha = (await r.json()).content.sha;
    },
  };
}
