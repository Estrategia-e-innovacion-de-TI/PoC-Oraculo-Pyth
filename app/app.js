/* global ethers */
const RPC_URL = "http://127.0.0.1:8545";
const CHAIN_ID = 31337;
const REFRESH_MS = 3000;

const STATUS = [
  { label: "Precio vigente", cls: "ok" },
  { label: "Mercado cerrado · precio congelado", cls: "warn" },
  { label: "Precio vencido", cls: "bad" },
  { label: "Precio inválido", cls: "bad" },
  { label: "Oráculo sin respuesta", cls: "bad" },
];

const ABI = {
  oracle: [
    "function getPrice() view returns (tuple(uint256 price, uint256 publishTime, uint8 status))",
    "function isMarketOpen(uint256) view returns (bool)",
    "function maxAge() view returns (uint256)",
    "function forcedClosed() view returns (bool)",
    "function alwaysOpen() view returns (bool)",
    "function owner() view returns (address)",
    "function setForcedClosed(bool)",
    "function setAlwaysOpen(bool)",
    "error OwnableUnauthorizedAccount(address account)",
  ],
  vault: [
    "function nav() view returns (uint256 totalValue, uint256 sharePrice, uint256 publishTime, uint8 status)",
    "function totalSupply() view returns (uint256)",
    "function stockUnits() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function maxDeposit(address) view returns (uint256)",
    "function maxRedeem(address) view returns (uint256)",
    "function previewRedeem(uint256) view returns (uint256)",
    "function depositsWhenClosed() view returns (bool)",
    "function withdrawalsWhenClosed() view returns (bool)",
    "function deposit(uint256 assets, address receiver) returns (uint256)",
    "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
    "function setClosedMarketPolicy(bool deposits, bool withdrawals)",
    "error PriceNotUsable(uint8 status)",
    "error PriceUnavailable()",
    "error ERC4626ExceededMaxRedeem(address owner, uint256 shares, uint256 max)",
    "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
    "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  ],
  usdc: [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address, address) view returns (uint256)",
    "function approve(address, uint256) returns (bool)",
    "function mint(address, uint256)",
  ],
  pyth: [
    "function getUpdateFee(bytes[] updateData) view returns (uint256)",
    "function updatePriceFeeds(bytes[] updateData) payable",
  ],
  mock: [
    "function setPrice(bytes32 id, int64 price, uint64 conf, int32 expo, uint256 publishTime)",
    "function setDown(bool)",
    "function down() view returns (bool)",
  ],
};
const errorIface = new ethers.Interface([...ABI.oracle, ...ABI.vault].filter((f) => f.startsWith("error")));

