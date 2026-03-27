// ══════════════════════════════════════════════════
//  Durant Portfolio — Price Cache Server
//  1 batch call elke 5 min via Twelve Data
//  288 calls/dag — limiet: 800/dag
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

let priceCache = { updatedAt: null, eurUsd: 1.08, prices: {} };

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, res => {
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

async function fetchEurUsd() {
  try {
    const d = await httpsGet('https://api.frankfurter.app/latest?from=EUR&to=USD');
    return d.rates?.USD || priceCache.eurUsd;
  } catch { return priceCache.eurUsd; }
}

async function fetchAllPrices() {
  console.log(`[${new Date().toISOString()}] Batch call voor ${TICKERS.length} tickers...`);
  try {
    const symbols = TICKERS.join(',');
    const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbols)}&apikey=${TWELVEDATA_KEY}`;
    const data = await httpsGet(url);

    const newPrices = {};
    Object.entries(data).forEach(([ticker, quote]) => {
      if (quote.status === 'error' || !quote.close) return;
      const price     = parseFloat(quote.close);
      const prev      = parseFloat(quote.previous_close) || price;
      const change24h = prev ? ((price - prev) / prev) * 100 : 0;
      if (!isNaN(price)) {
        newPrices[ticker] = { price, change24h };
        console.log(`  v ${ticker}: $${price.toFixed(2)} (${change24h>=0?'+':''}${change24h.toFixed(2)}%)`);
      }
    });

    priceCache.prices    = newPrices;
    priceCache.updatedAt = new Date().toISOString();
    console.log(`  Klaar: ${Object.keys(newPrices).length}/${TICKERS.length} tickers — 1 API call\n`);
  } catch(e) {
    console.error(`  Fout: ${e.message}`);
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
  server.listen(PORT, () => console.log(`\nServer op poort ${PORT} -- /prices en /health\n`));

  priceCache.eurUsd = await fetchEurUsd();
  console.log(`EUR/USD: ${priceCache.eurUsd}`);

  await fetchAllPrices();

  setInterval(fetchAllPrices, INTERVAL_MS);
  setInterval(async () => {
    priceCache.eurUsd = await fetchEurUsd();
    console.log(`EUR/USD ververst: ${priceCache.eurUsd}`);
  }, 60 * 60 * 1000);
})();
