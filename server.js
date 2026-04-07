// ══════════════════════════════════════════════════
//  Durant Portfolio — Price Cache Server
//  Alleen verversen als beurs open is
//  NYSE: ma-vr 15:30-22:00 Belgische tijd
//  Elke 20 min tijdens beurs = max 760 credits/dag
// ══════════════════════════════════════════════════

const https = require('https');
const http  = require('http');

const TWELVEDATA_KEY = process.env.TWELVEDATA_KEY || '68ab66a22fc54644871caf2ece8cf856';
const PORT           = process.env.PORT || 3000;

const TICKERS = [
  'AAPL','MSFT','GOOGL','AMZN','NVDA','META','TSLA','BRK/B',
  'JPM','V','JNJ','WMT','NFLX','DIS','AMD','INTC','PYPL','UBER',
  'COIN','MSTR','ASMLF','LVMUY','SAPGF','NSRGY','NVO','SIEGY',
  'SNYNF','EADSY','PHG','BUD',
  'SPY','QQQ','IWM','VTI','VEA','EEM','GLD','TLT','IEMG','URTH'
];

let priceCache = { updatedAt: null, eurUsd: 1.08, prices: {}, marketOpen: false };
let isFetching = false;

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse')); }
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

// ── Controleer of NYSE open is (Belgische tijd) ──
function isMarketOpen() {
  // Huidige tijd in Belgische tijdzone
  const now    = new Date();
  const bel    = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Brussels' }));
  const day    = bel.getDay();   // 0=zo, 1=ma, ..., 5=vr, 6=za
  const hour   = bel.getHours();
  const minute = bel.getMinutes();
  const time   = hour * 60 + minute; // minuten sinds middernacht

  // Alleen weekdagen
  if (day === 0 || day === 6) return false;

  // NYSE: 09:30-16:00 ET = 15:30-22:00 CET (winter) / 15:30-22:00 CEST (zomer)
  // Europe/Brussels past automatisch aan voor zomer/wintertijd
  // ET is altijd 6 uur achter op CET en 6 uur achter op CEST
  const open  = 15 * 60 + 30; // 15:30
  const close = 22 * 60;      // 22:00

  return time >= open && time < close;
}

// ── Tijdstip tot markt opengaat of sluit ──
function minutesUntilNextEvent() {
  const now  = new Date();
  const bel  = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Brussels' }));
  const day  = bel.getDay();
  const time = bel.getHours() * 60 + bel.getMinutes();
  const open = 15 * 60 + 30;

  if (isMarketOpen()) {
    // Minuten tot sluiting
    return (22 * 60) - time;
  } else {
    // Minuten tot opening (vandaag of volgende werkdag)
    if (day >= 1 && day <= 5 && time < open) {
      return open - time;
    }
    // Weekend of na sluitingstijd → volgende werkdag
    let daysUntilMonday = 1;
    if (day === 5 && time >= 22 * 60) daysUntilMonday = 3;
    else if (day === 6) daysUntilMonday = 2;
    else if (day === 0) daysUntilMonday = 1;
    else daysUntilMonday = 1;
    return daysUntilMonday * 24 * 60 - time + open;
  }
}

