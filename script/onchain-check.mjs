// Verifica un feed contra el contrato real de Pyth sin wallet ni gas (solo eth_call):
//   1) precio guardado on-chain (getPriceUnsafe) y su antigüedad
//   2) tarifa por publicar una actualización (getUpdateFee)
//   3) simulación de updatePriceFeeds con el precio firmado obtenido de Hermes
// Uso: node --env-file=.env script/onchain-check.mjs ETH crypto
//      node --env-file=.env script/onchain-check.mjs AAPL          (equity)
const HERMES = process.env.HERMES_URL ?? "https://hermes.pyth.network";
const RPC = process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
const PYTH = process.env.PYTH_ADDRESS ?? "0xA2aa501b19aff244D90cc15a4Cf739D2725B5729";
const headers = process.env.PYTH_API_KEY ? { Authorization: `Bearer ${process.env.PYTH_API_KEY}` } : {};

const symbol = (process.argv[2] ?? "AAPL").toUpperCase();
const assetType = (process.argv[3] ?? "equity").toLowerCase();
const target = { equity: `Equity.US.${symbol}/USD`, crypto: `Crypto.${symbol}/USD` }[assetType];

const SEL = { getPriceUnsafe: "96834ad3", getUpdateFee: "d47eed45", updatePriceFeeds: "ef9e5e28" };
const SIMULATED_SENDER = "0x000000000000000000000000000000000000dEaD";

const word = (hex, i) => BigInt(`0x${hex.slice(2 + i * 64, 2 + (i + 1) * 64)}`);
const pad = (hex) => hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
const u256 = (n) => BigInt(n).toString(16).padStart(64, "0");

// ABI de bytes[] con un solo elemento
function encodeBytesArray(dataHex) {
  return u256(0x20) + u256(1) + u256(0x20) + u256(dataHex.length / 2) + pad(dataHex);
}

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message + (json.error.data ? ` ${json.error.data}` : ""));
  return json.result;
}

function decodePrice(hex) {
  const expo = Number(BigInt.asIntN(32, word(hex, 2)));
  const publishTime = Number(word(hex, 3));
  return {
    price: Number(BigInt.asIntN(64, word(hex, 0))) * 10 ** expo,
    conf: Number(word(hex, 1)) * 10 ** expo,
    publishTime,
    ageSec: Math.round(Date.now() / 1000 - publishTime),
  };
}

const human = (s) => (s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)} min` : `${(s / 86400).toFixed(1)} días`);

// Feed
const feeds = await (await fetch(`${HERMES}/v2/price_feeds?query=${symbol}&asset_type=${assetType}`)).json();
const feed = feeds.find((f) => f.attributes.symbol === target);
if (!feed) throw new Error(`No se encontró ${target}`);
console.log(`Feed ${target}  (0x${feed.id})`);
console.log(`Red  ${RPC}  Pyth ${PYTH}\n`);

// 1) Precio on-chain
try {
  const p = decodePrice(await rpc("eth_call", [{ to: PYTH, data: `0x${SEL.getPriceUnsafe}${feed.id}` }, "latest"]));
  console.log(`1) On-chain   : ${p.price.toFixed(4)} ± ${p.conf.toFixed(4)}  publicado ${new Date(p.publishTime * 1000).toISOString()} (hace ${human(p.ageSec)})`);
} catch (err) {
  console.log(`1) On-chain   : no disponible (${err.message})`);
}

// Precio firmado desde Hermes
const res = await fetch(`${HERMES}/v2/updates/price/latest?ids[]=${feed.id}&parsed=true`, { headers });
if (!res.ok) {
  console.log(`   Hermes     : ${res.status} ${(await res.text()).trim()}`);
  console.log("   (sin precio firmado no se pueden ejecutar los pasos 2 y 3)");
  process.exit(0);
}
const update = await res.json();
const off = update.parsed[0].price;
console.log(`   Hermes     : ${(Number(off.price) * 10 ** off.expo).toFixed(4)}  publicado ${new Date(off.publish_time * 1000).toISOString()}`);
const encoded = encodeBytesArray(update.binary.data[0]);

// 2) Tarifa
const fee = BigInt(await rpc("eth_call", [{ to: PYTH, data: `0x${SEL.getUpdateFee}${encoded}` }, "latest"]));
console.log(`2) Tarifa     : ${fee} wei (${Number(fee) / 1e18} ETH)`);

// 3) Simulación de updatePriceFeeds (se le da saldo ficticio al remitente con state override)
try {
  await rpc("eth_call", [
    { from: SIMULATED_SENDER, to: PYTH, value: `0x${fee.toString(16)}`, data: `0x${SEL.updatePriceFeeds}${encoded}` },
    "latest",
    { [SIMULATED_SENDER]: { balance: "0xde0b6b3a7640000" } },
  ]);
  console.log("3) Simulación : updatePriceFeeds ACEPTADO por el contrato (firma válida)");
} catch (err) {
  console.log(`3) Simulación : RECHAZADO -> ${err.message}`);
}