const state = { dep: null, read: null, signer: null, account: null, owner: null, vaults: [], chainTs: 0 };
const $ = (id) => document.getElementById(id);
const fmtUsd = (v, d = 2) => `USD ${Number(v).toLocaleString("es-CO", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const usdc = (raw) => Number(ethers.formatUnits(raw, 6));
const ago = (s) => (s < 0 ? "en el futuro" : s < 120 ? `hace ${s} s` : s < 7200 ? `hace ${Math.round(s / 60)} min` : `hace ${(s / 86400).toFixed(1)} días`);

// ------------------------------------------------------------------ arranque

async function init() {
  try {
    state.dep = await (await fetch("deployments.json", { cache: "no-store" })).json();
  } catch {
    return banner("No se encontró <b>app/deployments.json</b>. Despliega los contratos primero (ver README, sección Demo).");
  }
  state.read = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
  const d = state.dep;
  state.vaults = [
    { id: "eth", name: "Bóveda ETH", sub: "Oráculo REAL de Pyth · feed Crypto.ETH/USD · 24/7", unit: "ETH",
      real: true, priceId: d.ethPriceId, vault: d.ethVault, oracle: d.ethOracle },
    { id: "aapl", name: "Bóveda AAPL", sub: "Oráculo SIMULADO (MockPyth) · horario NYSE", unit: "acciones",
      real: false, priceId: d.aaplPriceId, vault: d.aaplVault, oracle: d.aaplOracle },
  ];
  state.owner = (await contract(d.ethOracle, "oracle").owner()).toLowerCase();
  render();
  $("connect").onclick = connect;
  if (window.ethereum) {
    window.ethereum.on?.("accountsChanged", (accounts) => (accounts.length ? useAccount() : location.reload()));
    window.ethereum.on?.("chainChanged", () => location.reload());
    // Si el sitio ya estaba autorizado, reconecta sin abrir ventanas de MetaMask
    const accounts = await window.ethereum.request({ method: "eth_accounts" });
    const chainId = await window.ethereum.request({ method: "eth_chainId" });
    if (accounts.length && Number(chainId) === CHAIN_ID) await useAccount();
  }
  refresh();
  setInterval(refresh, REFRESH_MS);
}

function contract(address, kind, runner = state.read) {
  return new ethers.Contract(address, ABI[kind], runner);
}

let connecting = false;

// Orden recomendado por MetaMask: 1) permiso de cuentas, 2) red. Una sola solicitud a la vez.
async function connect() {
  if (!window.ethereum) return banner("No se detectó MetaMask en este navegador.");
  if (connecting) return;
  connecting = true;
  $("connect").disabled = true;
  try {
    await window.ethereum.request({ method: "eth_requestAccounts" });
    await ensureChain();
    await useAccount();
  } catch (err) {
    if (err.code === 4001) log("Conexión cancelada en MetaMask.", "err");
    else if (err.code === -32002) log("MetaMask ya tiene una solicitud abierta: revisa la extensión.", "err");
    else {
      log(`Conexión: ${err.message}`, "err");
      banner(`No se pudo cambiar de red automáticamente. Agrega la red a mano en MetaMask: nombre <b>PoC Local (Anvil)</b>,
        RPC <b>${RPC_URL}</b>, chain ID <b>${CHAIN_ID}</b>, símbolo <b>ETH</b>. Luego vuelve a pulsar Conectar.`);
    }
  } finally {
    connecting = false;
    $("connect").disabled = false;
  }
}

async function ensureChain() {
  const hex = `0x${CHAIN_ID.toString(16)}`;
  if ((await window.ethereum.request({ method: "eth_chainId" })) === hex) return;
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (err) {
    if (err.code !== 4902) throw err;
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: hex, chainName: "PoC Local (Anvil)", rpcUrls: [RPC_URL],
        nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 } }],
    });
  }
}

async function useAccount() {
  const provider = new ethers.BrowserProvider(window.ethereum);
  state.signer = await provider.getSigner();
  state.account = (await state.signer.getAddress()).toLowerCase();
  const isAdmin = state.account === state.owner;
  $("account").innerHTML = `${state.account.slice(0, 6)}…${state.account.slice(-4)}${isAdmin ? " · <b>administrador</b>" : ""}`;
  $("connect").textContent = "Conectado";
  document.querySelectorAll(".admin").forEach((el) => (el.style.display = isAdmin ? "" : "none"));
  banner(isAdmin ? "" : "Para los controles de escenario importa en MetaMask la cuenta 0 de Anvil (administrador).");
  refresh();
}

// ------------------------------------------------------------------ vista

function render() {
  $("vaults").innerHTML = state.vaults.map((v) => `
    <div class="card" id="${v.id}">
      <h2>${v.name}</h2>
      <p class="sub">${v.sub}</p>

      <section>
        <h3>Oráculo</h3>
        <div class="big" data-f="price">—</div>
        <div class="row" style="margin-top:4px"><span class="badge" data-f="status">—</span></div>
        <dl class="kv" style="margin-top:10px">
          <dt>Publicado</dt><dd data-f="published">—</dd>
          <dt>Mercado</dt><dd data-f="market">—</dd>
          <dt>Vigencia máxima</dt><dd data-f="maxAge">—</dd>
        </dl>
        ${v.real ? `<div class="row"><button data-a="pyth">Actualizar precio desde Pyth</button></div>` : ""}
      </section>

      <section>
        <h3>Bóveda</h3>
        <div class="muted">Valor por participación</div>
        <div class="big" data-f="share">—</div>
        <dl class="kv" style="margin-top:10px">
          <dt>Valor total (NAV)</dt><dd data-f="nav">—</dd>
          <dt>Respaldo</dt><dd data-f="units">—</dd>
          <dt>Participaciones emitidas</dt><dd data-f="supply">—</dd>
          <dt>Caja mUSDC de la bóveda</dt><dd data-f="cash">—</dd>
        </dl>
        <div class="explain" data-f="explain"></div>
      </section>

      <section>
        <h3>Mi posición</h3>
        <dl class="kv">
          <dt>mUSDC</dt><dd data-f="myUsdc">—</dd>
          <dt>Participaciones</dt><dd data-f="myShares">—</dd>
          <dt>Valor</dt><dd data-f="myValue">—</dd>
        </dl>
        <div class="row">
          <input type="number" min="0" step="any" value="100" data-i="dep" />
          <button class="primary" data-a="deposit">Depositar mUSDC</button>
        </div>
        <div class="row">
          <input type="number" min="0" step="any" value="50" data-i="red" />
          <button data-a="redeem">Redimir participaciones</button>
        </div>
        <div class="row"><button data-a="faucet">Recibir 1.000 mUSDC de prueba</button></div>
      </section>

      <section class="admin" style="display:none">
        <h3>Escenarios (administrador)</h3>
        ${v.real ? "" : `
        <div class="row">
          <input type="number" min="0" step="any" value="225" data-i="px" />
          <button class="primary" data-a="setPrice">Publicar precio</button>
        </div>
        <div class="row"><button data-a="down">Simular oráculo caído</button></div>`}
        <div class="row">
          <button data-a="forceClose">Cerrar mercado (feriado)</button>
          ${v.real ? "" : `<button data-a="alwaysOpen">Simular mercado abierto</button>`}
        </div>
        <div class="row">
          <button data-a="polDep">Depósitos en cierre</button>
          <button data-a="polRed">Retiros en cierre</button>
        </div>
        <div class="row"><button data-a="settle">Liquidar custodio</button></div>
        <p class="muted" style="margin:8px 0 0">"Liquidar custodio" simula que el custodio vende/compra la acción y deja en la bóveda la caja necesaria para pagar retiros con ganancia.</p>
      </section>
    </div>`).join("");

  for (const v of state.vaults) {
    document.querySelectorAll(`#${v.id} [data-a]`).forEach((b) => (b.onclick = () => action(v, b.dataset.a)));
  }
}

