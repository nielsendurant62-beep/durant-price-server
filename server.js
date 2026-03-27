// ══════════════════════════════════════════════════
//  Durant Portfolio — Price Cache Server
//  Twelve Data — batch per 8 tickers (gratis plan)
//  5 batches × 8 = 40 tickers in ~5 min
// ══════════════════════════════════════════════════

const https = require('https');
const http  = require('http');

const TWELVEDATA_KEY = process.env.TWELVEDATA_KEY || '68ab66a22fc54644871caf2ece8cf856';
const PORT           = process.env.PORT || 3000;
const INTERVAL_MS    = 6 * 60 * 1000; // 6 minuten tussen rondes

const TICKERS = [
  'AAPL','MSFT','GOOGL','AMZN','NVDA','META','TSLA','BRK/B',
  'JPM','V','JNJ','WMT','NFLX','DIS','AMD','INTC','PYPL','UBER',
  'COIN','MSTR','ASMLF','LVMUY','SAPGF','NSRGY','NVO','SIEGY',
  'SNYNF','EADSY','PHG','BUD',
  'SPY','QQQ','IWM','VTI','VEA','EEM','GLD','TLT','IEMG','URTH'
];

let priceCache = { updatedAt: null, eurUsd: 1.08, prices: {} };
let isFetching = false;

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchEurUsd() {
  try {
    const d = await httpsGet('https://api.frankfurter.app/latest?from=EUR&to=USD');
    return d.rates?.USD || priceCache.eurUsd;
  } catch { return priceCache.eurUsd; }
}

// Haal 1 batch tickers op en verwerk het resultaat
async function fetchBatch(tickers) {
  const symbols = tickers.join(',');
  const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbols)}&apikey=${TWELVEDATA_KEY}`;
  const data = await httpsGet(url);

  // Log ruwe response voor debugging
  console.log(`  Raw keys: ${Object.keys(data).slice(0,5).join(', ')}...`);
  console.log(`  First entry type: ${typeof Object.values(data)[0]}`);

  const results = {};

  // Twelve Data geeft bij 1 ticker een plat object, bij meerdere een object van objecten
  // Detecteer het formaat aan de hand van of de eerste waarde een object is met 'close'
  const firstVal = Object.values(data)[0];
  
  if (firstVal && typeof firstVal === 'object' && ('close' in firstVal || 'status' in firstVal)) {
    // Meerdere tickers — object van objecten: { AAPL: { close: '...' }, MSFT: { close: '...' } }
    Object.entries(data).forEach(([ticker, quote]) => {
      if (!quote || quote.status === 'error' || !quote.close) {
        console.log(`  x ${ticker}: ${quote?.message || quote?.status || 'geen data'}`);
        return;
      }
      const price     = parseFloat(quote.close);
      const prev      = parseFloat(quote.previous_close) || price;
      const change24h = prev ? ((price - prev) / prev) * 100 : 0;
      if (price && !isNaN(price)) {
        results[ticker] = { price, change24h };
        console.log(`  v ${ticker}: $${price.toFixed(2)}`);
      }
    });
  } else if (firstVal && ('close' in data || 'status' in data)) {
    // 1 ticker — plat object: { close: '...', symbol: 'AAPL' }
    const ticker = data.symbol || tickers[0];
    if (data.close && data.status !== 'error') {
      const price     = parseFloat(data.close);
      const prev      = parseFloat(data.previous_close) || price;
      const change24h = prev ? ((price - prev) / prev) * 100 : 0;
      if (price && !isNaN(price)) {
        results[ticker] = { price, change24h };
        console.log(`  v ${ticker}: $${price.toFixed(2)}`);
      }
    }
  } else {
    console.log(`  Onbekend formaat: ${JSON.stringify(data).slice(0, 200)}`);
  }

  return results;
}

async function fetchAllPrices() {
  if (isFetching) { console.log('Al bezig, sla over.'); return; }
  isFetching = true;
  console.log(`\n[${new Date().toISOString()}] Start ophalen ${TICKERS.length} tickers...`);

  const newPrices = { ...priceCache.prices }; // behoud oude waarden als fallback
  const BATCH_SIZE = 8; // 8 tickers per call, 5 calls/min gratis

  for (let i = 0; i < TICKERS.length; i += BATCH_SIZE) {
    const batch = TICKERS.slice(i, i + BATCH_SIZE);
    console.log(`\n  Batch ${Math.floor(i/BATCH_SIZE)+1}: ${batch.join(',')}`);

    try {
      const results = await fetchBatch(batch);
      Object.assign(newPrices, results);
    } catch(e) {
      console.log(`  Batch fout: ${e.message}`);
    }

    // Wacht 61 sec tussen batches (max 5 calls/min op gratis plan)
    if (i + BATCH_SIZE < TICKERS.length) {
      console.log(`  Wachten 61s...`);
      await sleep(61000);
    }
  }

  priceCache.prices    = newPrices;
  priceCache.updatedAt = new Date().toISOString();
  console.log(`\n[${new Date().toISOString()}] Klaar: ${Object.keys(newPrices).length}/${TICKERS.length} tickers\n`);
  isFetching = false;
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
    const busy  = isFetching ? ' (bezig...)' : '';
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`OK -- ${count}/${TICKERS.length} tickers, bijgewerkt: ${priceCache.updatedAt || 'nog bezig'}${busy}`);
    return;
  }

  res.writeHead(404); res.end('Not found');
});

(async () => {
  server.listen(PORT, () => console.log(`\nServer op poort ${PORT}\n`));

  priceCache.eurUsd = await fetchEurUsd();
  console.log(`EUR/USD: ${priceCache.eurUsd}`);

  fetchAllPrices(); // start meteen, wacht niet

  setInterval(fetchAllPrices, INTERVAL_MS);
  setInterval(async () => {
    priceCache.eurUsd = await fetchEurUsd();
  }, 60 * 60 * 1000);
})();
