#!/usr/bin/env node
'use strict';

/*
 * Minimal stock tracker server.
 * - Proxies Yahoo Finance (quotes incl. earnings dates, news, symbol search)
 *   so the browser isn't blocked by CORS.
 * - Zero npm dependencies. Requires Node 18+ (global fetch).
 * - Run with --demo (or DEMO=1) to serve synthetic data offline.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const DEMO = process.argv.includes('--demo') || process.env.DEMO === '1';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* ------------------------------ tiny cache ------------------------------ */

const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}

/* --------------------------- yahoo session ------------------------------ */
// Yahoo's quote API requires a cookie + "crumb" token. We bootstrap one and
// reuse it for ~50 minutes.

let session = { cookie: null, crumb: null, t: 0 };

async function getSession() {
  if (session.crumb && Date.now() - session.t < 50 * 60 * 1000) return session;
  let cookie = null;
  try {
    const res = await fetch('https://fc.yahoo.com/', {
      headers: { 'User-Agent': UA },
      redirect: 'manual',
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
  } catch {
    /* fc.yahoo.com can be flaky; crumb fetch below may still work */
  }
  let crumb = null;
  try {
    const res = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': UA, ...(cookie ? { Cookie: cookie } : {}) },
    });
    if (res.ok) {
      const text = (await res.text()).trim();
      if (text && !text.includes('<')) crumb = text;
    }
  } catch {
    /* handled by callers via fallback */
  }
  session = { cookie, crumb, t: Date.now() };
  return session;
}

async function yahooJson(url, withSession = false) {
  const headers = { 'User-Agent': UA, Accept: 'application/json' };
  if (withSession) {
    const s = await getSession();
    if (s.cookie) headers.Cookie = s.cookie;
    if (s.crumb) url += (url.includes('?') ? '&' : '?') + 'crumb=' + encodeURIComponent(s.crumb);
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`yahoo ${res.status} for ${url.split('?')[0]}`);
  return res.json();
}

/* ------------------------------- quotes --------------------------------- */

const QUOTE_FIELDS = [
  'symbol', 'shortName', 'longName', 'currency', 'marketState',
  'regularMarketPrice', 'regularMarketChange', 'regularMarketChangePercent',
  'regularMarketPreviousClose', 'regularMarketOpen',
  'regularMarketDayHigh', 'regularMarketDayLow',
  'fiftyTwoWeekHigh', 'fiftyTwoWeekLow',
  'regularMarketVolume', 'averageDailyVolume3Month',
  'marketCap', 'trailingPE', 'forwardPE', 'epsTrailingTwelveMonths',
  'trailingAnnualDividendYield',
  'earningsTimestamp', 'earningsTimestampStart', 'earningsTimestampEnd',
  'preMarketPrice', 'preMarketChangePercent',
  'postMarketPrice', 'postMarketChangePercent',
];

function shapeQuote(q) {
  const out = {};
  for (const f of QUOTE_FIELDS) if (q[f] !== undefined) out[f] = q[f];
  // Pick a single earnings timestamp; ranges from Yahoo mean "estimated".
  const ts = q.earningsTimestamp || q.earningsTimestampStart || null;
  if (ts) {
    out.earningsDate = ts * 1000;
    out.earningsEstimated =
      !q.earningsTimestamp ||
      (q.earningsTimestampStart &&
        q.earningsTimestampEnd &&
        q.earningsTimestampStart !== q.earningsTimestampEnd);
  }
  return out;
}

async function fetchQuotes(symbols) {
  const url =
    'https://query1.finance.yahoo.com/v7/finance/quote?symbols=' +
    encodeURIComponent(symbols.join(','));
  try {
    const data = await yahooJson(url, true);
    const results = data?.quoteResponse?.result || [];
    return results.map(shapeQuote);
  } catch (err) {
    // Crumb endpoint down or blocked: fall back to the public chart endpoint,
    // which needs no auth but lacks earnings/valuation fields.
    const out = [];
    for (const sym of symbols) {
      try {
        out.push(await fetchQuoteFromChart(sym));
      } catch {
        /* skip unknown symbols */
      }
    }
    if (out.length === 0) throw err;
    return out;
  }
}