const field = (v, f) => document.querySelector(`#${v.id} [data-f="${f}"]`);
const input = (v, i) => document.querySelector(`#${v.id} [data-i="${i}"]`).value;
const button = (v, a) => document.querySelector(`#${v.id} [data-a="${a}"]`);

async function refresh() {
  try {
    state.chainTs = (await state.read.getBlock("latest")).timestamp;
  } catch {
    return banner(`No hay conexión con la blockchain local en ${RPC_URL}. ¿Está corriendo Anvil?`);
  }
  for (const v of state.vaults) {
    try {
      await refreshVault(v);
    } catch (err) {
      field(v, "explain").textContent = `Error leyendo contratos: ${err.shortMessage ?? err.message}`;
    }
  }
}

async function refreshVault(v) {
  const oracle = contract(v.oracle, "oracle");
  const vault = contract(v.vault, "vault");
  const token = contract(state.dep.usdc, "usdc");

  const [p, open, maxAge, forced, always, nav, supply, units, cash, polDep, polRed] = await Promise.all([
    oracle.getPrice(), oracle.isMarketOpen(state.chainTs), oracle.maxAge(), oracle.forcedClosed(), oracle.alwaysOpen(),
    vault.nav(), vault.totalSupply(), vault.stockUnits(), token.balanceOf(v.vault),
    vault.depositsWhenClosed(), vault.withdrawalsWhenClosed(),
  ]);
  const st = STATUS[Number(p.status)];
  const price = Number(ethers.formatUnits(p.price, 18));
  const age = state.chainTs - Number(p.publishTime);

  field(v, "price").textContent = p.price > 0n ? fmtUsd(price) : "—";
  field(v, "status").textContent = st.label;
  field(v, "status").className = `badge ${st.cls}`;
  field(v, "published").textContent = Number(p.publishTime) ? `${new Date(Number(p.publishTime) * 1000).toLocaleString("es-CO")} (${ago(age)})` : "—";
  field(v, "market").textContent = open ? "Abierto" : "Cerrado";
  field(v, "maxAge").textContent = `${Number(maxAge) / 60} min`;

  const sharePrice = usdc(nav.sharePrice);
  field(v, "share").textContent = supply > 0n ? fmtUsd(sharePrice, 4) : "Sin participaciones";
  field(v, "nav").textContent = fmtUsd(usdc(nav.totalValue));
  field(v, "units").textContent = `${Number(ethers.formatUnits(units, 18)).toFixed(6)} ${v.unit}`;
  field(v, "supply").textContent = usdc(supply).toLocaleString("es-CO");
  field(v, "cash").textContent = fmtUsd(usdc(cash));
  field(v, "explain").innerHTML = explain(Number(p.status), polDep, polRed, Number(maxAge));

  if (state.account) {
    const [myUsdc, myShares] = await Promise.all([token.balanceOf(state.account), vault.balanceOf(state.account)]);
    field(v, "myUsdc").textContent = usdc(myUsdc).toLocaleString("es-CO");
    field(v, "myShares").textContent = usdc(myShares).toLocaleString("es-CO");
    field(v, "myValue").textContent = supply > 0n ? fmtUsd(usdc(myShares) * sharePrice) : "—";
  }

  const mark = (a, on) => button(v, a)?.classList.toggle("on", on);
  mark("forceClose", forced);
  mark("alwaysOpen", always);
  mark("polDep", polDep);
  mark("polRed", polRed);
  if (!v.real) mark("down", await contract(state.dep.mockPyth, "mock").down());
}

