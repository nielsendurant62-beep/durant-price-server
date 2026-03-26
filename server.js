// ══════════════════════════════════════════════════
//  Durant Portfolio — Price Cache Server
//  Haalt elke 5 min koersen op via Polygon.io
//  en serveert die als 1 JSON endpoint aan iedereen
// ══════════════════════════════════════════════════

const https = require('https');
const http  = require('http');

const POLYGON_KEY = process.env.POLYGON_KEY || 'ItxLGprLetR2gGAYFgLI3PKJOxy77Li3';
const PORT        = process.env.PORT || 3000;
const INTERVAL_MS = 5 * 60 * 1000; // 5 minuten

// Alle tickers die de app gebruikt
const TICKERS = [
  'AAPL','MSFT','GOOGL','AMZN','NVDA','META','TSLA','BRK/B',
  'JPM','V','JNJ','WMT','NFLX','DIS','AMD','INTC','PYPL','UBER',
  'COIN','MSTR','ASMLF','LVMUY','SAPGF','NSRGY','NVO','SIEGY',
  'SNYNF','EADSY','PHG','BUD',
  'SPY','QQQ','IWM','VTI','VEA','EEM','GLD','TLT','IEMG','URTH'
];

// In-memory cache
let priceCache = {
  updatedAt: null,
  eurUsd:    1.08,
  prices:    {}  // ticker -> { price, change24h }  (in USD)
};

// ── Hulpfunctie: HTTPS GET als Promise ──
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 10000 }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

// ── Haal EUR/USD op via Frankfurter ──
async function fetchEurUsd() {
  try {
    const d = await httpsGet('https://api.frankfurter.app/latest?from=EUR&to=USD');
    return d.rates?.USD || 1.08;
  } catch { return 1.08; }
}

// ── Haal alle aandelenkoersen op via Polygon snapshot ──
// Polygon ondersteunt meerdere tickers in 1 call: max 250 per request
async function fetchAllPrices() {
  console.log(`[${new Date().toISOString()}] Koersen ophalen via Polygon…`);

  try {
    // 1 call voor alle tickers tegelijk
    const tickerStr = TICKERS.map(t => encodeURIComponent(t)).join(',');
    const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${tickerStr}&apiKey=${POLYGON_KEY}`;
    const data = await httpsGet(url);

    const newPrices = {};

    if (data.tickers && Array.isArray(data.tickers)) {
      data.tickers.forEach(snap => {
        const ticker = snap.ticker;
        let price, change24h;

        if (snap.day?.c > 0) {
          price     = snap.day.c;
          const ref = snap.prevDay?.c || snap.day.o || price;
          change24h = ref ? ((price - ref) / ref) * 100 : 0;
        } else if (snap.prevDay?.c > 0) {
          price     = snap.prevDay.c;
          const ref = snap.prevDay.o || price;
          change24h = ref ? ((price - ref) / ref) * 100 : 0;
        }

        if (price && !isNaN(price)) {
          newPrices[ticker] = { price, change24h: change24h || 0 };
        }
      });
    }

    // Tickers die niet in snapshot zaten: haal individueel op via /prev
    const missing = TICKERS.filter(t => !newPrices[t]);
    if (missing.length > 0) {
      console.log(`  Ontbrekende tickers via /prev: ${missing.join(', ')}`);
      await Promise.all(missing.map(async ticker => {
        try {
          const url2 = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/prev?adjusted=true&apiKey=${POLYGON_KEY}`;
          const d2   = await httpsGet(url2);
          const bar  = d2?.results?.[0];
          if (bar?.c) {
            const change24h = bar.o ? ((bar.c - bar.o) / bar.o) * 100 : 0;
            newPrices[ticker] = { price: bar.c, change24h };
          }
        } catch {}
      }));
    }

    priceCache.prices    = newPrices;
    priceCache.updatedAt = new Date().toISOString();
    console.log(`  ✓ ${Object.keys(newPrices).length}/${TICKERS.length} tickers geladen`);

  } catch(e) {
    console.error('  ✗ Fout bij ophalen:', e.message);
  }
}

// ── EUR/USD apart bijhouden (elk uur) ──
async function refreshEurUsd() {
  priceCache.eurUsd = await fetchEurUsd();
  console.log(`[${new Date().toISOString()}] EUR/USD: ${priceCache.eurUsd}`);
}

// ── HTTP Server ──
const server = http.createServer((req, res) => {
  // CORS — sta verzoeken toe van elke origin (jouw app)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 'public, max-age=60'); // browser mag 60s cachen

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/prices' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      updatedAt: priceCache.updatedAt,
      eurUsd:    priceCache.eurUsd,
      prices:    priceCache.prices   // USD prijzen — app converteert zelf
    }));
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`OK — ${Object.keys(priceCache.prices).length} tickers, bijgewerkt: ${priceCache.updatedAt || 'nog niet'}`);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ── Start ──
(async () => {
  // Meteen ophalen bij opstart
  await refreshEurUsd();
  await fetchAllPrices();

  // Daarna elke 5 minuten
  setInterval(fetchAllPrices, INTERVAL_MS);
  // EUR/USD elk uur
  setInterval(refreshEurUsd, 60 * 60 * 1000);

  server.listen(PORT, () => {
    console.log(`\n🚀 Price server draait op poort ${PORT}`);
    console.log(`   GET /prices  → alle koersen als JSON`);
    console.log(`   GET /health  → status check\n`);
  });
})();
