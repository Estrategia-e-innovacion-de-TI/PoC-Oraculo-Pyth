

// Consulta un feed de Pyth (Hermes) fuera de la cadena.
// Uso: node --env-file=.env script/fetch-price.mjs AAPL          (acción, por defecto)
//      node --env-file=.env script/fetch-price.mjs ETH crypto    (cripto)
// El endpoint de precios exige PYTH_API_KEY.
const HERMES = process.env.HERMES_URL ?? "https://hermes.pyth.network";
const API_KEY = process.env.PYTH_API_KEY;
const symbol = (process.argv[2] ?? "AAPL").toUpperCase();
const assetType = (process.argv[3] ?? "equity").toLowerCase();
const SYMBOL_FORMAT = { equity: `Equity.US.${symbol}/USD`, crypto: `Crypto.${symbol}/USD` };
const target = SYMBOL_FORMAT[assetType];
if (!target) {
  console.error(`Tipo de activo no soportado: ${assetType} (usa: ${Object.keys(SYMBOL_FORMAT).join(", ")})`);
  process.exit(1);
}
const headers = API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {};

async function get(path) {
  const res = await fetch(`${HERMES}${path}`, { headers });
  const body = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${body.trim()} en ${path}`);
  return JSON.parse(body);
}

const fmt = (ts) => (ts ? new Date(ts * 1000).toISOString() : "-");

// 1) Metadatos del feed: fuente, horario y estado del mercado (no requiere API key)
const feeds = await get(`/v2/price_feeds?query=${symbol}&asset_type=${assetType}`);
const feed = feeds.find((f) => f.attributes.symbol === target);
if (!feed) {
  console.error(`No se encontró ${target}. Coincidencias:`);
  console.error(feeds.map((f) => f.attributes.symbol).join("\n"));
  process.exit(1);
}

console.log("Feed          :", feed.attributes.symbol, "-", feed.attributes.description);
console.log("ID            :", `0x${feed.id}`);
console.log("Horario       :", feed.attributes.schedule ?? "24/7");
if (feed.market_hours) {
  const { is_open, next_open, next_close } = feed.market_hours;
  console.log("Mercado       :", is_open ? "ABIERTO" : "CERRADO");
  console.log("Próx. apertura:", fmt(next_open));
  console.log("Próx. cierre  :", fmt(next_close));
}

// 2) Último precio firmado (requiere API key)
let res;
try {
  res = await get(`/v2/updates/price/latest?ids[]=${feed.id}&parsed=true`);
} catch (err) {
  console.error("\nNo se pudo obtener el precio:", err.message);
  console.error("Configura PYTH_API_KEY (ver https://docs.pyth.network) y vuelve a ejecutar.");
  process.exit(1);
}

const { price } = res.parsed[0];
const value = Number(price.price) * 10 ** price.expo;
const conf = Number(price.conf) * 10 ** price.expo;
const ageSec = Math.round(Date.now() / 1000 - price.publish_time);

console.log("Precio        :", value.toFixed(4), "USD  ±", conf.toFixed(4));
console.log("Publicado     :", fmt(price.publish_time), `(hace ${ageSec}s)`);
console.log("updateData    :", `${res.binary.data[0].slice(0, 66)}... (${res.binary.data[0].length / 2} bytes)`);