function explain(status, polDep, polRed, maxAge) {
  const yes = (b) => (b ? "<b>permitidos</b>" : "<b>rechazados</b>");
  switch (status) {
    case 0: return "Precio vigente: depósitos y retiros se procesan al precio actual del oráculo (CA3–CA4).";
    case 1: return `La bolsa está cerrada y el oráculo mantiene el último precio. Política actual: depósitos ${yes(polDep)}, retiros ${yes(polRed)} (CA6).`;
    case 2: return `El precio superó la vigencia de ${maxAge / 60} min. La bóveda no lo usa como si estuviera actualizado y rechaza operaciones (CA5).`;
    case 3: return "El precio es inválido (≤ 0 o intervalo de confianza demasiado amplio). Operaciones rechazadas.";
    default: return "El oráculo no responde. Operaciones rechazadas y la valoración se informa como no disponible.";
  }
}

// ------------------------------------------------------------------ acciones

async function action(v, a) {
  if (!state.signer) return log("Conecta MetaMask primero.", "err");
  const w = (addr, kind) => contract(addr, kind, state.signer);
  const vault = w(v.vault, "vault");
  const oracle = w(v.oracle, "oracle");
  const token = w(state.dep.usdc, "usdc");
  const btn = button(v, a);
  btn.disabled = true;
  try {
    switch (a) {
      case "deposit": {
        const amount = ethers.parseUnits(input(v, "dep") || "0", 6);
        if ((await token.allowance(state.account, v.vault)) < amount) {
          await send(`${v.name}: aprobar mUSDC`, token.approve(v.vault, ethers.MaxUint256));
        }
        await send(`${v.name}: depositar ${ethers.formatUnits(amount, 6)} mUSDC`, vault.deposit(amount, state.account));
        break;
      }
      case "redeem": {
        const shares = ethers.parseUnits(input(v, "red") || "0", 6);
        await send(`${v.name}: redimir ${ethers.formatUnits(shares, 6)} participaciones`, vault.redeem(shares, state.account, state.account));
        break;
      }
      case "faucet":
        await send("Recibir 1.000 mUSDC", token.mint(state.account, 1_000_000_000n));
        break;
      case "pyth": {
        const r = await fetch(`api/price-update?id=${v.priceId}`);
        const u = await r.json();
        if (!r.ok) throw new Error(u.error);
        const pyth = w(state.dep.pyth, "pyth");
        const fee = await pyth.getUpdateFee(u.updateData);
        const px = Number(u.price) * 10 ** u.expo;
        await send(`Pyth: publicar precio firmado ${fmtUsd(px)} (tarifa ${fee} wei)`, pyth.updatePriceFeeds(u.updateData, { value: fee }));
        break;
      }
      case "setPrice": {
        const px = Number(input(v, "px"));
        const raw = BigInt(Math.round(px * 1e5));
        await send(`Oráculo simulado: precio ${fmtUsd(px)}`, w(state.dep.mockPyth, "mock").setPrice(v.priceId, raw, raw / 2000n, -5, state.chainTs));
        break;
      }
      case "down": {
        const mock = w(state.dep.mockPyth, "mock");
        const now = await mock.down();
        await send(now ? "Oráculo simulado: restablecer" : "Oráculo simulado: caída", mock.setDown(!now));
        break;
      }
      case "forceClose": {
        const now = await oracle.forcedClosed();
        await send(now ? "Reabrir mercado" : "Cerrar mercado (feriado)", oracle.setForcedClosed(!now));
        break;
      }
      case "alwaysOpen": {
        const now = await oracle.alwaysOpen();
        await send(now ? "Volver al horario NYSE" : "Simular mercado abierto", oracle.setAlwaysOpen(!now));
        break;
      }
      case "polDep":
      case "polRed": {
        const [d, r] = await Promise.all([vault.depositsWhenClosed(), vault.withdrawalsWhenClosed()]);
        const nd = a === "polDep" ? !d : d;
        const nr = a === "polRed" ? !r : r;
        await send(`Política en cierre: depósitos ${nd ? "sí" : "no"}, retiros ${nr ? "sí" : "no"}`, vault.setClosedMarketPolicy(nd, nr));
        break;
      }
      case "settle": {
        const [nav, cash] = await Promise.all([vault.nav(), token.balanceOf(v.vault)]);
        const gap = nav.totalValue - cash;
        if (gap <= 0n) {
          log(`${v.name}: la caja ya cubre el NAV, no hay nada que liquidar.`, "okl");
          break;
        }
        await send(`${v.name}: custodio liquida ${fmtUsd(usdc(gap))}`, token.mint(v.vault, gap));
        break;
      }
    }
  } catch (err) {
    log(describeError(err), "err");
  } finally {
    btn.disabled = false;
    refresh();
  }
}