async function fetchQuoteFromChart(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?interval=1d&range=5d`;
  const data = await yahooJson(url);
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error('no chart meta');
  const prev = meta.chartPreviousClose ?? meta.previousClose;
  const price = meta.regularMarketPrice;
  return {
    symbol: meta.symbol,
    shortName: meta.longName || meta.shortName || meta.symbol,
    currency: meta.currency,
    regularMarketPrice: price,
    regularMarketPreviousClose: prev,
    regularMarketChange: price != null && prev != null ? price - prev : undefined,
    regularMarketChangePercent:
      price != null && prev ? ((price - prev) / prev) * 100 : undefined,
    regularMarketDayHigh: meta.regularMarketDayHigh,
    regularMarketDayLow: meta.regularMarketDayLow,
    regularMarketVolume: meta.regularMarketVolume,
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
    fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
  };
}

/* ---------------------------- news & search ----------------------------- */

async function fetchNews(symbol) {
  const url =
    'https://query1.finance.yahoo.com/v1/finance/search?q=' +
    encodeURIComponent(symbol) +
    '&quotesCount=0&newsCount=10';
  const data = await yahooJson(url);
  return (data.news || []).map((n) => ({
    title: n.title,
    publisher: n.publisher,
    link: n.link,
    time: (n.providerPublishTime || 0) * 1000,
  }));
}

async function searchSymbols(q) {
  const url =
    'https://query1.finance.yahoo.com/v1/finance/search?q=' +
    encodeURIComponent(q) +
    '&quotesCount=8&newsCount=0';
  const data = await yahooJson(url);
  return (data.quotes || [])
    .filter((r) => r.symbol && (r.quoteType === 'EQUITY' || r.quoteType === 'ETF'))
    .map((r) => ({
      symbol: r.symbol,
      name: r.shortname || r.longname || '',
      exchange: r.exchDisp || r.exchange || '',
      type: r.quoteType,
    }));
}

/* ------------------------------ demo mode ------------------------------- */
// Deterministic-ish fake data so the app can be exercised offline.

const DEMO_NAMES = {
  AAPL: 'Apple Inc.', MSFT: 'Microsoft Corporation', NVDA: 'NVIDIA Corporation',
  GOOGL: 'Alphabet Inc.', AMZN: 'Amazon.com, Inc.', TSLA: 'Tesla, Inc.',
  META: 'Meta Platforms, Inc.',
};

function demoSeed(str) {
  let h = 2166136261;
  for (const c of str) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822519);
    h = Math.imul(h ^ (h >>> 13), 3266489917);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function demoQuote(symbol, i) {
  const rnd = demoSeed(symbol);
  const base = 40 + rnd() * 800;
  const drift = Math.sin(Date.now() / 60000 + rnd() * 10) * 0.01;
  const changePct = (rnd() - 0.45) * 4 + drift;
  const price = base * (1 + changePct / 100);
  // Stagger demo earnings so the alert stages (7/3/1/0 days) can be exercised.
  const daysOut = [0, 1, 3, 7, 12, 26][i % 6];
  const earnings = new Date();
  earnings.setDate(earnings.getDate() + daysOut);
  earnings.setHours(16, 30, 0, 0);
  return {
    symbol,
    shortName: DEMO_NAMES[symbol] || `${symbol} Corp. (demo)`,
    currency: 'USD',
    marketState: 'REGULAR',
    regularMarketPrice: price,
    regularMarketChange: price - base,
    regularMarketChangePercent: changePct,
    regularMarketPreviousClose: base,
    regularMarketOpen: base * (1 + (rnd() - 0.5) / 100),
    regularMarketDayHigh: price * 1.012,
    regularMarketDayLow: price * 0.988,
    fiftyTwoWeekHigh: base * 1.35,
    fiftyTwoWeekLow: base * 0.62,
    regularMarketVolume: Math.floor(5e6 + rnd() * 6e7),
    averageDailyVolume3Month: Math.floor(5e6 + rnd() * 5e7),
    marketCap: Math.floor(price * (1e9 + rnd() * 2.5e9)),
    trailingPE: 12 + rnd() * 40,
    epsTrailingTwelveMonths: 1 + rnd() * 12,
    trailingAnnualDividendYield: rnd() < 0.5 ? rnd() * 0.02 : undefined,
    earningsDate: earnings.getTime(),
    earningsEstimated: daysOut > 10,
  };
}

function demoNews(symbol) {
  const now = Date.now();
  return [
    { title: `${symbol} beats expectations as demand stays resilient`, publisher: 'Demo Wire', link: '#', time: now - 2 * 3600e3 },
    { title: `Analysts raise ${symbol} price targets ahead of earnings`, publisher: 'Demo Times', link: '#', time: now - 7 * 3600e3 },
    { title: `What to watch in ${symbol}'s upcoming quarterly report`, publisher: 'Demo Finance', link: '#', time: now - 26 * 3600e3 },
    { title: `${symbol} expands into new markets, shares react`, publisher: 'Demo Journal', link: '#', time: now - 2 * 86400e3 },
  ];
}

/* ------------------------------ http server ----------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (url.pathname === '/api/quotes') {
      const symbols = (url.searchParams.get('symbols') || '')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
        .slice(0, 50);
      if (symbols.length === 0) return sendJson(res, 400, { error: 'symbols required' });
      const quotes = DEMO
        ? symbols.map((s, i) => demoQuote(s, i))
        : await cached('q:' + symbols.join(','), 30e3, () => fetchQuotes(symbols));
      return sendJson(res, 200, { quotes, demo: DEMO, asOf: Date.now() });
    }

    if (url.pathname === '/api/news') {
      const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
      if (!symbol) return sendJson(res, 400, { error: 'symbol required' });
      const news = DEMO
        ? demoNews(symbol)
        : await cached('n:' + symbol, 5 * 60e3, () => fetchNews(symbol));
      return sendJson(res, 200, { news });
    }

    if (url.pathname === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return sendJson(res, 200, { results: [] });
      const results = DEMO
        ? [{ symbol: q.toUpperCase(), name: `${q.toUpperCase()} (demo match)`, exchange: 'DEMO', type: 'EQUITY' }]
        : await cached('s:' + q.toLowerCase(), 10 * 60e3, () => searchSymbols(q));
      return sendJson(res, 200, { results });
    }

    // static files
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(__dirname, 'public', file);
    if (!full.startsWith(path.join(__dirname, 'public'))) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    fs.readFile(full, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (err) {
    sendJson(res, 502, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`Stock tracker running${DEMO ? ' (demo mode — synthetic data)' : ''}:`);
  console.log(`  this computer:  http://localhost:${PORT}`);
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) {
        console.log(`  on your phone:  http://${i.address}:${PORT}  (same Wi-Fi)`);
      }
    }
  }
});