async function fetchBatch(tickers) {
  const symbols = tickers.join(',');
  const url     = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbols)}&apikey=${TWELVEDATA_KEY}`;
  const data    = await httpsGet(url);

  if (data.code === 429) throw new Error('Rate limit: ' + data.message);

  const results = {};
  const first   = Object.values(data)[0];

  if (first && typeof first === 'object') {
    Object.entries(data).forEach(([ticker, val]) => {
      const p = parseFloat(val?.price);
      if (p && !isNaN(p)) results[ticker] = p;
      else console.log(`  x ${ticker}: ${val?.message || 'geen prijs'}`);
    });
  } else if (data.price) {
    const p = parseFloat(data.price);
    if (p) results[tickers[0]] = p;
  }

  return results;
}

async function fetchAllPrices() {
  if (isFetching) return;

  if (!isMarketOpen()) {
    const min  = minutesUntilNextEvent();
    const uur  = Math.floor(min / 60);
    const rest = min % 60;
    priceCache.marketOpen = false;
    console.log(`[${new Date().toISOString()}] Beurs gesloten. Opent over ${uur}u${rest}m`);
    return;
  }

  isFetching = true;
  priceCache.marketOpen = true;
  console.log(`\n[${new Date().toISOString()}] Beurs OPEN — ophalen ${TICKERS.length} tickers...`);

  const newPrices = { ...priceCache.prices };
  const BATCH     = 8;
  let   loaded    = 0;

  for (let i = 0; i < TICKERS.length; i += BATCH) {
    const batch = TICKERS.slice(i, i + BATCH);
    console.log(`  Batch ${Math.floor(i/BATCH)+1}: ${batch.join(',')}`);

    try {
      const raw = await fetchBatch(batch);
      Object.entries(raw).forEach(([ticker, price]) => {
        const key       = ticker.replace('BRK%2FB', 'BRK/B');
        const prev      = newPrices[key]?.price || price;
        const change24h = ((price - prev) / prev) * 100;
        newPrices[key]  = { price, change24h };
        loaded++;
        console.log(`  v ${key}: $${price.toFixed(2)}`);
      });
    } catch(e) {
      console.log(`  Fout: ${e.message}`);
      if (e.message.includes('Rate limit')) {
        console.log('  Rate limit bereikt, stop deze ronde.');
        break;
      }
    }

    if (i + BATCH < TICKERS.length) {
      console.log('  Wacht 62s...');
      await sleep(62000);
    }
  }

  priceCache.prices    = newPrices;
  priceCache.updatedAt = new Date().toISOString();
  console.log(`[${new Date().toISOString()}] Klaar: ${loaded}/${TICKERS.length} tickers\n`);
  isFetching = false;
}

// ── Check elke minuut of beurs open is ──
// Wanneer open: haal op. Maar wacht 20 min tussen rondes.
let lastFetchTime = 0;
const FETCH_INTERVAL = 20 * 60 * 1000; // 20 minuten tussen rondes

async function tick() {
  const now = Date.now();
  if (isMarketOpen() && (now - lastFetchTime) >= FETCH_INTERVAL) {
    lastFetchTime = now;
    await fetchAllPrices();
  } else if (!isMarketOpen()) {
    priceCache.marketOpen = false;
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
    const count  = Object.keys(priceCache.prices).length;
    const status = priceCache.marketOpen ? '🟢 Beurs OPEN' : '🔴 Beurs gesloten';
    const min    = minutesUntilNextEvent();
    const event  = priceCache.marketOpen ? `Sluit over ${min}min` : `Opent over ${min}min`;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`${status} — ${event}\n${count}/${TICKERS.length} tickers\nBijgewerkt: ${priceCache.updatedAt || 'nog niet'}`);
    return;
  }

  res.writeHead(404); res.end('Not found');
});

(async () => {
  server.listen(PORT, () => {
    console.log(`\nServer op poort ${PORT}`);
    console.log(`Verversing: elke 20 min tijdens beurs (ma-vr 15:30-22:00 BE)\n`);
  });

  priceCache.eurUsd = await fetchEurUsd();
  console.log(`EUR/USD: ${priceCache.eurUsd}`);

  // Wacht 65s bij opstart voor rate limit reset
  console.log('Wacht 65s voor rate limit reset...');
  await sleep(65000);

  // Eerste tick
  await tick();

  // Check elke minuut of beurs open is
  setInterval(tick, 60 * 1000);

  // EUR/USD elk uur
  setInterval(async () => {
    priceCache.eurUsd = await fetchEurUsd();
  }, 60 * 60 * 1000);

  // ── Keep-alive: ping zichzelf elke 10 min ──
  // Voorkomt dat Render de server in slaap legt na 15 min inactiviteit
  const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(() => {
    https.get(SELF_URL + '/health', res => {
      console.log(`[keep-alive] ping OK (${res.statusCode})`);
    }).on('error', () => {
      // Probeer via http als https mislukt
      http.get(`http://localhost:${PORT}/health`, () => {}).on('error', () => {});
    });
  }, 10 * 60 * 1000); // elke 10 minuten

})();
