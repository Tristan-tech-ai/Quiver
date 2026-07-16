// OK-ACCESS HMAC signing for OKX dev-portal APIs (facilitator + data).
import crypto from 'node:crypto';
import { config } from './config.js';

export function okxHeaders(method, requestPath, body = '') {
  const timestamp = new Date().toISOString();
  const prehash = timestamp + method.toUpperCase() + requestPath + body;
  const sign = crypto.createHmac('sha256', config.okxSecretKey).update(prehash).digest('base64');
  return {
    'OK-ACCESS-KEY': config.okxApiKey,
    'OK-ACCESS-SIGN': sign,
    'OK-ACCESS-TIMESTAMP': timestamp,
    'OK-ACCESS-PASSPHRASE': config.okxPassphrase,
    'Content-Type': 'application/json',
  };
}

export async function okxPost(pathname, payload, { base = config.okxApiBase, timeoutMs = 15000 } = {}) {
  const body = JSON.stringify(payload);
  const url = base.startsWith('http') ? new URL(pathname, base) : new URL(base + pathname);
  const requestPath = url.pathname + url.search;
  const res = await fetch(url, {
    method: 'POST',
    headers: okxHeaders('POST', requestPath, body),
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

export async function okxGet(pathnameWithQuery, { base = config.okxApiBase, timeoutMs = 15000 } = {}) {
  const url = new URL(pathnameWithQuery, base);
  const requestPath = url.pathname + url.search;
  const res = await fetch(url, {
    method: 'GET',
    headers: okxHeaders('GET', requestPath, ''),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}
