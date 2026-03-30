// ══════════════════════════════════════════════════
//  Durant Portfolio — Price Cache Server
//  Twelve Data /price = 1 credit voor alle tickers
//  288 credits/dag (limiet: 800)
// ══════════════════════════════════════════════════

const https = require('https');
const http  = require('http');

const TWELVEDATA_KEY = process.env.TWELVEDATA_KEY || '68ab66a22fc54644871caf2ece8cf856';
const PORT           = process.env.PORT || 3000;
const INTERVAL_MS    = 5 * 60 * 1000; // 5 minuten

const TICKERS = [
  'AAPL','MSFT','GOOGL','AMZN','NVDA','META','TSLA','BRK/B',
  'JPM','V','JNJ','WMT','NFLX','DIS','AMD','INTC','PYPL','UBER',
  'COIN','MSTR','ASMLF','LVMUY','SAPGF','NSRGY','NVO','SIEGY',
  'SNYNF','EADSY','PHG','BUD',
  'SPY','QQQ','IWM','VTI','VEA','EEM','GLD','TLT','IEMG','URTH'
];

let priceCache  = { updatedAt: null, eurUsd: 1.08, prices: {} };
let prevCloses  = {}; // ticker -> previous close prijs
let isFetching  = false;

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchEurUsd() {
  try {
    const d = await httpsGet('https://api.frankfurter.app/latest?from=EUR&to=USD');
    return d.rates?.USD || priceCache.eurUsd;
  } catch { return priceCache.eurUsd; }
}

// Verwerk Twelve Data response — werkt voor zowel 1 als meerdere tickers
function parseTwelveDataResponse(data, endpoint) {
  const results = {};

  // Check of het een foutmelding is
  if (data.code && data.message) {
    console.log(`  API fout: ${data.message}`);
    return results;
  }

  // Bepaal of het 1 ticker (plat object) of meerdere tickers (genest object) is
  const firstVal = Object.values(data)[0];
  const isMulti  = firstVal && typeof firstVal === 'object' && !Array.isArray(firstVal);

  if (isMulti) {
    // Meerdere tickers: { AAPL: { price: '246' }, MSFT: { price: '357' } }
    Object.entries(data).forEach(([ticker, val]) => {
      if (!val || val.code || val.status === 'error') {
        console.log(`  x ${ticker}: ${val?.message || 'fout'}`);
        return;
      }
      const price = parseFloat(val.price || val.close);
      if (price && !isNaN(price)) results[ticker] = price;
    });
  } else if (data.price || data.close) {
    // 1 ticker: { price: '246', symbol: 'AAPL' }
    const ticker = data.symbol || TICKERS[0];
    const price  = parseFloat(data.price || data.close);
    if (price && !isNaN(price)) results[ticker] = price;
  }

  return results;
}

async function fetchAllPrices() {
  if (isFetching) { console.log('Al bezig, sla over.'); return; }
  isFetching = true;
  console.log(`\n[${new Date().toISOString()}] Ophalen ${TICKERS.length} tickers — 1 credit...`);

  try {
    const symbols = TICKERS.join(',');
    const url     = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbols)}&apikey=${TWELVEDATA_KEY}`;
    const data    = await httpsGet(url);

    // Debug: log eerste stuk van response
    console.log(`  Response preview: ${JSON.stringify(data).slice(0, 150)}`);

    const rawPrices = parseTwelveDataResponse(data, 'price');
    const newPrices = { ...priceCache.prices };
    let loaded = 0;

    Object.entries(rawPrices).forEach(([ticker, price]) => {
      const prev      = prevCloses[ticker] || newPrices[ticker]?.price || price;
      const change24h = prev ? ((price - prev) / prev) * 100 : 0;
      // BRK/B: Twelve Data kan BRK%2FB of BRK/B teruggeven
      const key = ticker.replace('%2F', '/');
      newPrices[key] = { price, change24h };
      loaded++;
      console.log(`  v ${key}: $${price.toFixed(2)}`);
    });

    priceCache.prices    = newPrices;
    priceCache.updatedAt = new Date().toISOString();
    console.log(`[${new Date().toISOString()}] Klaar: ${loaded}/${TICKERS.length} tickers — 1 credit\n`);

  } catch(e) {
    console.error(`Fout: ${e.message}`);
  }

  isFetching = false;
}

// Haal previous close op via /eod — 1 credit, 1x per dag
async function fetchPreviousClose() {
  try {
    const symbols = TICKERS.join(',');
    const url     = `https://api.twelvedata.com/eod?symbol=${encodeURIComponent(symbols)}&apikey=${TWELVEDATA_KEY}`;
    const data    = await httpsGet(url);
    const closes  = parseTwelveDataResponse(data, 'eod');

    Object.entries(closes).forEach(([ticker, price]) => {
      prevCloses[ticker.replace('%2F', '/')] = price;
    });
    console.log(`[${new Date().toISOString()}] Previous close: ${Object.keys(closes).length} tickers (1 credit)`);
  } catch(e) {
    console.error(`Previous close fout: ${e.message}`);
  }
}

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
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`OK -- ${count}/${TICKERS.length} tickers, bijgewerkt: ${priceCache.updatedAt || 'nog bezig'}`);
    return;
  }

  res.writeHead(404); res.end('Not found');
});

(async () => {
  server.listen(PORT, () => {
    console.log(`\nServer op poort ${PORT}`);
    console.log(`Plan: 1 credit/5min = max 290 credits/dag (limiet 800)\n`);
  });

  priceCache.eurUsd = await fetchEurUsd();
  console.log(`EUR/USD: ${priceCache.eurUsd}`);

  await fetchPreviousClose();
  await fetchAllPrices();

  setInterval(fetchAllPrices, INTERVAL_MS);
  setInterval(fetchPreviousClose, 24 * 60 * 60 * 1000);
  setInterval(async () => {
    priceCache.eurUsd = await fetchEurUsd();
  }, 60 * 60 * 1000);
})();
