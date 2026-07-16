// Dev backend: shell out to the local onchainos CLI (read-only market/token/portfolio data).
import { execFile } from 'node:child_process';
import { config } from '../config.js';

export const name = 'cli';

function run(args, timeoutMs = config.upstreamTimeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(config.onchainosBin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      // The CLI prints JSON to stdout even on some non-zero exits; prefer parsing stdout.
      const text = String(stdout || '').trim();
      const jsonLine = text.split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop();
      if (jsonLine) {
        try {
          const parsed = JSON.parse(jsonLine);
          if (parsed.ok === false) return reject(new Error(`onchainos error: ${JSON.stringify(parsed).slice(0, 400)}`));
          return resolve(parsed.data ?? parsed);
        } catch { /* fall through */ }
      }
      if (err) return reject(new Error(`onchainos failed: ${String(err.message || err).slice(0, 300)}`));
      reject(new Error(`onchainos returned no JSON: ${text.slice(0, 200)}`));
    });
  });
}

// Raw diagnostic runner — returns everything (stdout/stderr/exit/error) unfiltered.
export function probe(args, timeoutMs = 45000) {
  return new Promise((resolve) => {
    execFile(config.onchainosBin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        bin: config.onchainosBin,
        args,
        exit: err?.code ?? 0,
        errName: err ? String(err.message || err).slice(0, 300) : null,
        stdout: String(stdout || '').slice(0, 4000),
        stderr: String(stderr || '').slice(0, 4000),
      });
    });
  });
}

export const trades = (chain, address, limit = config.tapeLimit) =>
  run(['token', 'trades', '--chain', chain, '--address', address, '--limit', String(Math.min(limit, 500))]);

export const priceInfo = (chain, address) =>
  run(['token', 'price-info', '--chain', chain, '--address', address]);

export const clusterOverview = (chain, address) =>
  run(['token', 'cluster-overview', '--chain', chain, '--address', address]);

export const holders = (chain, address) =>
  run(['token', 'holders', '--chain', chain, '--address', address]);

export const advancedInfo = (chain, address) =>
  run(['token', 'advanced-info', '--chain', chain, '--address', address]);

export const bundleInfo = (chain, address) =>
  run(['memepump', 'token-bundle-info', '--chain', chain, '--address', address]);

export const portfolioOverview = (chain, address, timeFrame = 4) =>
  run(['market', 'portfolio-overview', '--chain', chain, '--address', address, '--time-frame', String(timeFrame)]);

export const portfolioDexHistory = (chain, address) =>
  run(['market', 'portfolio-dex-history', '--chain', chain, '--address', address]);

export const recentPnl = (chain, address) =>
  run(['market', 'portfolio-recent-pnl', '--chain', chain, '--address', address]);

export const candles = (chain, address, bar = '1H', limit = 48) =>
  run(['market', 'kline', '--chain', chain, '--address', address, '--bar', bar, '--limit', String(limit)]);
