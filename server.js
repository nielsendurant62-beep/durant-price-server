// ══════════════════════════════════════════════════
//  Durant Portfolio — Price Cache Server
//  Haalt koersen op via Polygon.io (gratis plan)
//  en serveert die als JSON endpoint aan iedereen
// ══════════════════════════════════════════════════

const https = require('https');
const http  = require('http');

const POLYGON_KEY = process.env.POLYGON_KEY || 'ItxLGprLetR2gGAYFgLI3PKJOxy77Li3';
const PORT        = process.env.PORT || 3000;

// Alle tickers — BRK/B wordt intern BRK.B voor Polygon
const TICKERS = [
  'AAPL','MSFT','GOOGL','AMZN','NVDA','META','TSLA','BRK/B',
  'JPM','V','JNJ','WMT','NFLX','DIS','AMD','INTC','PYPL','UBER',
  'COIN','MSTR','ASMLF','LVMUY','SAPGF','NSRGY','NVO','SIEGY',
  'SNYNF','EADSY','PHG','BUD',
  'SPY','QQQ','IWM','VTI','VEA','EEM','GLD','TLT','IEMG','URTH'
];

let priceCache = { updatedAt: null, eurUsd: 1.08, prices: {} };
let isFetching = false;

// ── HTTPS GET helper ──
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 12000 }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── EUR/USD via Frankfurter ──
async function fetchEurUsd() {
  try {
    const d = await httpsGet('https://api.frankfurter.app/latest?from=EUR&to=USD');
    return d.rates?.USD || priceCache.eurUsd;
  } catch { return priceCache.eurUsd; }
}

// ── Haal 1 ticker op via Polygon /prev ──
async function fetchOne(ticker) {
  const sym = ticker.replace('/', '.');
  try {
    const d   = await httpsGet(`https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(sym)}/prev?adjusted=true&apiKey=${POLYGON_KEY}`);
    const bar = d?.results?.[0];
    if (!bar?.c) return null;
    const change24h = bar.o ? ((bar.c - bar.o) / bar.o) * 100 : 0;
    return { price: bar.c, change24h };
  } catch { return null; }
}

// ── Haal alle tickers op in batches van 5 (gratis: 5 calls/min) ──
async function fetchAllPrices() {
  if (isFetching) return;
  isFetching = true;
  console.log(`\n[${new Date().toISOString()}] Start ophalen ${TICKERS.length} tickers...`);

  const newPrices = { ...priceCache.prices };
  const BATCH     = 5;

  for (let i = 0; i < TICKERS.length; i += BATCH) {
    const batch   = TICKERS.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(t => fetchOne(t)));

    batch.forEach((ticker, idx) => {
      if (results[idx]) {
        newPrices[ticker] = results[idx];
        console.log(`  v ${ticker}: $${results[idx].price.toFixed(2)}`);
      } else {
        console.log(`  x ${ticker}: mislukt`);
      }
    });

    if (i + BATCH < TICKERS.length) {
      console.log(`  -- wachten 61s --`);
      await sleep(61000);
    }
  }

  priceCache.prices    = newPrices;
  priceCache.updatedAt = new Date().toISOString();
  console.log(`[${new Date().toISOString()}] Klaar: ${Object.keys(newPrices).length}/${TICKERS.length} tickers\n`);
  isFetching = false;
}

// ── HTTP Server ──
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'public, max-age=60');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/prices' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(priceCache));
    return;
  }

  if (req.url === '/health') {
    const count = Object.keys(priceCache.prices).length;
    const busy  = isFetching ? ' (bezig met verversen...)' : '';
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`OK -- ${count}/${TICKERS.length} tickers geladen, bijgewerkt: ${priceCache.updatedAt || 'nog bezig'}${busy}`);
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// ── Start ──
(async () => {
  server.listen(PORT, () => console.log(`Server op poort ${PORT}`));

  priceCache.eurUsd = await fetchEurUsd();
  console.log(`EUR/USD: ${priceCache.eurUsd}`);

  fetchAllPrices();

  // Herhaal elke 15 minuten
  setInterval(fetchAllPrices, 15 * 60 * 1000);

  // EUR/USD elk uur
  setInterval(async () => {
    priceCache.eurUsd = await fetchEurUsd();
  }, 60 * 60 * 1000);
})();