async function send(label, txPromise) {
  const tx = await txPromise;
  log(`${label} · enviada ${tx.hash.slice(0, 10)}…`);
  await tx.wait();
  log(`${label} · confirmada`, "okl");
}

function describeError(err) {
  const data = findRevertData(err);
  if (data) {
    try {
      const e = errorIface.parseError(data);
      if (e.name === "PriceNotUsable") return `Operación rechazada por la bóveda: ${STATUS[Number(e.args[0])].label}.`;
      if (e.name === "PriceUnavailable") return "Operación rechazada: el oráculo no entrega precio.";
      if (e.name === "OwnableUnauthorizedAccount") return "Solo el administrador puede ejecutar este escenario.";
      if (e.name === "ERC20InsufficientBalance") return "Saldo insuficiente. Si es un retiro con ganancia, usa \"Liquidar custodio\" primero.";
      if (e.name === "ERC4626ExceededMaxRedeem") return "No tienes tantas participaciones, o la bóveda no permite retiros ahora.";
      return `Revertido: ${e.name}`;
    } catch { /* error no reconocido */ }
  }
  if (err.code === "ACTION_REJECTED") return "Transacción cancelada en MetaMask.";
  return err.shortMessage ?? err.message;
}

function findRevertData(err) {
  const candidates = [err.data, err.info?.error?.data, err.info?.error?.data?.data, err.error?.data, err.error?.data?.data];
  return candidates.find((d) => typeof d === "string" && d.startsWith("0x") && d.length >= 10);
}

function log(msg, cls = "") {
  const el = $("log");
  if (el.firstElementChild?.classList.contains("muted")) el.innerHTML = "";
  const row = document.createElement("div");
  row.className = cls;
  row.textContent = `${new Date().toLocaleTimeString("es-CO")}  ${msg}`;
  el.prepend(row);
}

function banner(html) {
  $("banner").style.display = html ? "block" : "none";
  $("banner").innerHTML = html;
}

init();
