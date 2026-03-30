// ══════════════════════════════════════════════════
//  Durant Portfolio — Price Cache Server
//  Twelve Data /price endpoint:
//  40 tickers in 1 call = 1 credit
//  Elke 5 min = 288 credits/dag (limiet: 800)
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

async function fetchEurUsd() {
  try {
    const d = await httpsGet('https://api.frankfurter.app/latest?from=EUR&to=USD');
    return d.rates?.USD || priceCache.eurUsd;
  } catch { return priceCache.eurUsd; }
}

async function fetchAllPrices() {
  if (isFetching) { console.log('Al bezig, sla over.'); return; }
  isFetching = true;
  console.log(`\n[${new Date().toISOString()}] Ophalen ${TICKERS.length} tickers (1 credit)...`);

  try {
    // /price endpoint: alle tickers in 1 call = 1 credit
    // Geeft { AAPL: { price: '...' }, MSFT: { price: '...' }, ... }
    const symbols = TICKERS.join(',');
    const url     = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbols)}&apikey=${TWELVEDATA_KEY}`;
    const data    = await httpsGet(url);

    const newPrices = { ...priceCache.prices };

    // Haal ook previous_close op voor change% — dat doe je 1x per dag via /eod
    // Maar /price geeft geen previous_close, dus we berekenen change uit gecachte vorige waarde
    let loaded = 0;

    // Verwerk response — Twelve Data geeft object van objecten bij meerdere tickers
    Object.entries(data).forEach(([ticker, val]) => {
      if (!val || val.status === 'error') {
        console.log(`  x ${ticker}: ${val?.message || 'geen data'}`);
        return;
      }

      const price = parseFloat(val.price);
      if (!price || isNaN(price)) return;

      // Change berekenen tov vorige gecachte prijs
      const prev      = newPrices[ticker]?.price || price;
      const change24h = prev ? ((price - prev) / prev) * 100 : 0;

      // BRK/B fix: Twelve Data stuurt BRK/B, app verwacht ook BRK/B — geen remapping nodig
      newPrices[ticker] = { price, change24h };
      loaded++;
      console.log(`  v ${ticker}: $${price.toFixed(2)}`);
    });

    priceCache.prices    = newPrices;
    priceCache.updatedAt = new Date().toISOString();
    console.log(`[${new Date().toISOString()}] Klaar: ${loaded}/${TICKERS.length} tickers — 1 credit gebruikt\n`);

  } catch(e) {
    console.error(`Fout: ${e.message}`);
  }

  isFetching = false;
}

// Haal 1x per dag previous close op voor accurate change% — 1 credit
async function fetchPreviousClose() {
  try {
    const symbols = TICKERS.join(',');
    const url     = `https://api.twelvedata.com/eod?symbol=${encodeURIComponent(symbols)}&apikey=${TWELVEDATA_KEY}`;
    const data    = await httpsGet(url);

    Object.entries(data).forEach(([ticker, val]) => {
      if (!val || val.status === 'error') return;
      const close = parseFloat(val.close);
      if (!close || isNaN(close)) return;
      if (priceCache.prices[ticker]) {
        const cur = priceCache.prices[ticker].price || close;
        priceCache.prices[ticker].change24h = ((cur - close) / close) * 100;
        priceCache.prices[ticker].prevClose = close;
      }
    });
    console.log(`[${new Date().toISOString()}] Previous close bijgewerkt (1 credit)`);
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
    console.log(`Gebruik: 1 credit per 5 min = 288 credits/dag (limiet: 800)\n`);
  });

  priceCache.eurUsd = await fetchEurUsd();
  console.log(`EUR/USD: ${priceCache.eurUsd}`);

  // Meteen ophalen bij start
  await fetchPreviousClose(); // 1 credit voor accurate change%
  await fetchAllPrices();     // 1 credit voor live prijzen

  // Live prijzen elke 5 minuten (1 credit per keer)
  setInterval(fetchAllPrices, INTERVAL_MS);

  // Previous close 1x per dag om middernacht (1 credit)
  setInterval(fetchPreviousClose, 24 * 60 * 60 * 1000);

  // EUR/USD elk uur
  setInterval(async () => {
    priceCache.eurUsd = await fetchEurUsd();
    console.log(`EUR/USD ververst: ${priceCache.eurUsd}`);
  }, 60 * 60 * 1000);
})();
