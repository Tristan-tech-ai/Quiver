// Data access layer. Two backends behind one interface:
//  - cli  : shell out to the local onchainos binary (dev on Windows)
//  - rest : OKX Web3 REST API with dev-portal keys (deployed)
import fs from 'node:fs';
import { config } from '../config.js';
import * as cli from './okx-cli.js';
import * as rest from './okx-rest.js';

function pick() {
  if (config.adapter === 'cli') return cli;
  if (config.adapter === 'rest') return rest;
  // auto: prefer the local CLI when the binary exists (dev box), else REST.
  try {
    if (fs.existsSync(config.onchainosBin)) return cli;
  } catch { /* fall through */ }
  return rest;
}

const backend = pick();

export const trades = (chain, address, limit) => backend.trades(chain, address, limit);
export const priceInfo = (chain, address) => backend.priceInfo(chain, address);
export const clusterOverview = (chain, address) => backend.clusterOverview(chain, address);
// The REST backend's holders route is 404 upstream as of 28 July 2026 and now throws by name; see
// okx-rest.js for what was measured. The CLI backend takes a different path and is left alone. Kept
// rather than deleted so the next caller is told why, instead of meeting a 404.
export const holders = (chain, address) => backend.holders(chain, address);
export const advancedInfo = (chain, address) => backend.advancedInfo(chain, address);
export const bundleInfo = (chain, address) => backend.bundleInfo(chain, address);
export const portfolioOverview = (chain, address, timeFrame) => backend.portfolioOverview(chain, address, timeFrame);
export const portfolioDexHistory = (chain, address) => backend.portfolioDexHistory(chain, address);
export const recentPnl = (chain, address) => backend.recentPnl(chain, address);
export const candles = (chain, address, bar, limit) => backend.candles(chain, address, bar, limit);
export const backendName = backend.name;
