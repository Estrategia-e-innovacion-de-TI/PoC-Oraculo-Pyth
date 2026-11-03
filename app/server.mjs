// Servidor de la demo: sirve el frontend y hace de proxy hacia Hermes (Pyth)
// para que la API key nunca llegue al navegador.
// Uso: node --env-file=.env app/server.mjs   ->  http://localhost:3000
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 3000);
const HERMES = process.env.HERMES_URL ?? "https://hermes.pyth.network";
const API_KEY = process.env.PYTH_API_KEY;
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".css": "text/css" };

if (!API_KEY) console.warn("Aviso: PYTH_API_KEY no está definida; la actualización desde Pyth fallará.");

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// GET /api/price-update?id=0x...  ->  { updateData: ["0x..."], price, conf, expo, publishTime }
async function priceUpdate(id, res) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(id ?? "")) return send(res, 400, { error: "id inválido" });
  const r = await fetch(`${HERMES}/v2/updates/price/latest?ids[]=${id}&parsed=true`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  const text = await r.text();
  if (!r.ok) return send(res, r.status, { error: `Hermes ${r.status}: ${text.trim()}` });
  const json = JSON.parse(text);
  const p = json.parsed[0].price;
  send(res, 200, {
    updateData: json.binary.data.map((d) => `0x${d}`),
    price: p.price,
    conf: p.conf,
    expo: p.expo,
    publishTime: p.publish_time,
  });
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/api/price-update") return await priceUpdate(url.searchParams.get("id"), res);

    const path = normalize(join(ROOT, url.pathname === "/" ? "index.html" : url.pathname));
    if (!path.startsWith(ROOT) || path.endsWith(".mjs")) return send(res, 404, "No encontrado", "text/plain");
    send(res, 200, await readFile(path), TYPES[extname(path)] ?? "application/octet-stream");
  } catch (err) {
    if (err.code === "ENOENT") return send(res, 404, "No encontrado", "text/plain");
    console.error(err);
    send(res, 500, { error: err.message });
  }
}).listen(PORT, () => console.log(`Demo en http://localhost:${PORT}`));
