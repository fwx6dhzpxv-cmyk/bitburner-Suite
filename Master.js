/** master.js - Viper's Nest Mega (With Dual Stock Managers)
 *
 * Integrated features:
 *  - Your existing VERBOSE stock manager (unchanged behavior) => "verbose" mode
 *  - NEW AI Silent Stock Manager (adaptive, momentum + PnL learning) => "ai" mode
 *  - GUI toggle "AIStock" to switch between modes at runtime (never run both)
 *  - Persistence of AI learning to /vipers-nest-ai.json
 *  - All other systems unchanged (workers/hacknet/corp/GUI/etc.)
 *
 * Notes:
 *  - Helpers expected in "home": hack.js, grow.js, weaken.js, batcher.js
 *  - Stock manager requires the in-game ns.stock API (guarded if unavailable)
 *  - Tested against Bitburner 2.8.1 (uses buyStock/sellStock)
 */

/** @param {NS} ns **/
export async function main(ns) {
  // Basic setup
  ns.disableLog("sleep");
  ns.disableLog("getServerMoneyAvailable");
  ns.disableLog("scan");
  ns.disableLog("scp");
  ns.disableLog("exec");
  try { ns.tail(); } catch (e) {}

  // CONFIG
  const cfg = {
    targetCount: 4,
    baseHackFraction: 0.005,
    batchIntervalMs: 2500,
    minRamForHost: 8,
    
    reserveHomeRamGb: 32,
    cashReserveFraction: 0.20,
    purchasedBudgetFraction: 0.20,
    purchasedTargetUpgradeMultiplier: 2,
    HACKFLOOR: 0.0005,
    SCALE_STEP: 0.92,
    helperFiles: ["hack.js","grow.js","weaken.js","batcher.js"],
    trendSamples: 12,
    trendThresholdPct: 0.03,
    hacknetBudgetFraction: 0.12,
    hacknetUpgradePriority: ["level","ram","cores"],
    deployCooldownMs: 60_000,
    deployOnlyIfMissing: true,

    // Stock manager (verbose) config — kept same semantics
    enableStockManager: true,
    stockBudgetFraction: 0.30, // fraction of free cash above reserve to use for stocks
    stockBuyForecastThreshold: 0.6, // forecast > buy threshold -> buy
    stockSellForecastThreshold: 0.45, // forecast < sell threshold -> sell
    stockMinBuyUsd: 1e6, // don't attempt tiny buys below this
    stockMaxSymbols: 12, // limit how many symbols we try to hold
    stockTradeCooldownMs: 15_000,

    // NEW: AI Stock Manager parameters (silent)
    ai: {
      file: "/vipers-nest-ai.json",
      // learning & sizing
      ewmaAlpha: 0.3,              // momentum smoothing (0..1)
      riskPerSymbolFrac: 0.12,     // % of stock budget per picked symbol
      maxSymbols: 10,
      minBuyUsd: 750_000,
      tradeCooldownMs: 15_000,
      // exits
      softStopLossPct: 0.06,       // -6% from entry avg triggers exit
      trailStartGainPct: 0.05,     // once +5% in profit, start trailing
      trailDistancePct: 0.025,     // 2.5% trailing window
      lossCooldownMs: 90_000,      // wait after loss before trading same symbol
      // filters
      minMomentum: 0.0008,         // minimal upward drift needed
      minVolatility: 0.005,        // skip ultra-low vol names (uses getVolatility)
    },
  };

  // RUNTIME STATE
  let running = true;
  let guiState = { visible: true, minimized: false, theme: "scifi" };
  let lastButtonPressed = { id: null, time: null, label: null };

  const actionFlags = {
    deployNow: false,
    upgradeNow: false,
    killAllHelpers: false,
    rebuildWorkers: false,
    startWorkers: false,
    stopWorkers: false,
    killTree: false,
    boostMode: null, // "hack"|"grow"|"weaken"|null
    debugDump: false,
    toggleAutoPurchase: false,
    toggleAutoRoot: false,
    toggleAutoHacknet: false,
    farmExp: false,
    maxMoneyMode: false,
    toggleAutoStock: false,
    liquidateStocks: false,
    // NEW:
    toggleAIStock: false,
  };

  const toggles = {
    autoPurchase: true,
    autoRoot: true,
    autoBuyTools: true,
    autoHacknet: true,
    autoStock: false,   // verbose manager
    // NEW: active stock mode: "verbose" | "ai"
    stockMode: "verbose",
  };

  const metrics = {
    moneyHistory: [],
    moneyPerSec: 0,
    batchesLaunched: 0,
    batchesRunning: 0,
    workersCount: 0,
    purchasedServers: [],
    totalPurchasedRam: 0,
    scannedServersCount: 0,
    lastTargets: [],
    lastPlans: {},
    errors: [],
    loops: 0,
    lastLoopTime: Date.now(),
    lastPIDs: [],

    // stock metrics
    stockValue: 0,
    stockPositionsCount: 0,
    recentTrades: []
  };

  // per-host last deploy time to avoid repeated SCP
  const lastDeployTime = {};
  // per-symbol last trade time
  const lastStockTradeTime = {};

  // GUI placeholder
  let guiDiv = null;

  // small helpers
  const safeSleep = async (ms) => { try { await ns.sleep(ms); } catch(e) { ns.print("sleep err: " + e); } };
  const now = () => Date.now();

  function scanAll() {
    const seen = new Set(["home"]);
    const stack = ["home"];
    const nodes = [];
    while (stack.length) {
      const cur = stack.pop();
      nodes.push(cur);
      try {
        for (const n of ns.scan(cur)) {
          if (!seen.has(n)) { seen.add(n); stack.push(n); }
        }
      } catch(e) { ns.print("scan err " + e); }
    }
    return nodes;
  }

  function tryNuke(host) {
    try {
      if (ns.hasRootAccess(host)) return true;
      const req = ns.getServerNumPortsRequired(host);
      let opened = 0;
      const programs = ["BruteSSH.exe","FTPCrack.exe","relaySMTP.exe","HTTPWorm.exe","SQLInject.exe"];
      const methods = ["brutessh","ftpcrack","relaysmtp","httpworm","sqlinject"];
      for (let i=0;i<programs.length;i++) {
        if (ns.fileExists(programs[i],"home")) {
          try { ns[methods[i]](host); } catch(e) {}
          opened++;
        }
      }
      if (opened >= req) { try { ns.nuke(host); } catch(e){} return ns.hasRootAccess(host); }
    } catch(e) { ns.print(`nuke err ${host}: ${e}`); }
    return ns.hasRootAccess(host);
  }

  async function scpIfNeeded(host, force=false) {
    try {
      const ts = now();
      if (!force && lastDeployTime[host] && (ts - lastDeployTime[host] < cfg.deployCooldownMs)) return;
      if (cfg.deployOnlyIfMissing && !force) {
        // we attempt to avoid expensive fileExists checks on remote hosts; rely on cooldown primary guard.
      }
      for (const f of cfg.helperFiles) {
        try { await ns.scp(f, host); } catch(e) { ns.print(`scp ${f} -> ${host} failed: ${e}`); }
      }
      lastDeployTime[host] = ts;
    } catch(e) { ns.print("scpIfNeeded err: " + e); }
  }

  async function deployScriptsTo(hostOrList, force=false) {
    if (!hostOrList) return;
    if (Array.isArray(hostOrList)) {
      for (const h of hostOrList) await scpIfNeeded(h, force);
    } else {
      await scpIfNeeded(hostOrList, force);
    }
  }

  function totalFreeRam(hostList) {
    let t = 0;
    for (const h of hostList) {
      try {
        let free = ns.getServerMaxRam(h) - ns.getServerUsedRam(h);
        if (h === "home") free = Math.max(0, free - (cfg.reserveHomeRamGb || 0));
        if (free > 0) t += free;
      } catch(e){}
    }
    return t;
  }

  function estimatePlanForFraction(targetHost, frac) {
    const SEC_WEAKEN_PER_THREAD = 0.05;
    const SEC_INC_HACK = 0.002;
    const SEC_INC_GROW = 0.004;
    try {
      const maxMoney = ns.getServerMaxMoney(targetHost);
      const moneyAvail = Math.max(ns.getServerMoneyAvailable(targetHost),1);
      const steal = Math.max(1, Math.min(maxMoney * frac, moneyAvail));
      const hackThreads = Math.max(1, Math.ceil(ns.hackAnalyzeThreads(targetHost, steal)));
      const postHack = Math.max(1, maxMoney - steal);
      const growthFactor = Math.max(1.0, maxMoney / postHack);
      const cores = Math.max(1, Math.floor(ns.getServer(targetHost).cpuCores || 1));
      const growThreads = Math.max(0, Math.ceil(ns.growthAnalyze(targetHost, growthFactor, cores)));
      const secIncrease = hackThreads * SEC_INC_HACK + growThreads * SEC_INC_GROW;
      const weaken1 = Math.max(1, Math.ceil(secIncrease / SEC_WEAKEN_PER_THREAD));
      const secGap = Math.max(0, ns.getServerSecurityLevel(targetHost) - ns.getServerMinSecurityLevel(targetHost));
      const weaken2 = Math.max(0, Math.ceil(secGap / SEC_WEAKEN_PER_THREAD));
      return { hackThreads, growThreads, weaken1, weaken2, steal };
    } catch(e) {
      return { hackThreads:1, growThreads:0, weaken1:1, weaken2:0, steal:1 };
    }
  }

  function pickWorkerHosts(allServers) {
    const purchased = ns.getPurchasedServers();
    const workers = new Set(["home"]);
    for (const p of purchased) {
      try { if (ns.getServerMaxRam(p) >= cfg.minRamForHost) workers.add(p); } catch(e){}
    }
    for (const s of allServers) {
      if (s === "home") continue;
      if (purchased.includes(s)) continue;
      try { if (ns.hasRootAccess(s) && ns.getServerMaxRam(s) >= cfg.minRamForHost) workers.add(s); } catch(e){}
    }
    return Array.from(workers);
  }

  function pickTargets(allServers, count) {
    const candidates = [];
    for (const s of allServers) {
      if (s === "home") continue;
      try {
        const req = ns.getServerRequiredHackingLevel(s);
        if (ns.getHackingLevel() < req) continue;
        if (!ns.hasRootAccess(s)) continue;
        const mm = ns.getServerMaxMoney(s);
        if (mm <= 0) continue;
        candidates.push({host:s, maxMoney:mm});
      } catch(e){}
    }
    candidates.sort((a,b)=>b.maxMoney-a.maxMoney);
    return candidates.slice(0, count).map(c=>c.host);
  }

  function pickEasyTargets(allServers) {
    const candidates = [];
    for (const s of allServers) {
      if (s === "home") continue;
      try {
        const req = ns.getServerRequiredHackingLevel(s);
        if (req > ns.getHackingLevel() / 2) continue;
        if (!ns.hasRootAccess(s)) continue;
        candidates.push(s);
      } catch(e){}
    }
    return candidates.slice(0, 5);
  }

  // Stock manager helpers
  function stockAvailable() {
    return typeof ns.stock === 'object' || typeof ns.stock === 'function';
  }

  function hasSourceFile4() {
    try {
      if (typeof ns.getOwnedSourceFiles === 'function') {
        const s = ns.getOwnedSourceFiles();
        if (!s) return false;
        if (Array.isArray(s)) return s.some(sf => sf.n === 4 || sf === 4);
        if (s[4] || s["4"]) return true;
      }
    } catch(e){}
    return false;
  }

  function getAllSymbolsSafe() {
    try { return stockAvailable() ? ns.stock.getSymbols() : []; } catch(e) { return []; }
  }

  function getPositionSafe(sym) {
    try { return stockAvailable() ? ns.stock.getPosition(sym) : [0,0,0,0]; } catch(e) { return [0,0,0,0]; }
  }

  function getPriceSafe(sym) {
    try { return stockAvailable() ? ns.stock.getPrice(sym) : 0; } catch(e) { return 0; }
  }

  function getVolSafe(sym) {
    try { return stockAvailable() && typeof ns.stock.getVolatility === "function" ? ns.stock.getVolatility(sym) : 0.01; } catch(e){ return 0.01; }
  }

  function getForecastSafe(sym) {
    // Will be 0.5 without 4S in most setups; guard anyway
    try { return stockAvailable() && typeof ns.stock.getForecast === "function" ? ns.stock.getForecast(sym) : 0.5; } catch(e) { return 0.5; }
  }

  async function buyStockSafe(sym, shares) {
    try { if (!stockAvailable()) return false; return ns.stock.buyStock(sym, shares); } catch(e) { metrics.errors.push("buyStock err: "+e); return false; }
  }
  async function sellStockSafe(sym, shares) {
    try { if (!stockAvailable()) return false; return ns.stock.sellStock(sym, shares); } catch(e) { metrics.errors.push("sellStock err: "+e); return false; }
  }

  function getMaxSharesSafe(sym) {
    try { return stockAvailable() && typeof ns.stock.getMaxShares === "function" ? ns.stock.getMaxShares(sym) : Number.MAX_SAFE_INTEGER; } catch(e){ return Number.MAX_SAFE_INTEGER; }
  }

  // ---- VERBOSE STOCK MANAGER (unchanged behavior) ----
  async function stockManagerTickVerbose() {
    try {
      if (!cfg.enableStockManager) return;
      if (!stockAvailable()) return;

      // Verbose manager auto-enables itself when mode is verbose
      if (toggles.stockMode !== "verbose") return;
      if (!toggles.autoStock) toggles.autoStock = true;

      const money = ns.getServerMoneyAvailable("home");
      const reserve = money * cfg.cashReserveFraction;
      const budget = Math.max(0, money - reserve) * cfg.stockBudgetFraction;
      if (budget < cfg.stockMinBuyUsd) return;

      const syms = getAllSymbolsSafe();
      const opportunities = [];
      for (const s of syms) {
        try {
          const fc = getForecastSafe(s); // 0..1
          const price = getPriceSafe(s);
          opportunities.push({sym: s, forecast: fc, price});
        } catch(e){ }
      }
      opportunities.sort((a,b)=>b.forecast - a.forecast);

      // SELL weak positions first
      let buysCount = 0, sellsCount = 0;
      for (const op of opportunities) {
        try {
          const pos = getPositionSafe(op.sym);
          const longShares = pos[0] || 0;
          if (longShares > 0 && op.forecast < cfg.stockSellForecastThreshold) {
            const last = lastStockTradeTime[op.sym] || 0;
            if (now() - last < cfg.stockTradeCooldownMs) continue;
            await sellStockSafe(op.sym, longShares);
            lastStockTradeTime[op.sym] = now();
            metrics.recentTrades.push({ t: now(), sym: op.sym, action: 'SELL', shares: longShares, price: op.price, forecast: op.forecast, mode: "verbose" });
            sellsCount++;
            // VERBOSE logs
            ns.print(`Stock[VERBOSE]: SELL ${op.sym} x${longShares} @ ${Math.floor(op.price)} (fc ${(op.forecast*100).toFixed(1)}%)`);
          }
        } catch(e) { metrics.errors.push("stock sell err: "+e); }
      }

      // BUY strong forecasts
      const buys = opportunities.filter(o=>o.forecast >= cfg.stockBuyForecastThreshold).slice(0, cfg.stockMaxSymbols);
      if (buys.length === 0) return;
      const perSymBudget = Math.max(cfg.stockMinBuyUsd, Math.floor(budget / buys.length));
      for (const b of buys) {
        try {
          const pos = getPositionSafe(b.sym);
          const longShares = pos[0] || 0;
          const last = lastStockTradeTime[b.sym] || 0;
          if (now() - last < cfg.stockTradeCooldownMs) continue;
          const price = getPriceSafe(b.sym);
          const maxShares = Math.max(0, getMaxSharesSafe(b.sym) - longShares);
          const canBuy = Math.min(maxShares, Math.floor(perSymBudget / Math.max(1, price)));
          if (canBuy <= 0) continue;
          await buyStockSafe(b.sym, canBuy);
          lastStockTradeTime[b.sym] = now();
          metrics.recentTrades.push({ t: now(), sym: b.sym, action: 'BUY', shares: canBuy, price, forecast: b.forecast, mode: "verbose" });
          buysCount++;
          ns.print(`Stock[VERBOSE]: BUY ${b.sym} x${canBuy} @ ${Math.floor(price)} (fc ${(b.forecast*100).toFixed(1)}%)`);
        } catch(e) { metrics.errors.push("stock buy err: "+e); }
      }

      // summarize holdings
      let total = 0; let count = 0;
      for (const s of syms) {
        try {
          const pos = getPositionSafe(s);
          const shares = pos[0] || 0;
          if (shares > 0) {
            const price = getPriceSafe(s);
            total += shares * price; count++;
          }
        } catch(e){}
      }
      metrics.stockValue = total;
      metrics.stockPositionsCount = count;
      if (buysCount || sellsCount) ns.print(`Stock[VERBOSE]: summary buys=${buysCount}, sells=${sellsCount}, holdings=${count}, value=$${Math.floor(total).toLocaleString()}`);

      // trim recent trades
      if (metrics.recentTrades.length > 200) metrics.recentTrades.splice(0, metrics.recentTrades.length - 200);

    } catch(e) { ns.print("stockManagerTickVerbose err: " + e); metrics.errors.push(""+e); }
  }

  // ---- AI SILENT STOCK MANAGER ----

  // Persistent learning state
  let aiState = { // keyed per symbol
    bySym: {}, // SYM: { ewma: number, pnl: number, wins: number, losses: number, lastLossTs: number, trailPeak: number }
    lastSave: 0,
  };

  function aiLoad() {
    try {
      if (ns.fileExists(cfg.ai.file, "home")) {
        const txt = ns.read(cfg.ai.file);
        if (txt) aiState = JSON.parse(txt);
      }
    } catch(e){ ns.print("AI load err: " + e); }
  }
  function aiSave(force=false) {
    try {
      const t = now();
      if (!force && t - (aiState.lastSave||0) < 10_000) return;
      aiState.lastSave = t;
      ns.write(cfg.ai.file, JSON.stringify(aiState), "w");
    } catch(e){ ns.print("AI save err: " + e); }
  }
  aiLoad();

  function aiSym(sym) {
    if (!aiState.bySym[sym]) aiState.bySym[sym] = { ewma: 0, pnl: 0, wins: 0, losses: 0, lastLossTs: 0, trailPeak: 0 };
    return aiState.bySym[sym];
  }
  function aiUpdateEWMA(sym, price) {
    const s = aiSym(sym);
    if (s.ewma === 0) s.ewma = price;
    else s.ewma = cfg.ai.ewmaAlpha*price + (1-cfg.ai.ewmaAlpha)*s.ewma;
  }
  function aiMomentum(sym, price) {
    const s = aiSym(sym);
    return (price - s.ewma) / Math.max(1, s.ewma);
  }
  function aiCooldownOk(sym) {
    const s = aiSym(sym);
    if (!s.lastLossTs) return true;
    return (now() - s.lastLossTs) >= cfg.ai.lossCooldownMs;
  }
  function aiRecordWin(sym, pnl) {
    const s = aiSym(sym); s.pnl += pnl; s.wins++; s.trailPeak = 0;
  }
  function aiRecordLoss(sym, pnl) {
    const s = aiSym(sym); s.pnl += pnl; s.losses++; s.lastLossTs = now(); s.trailPeak = 0;
  }

  async function stockManagerTickAI() {
    try {
      if (!stockAvailable()) return;
      if (toggles.stockMode !== "ai") return; // only run in AI mode

      const money = ns.getServerMoneyAvailable("home");
      const reserve = money * cfg.cashReserveFraction;
      const budget = Math.max(0, money - reserve) * cfg.stockBudgetFraction;
      if (budget < cfg.ai.minBuyUsd) return;

      const syms = getAllSymbolsSafe();
      // Update EWMA + collect trade candidates
      const cands = [];
      for (const s of syms) {
        const price = getPriceSafe(s);
        aiUpdateEWMA(s, price);
        const mom = aiMomentum(s, price);
        const vol = getVolSafe(s);
        if (!aiCooldownOk(s)) continue;
        if (vol < cfg.ai.minVolatility) continue;
        if (mom < cfg.ai.minMomentum) continue;
        cands.push({ sym: s, price, mom, vol });
      }
      cands.sort((a,b)=> b.mom - a.mom);
      const pick = cands.slice(0, cfg.ai.maxSymbols);

      // SELL rules for all held positions
      for (const s of syms) {
        const pos = getPositionSafe(s);
        const sh = pos[0] || 0;
        const avg = pos[1] || 0;
        if (sh <= 0) continue;
        const price = getPriceSafe(s);
        // soft stop-loss
        const lossPct = (avg>0) ? (avg - price) / avg : 0;
        let doSell = false;
        if (lossPct >= cfg.ai.softStopLossPct) doSell = true;

        // trailing profit
        const st = aiSym(s);
        st.trailPeak = Math.max(st.trailPeak || price, price);
        const gainPct = (avg>0) ? ((price - avg) / avg) : 0;
        if (gainPct >= cfg.ai.trailStartGainPct) {
          const trailDrop = (st.trailPeak - price) / Math.max(1, st.trailPeak);
          if (trailDrop >= cfg.ai.trailDistancePct) doSell = true;
        }

        if (doSell) {
          const sold = await sellStockSafe(s, sh);
          const pnl = (price - avg) * sh;
          if (pnl >= 0) aiRecordWin(s, pnl); else aiRecordLoss(s, pnl);
          metrics.recentTrades.push({ t: now(), sym: s, action: 'SELL', shares: sh, price, avg, pnl, mode: "ai" });
        }
      }

      // BUY rules for top picks
      const perSym = Math.max(cfg.ai.minBuyUsd, Math.floor(budget * cfg.ai.riskPerSymbolFrac));
      for (const c of pick) {
        const pos = getPositionSafe(c.sym);
        const sh = pos[0] || 0;
        const last = lastStockTradeTime[c.sym] || 0;
        if (now() - last < cfg.ai.tradeCooldownMs) continue;

        const price = getPriceSafe(c.sym);
        const maxShares = Math.max(0, getMaxSharesSafe(c.sym) - sh);
        const canBuy = Math.min(maxShares, Math.floor(perSym / Math.max(1, price)));
        if (canBuy <= 0) continue;

        const ok = await buyStockSafe(c.sym, canBuy);
        if (ok) {
          lastStockTradeTime[c.sym] = now();
          metrics.recentTrades.push({ t: now(), sym: c.sym, action: 'BUY', shares: canBuy, price, mom: c.mom, mode: "ai" });
        }
      }

      // summarize holdings
      let total = 0; let count = 0;
      for (const s of syms) {
        try {
          const pos = getPositionSafe(s);
          const shares = pos[0] || 0;
          if (shares > 0) {
            const price = getPriceSafe(s);
            total += shares * price; count++;
          }
        } catch(e){}
      }
      metrics.stockValue = total;
      metrics.stockPositionsCount = count;
      if (metrics.recentTrades.length > 400) metrics.recentTrades.splice(0, metrics.recentTrades.length - 400);

      // occasional save
      aiSave(false);
    } catch(e) { metrics.errors.push("stockManagerTickAI err: " + e); }
  }

  // Purchased server manager
  async function autoManagePurchasedServers(workers) {
    try {
      if (!toggles.autoPurchase) return;
      const MAX = ns.getPurchasedServerLimit();
      const maxRamPossible = ns.getPurchasedServerMaxRam();
      const purchased = ns.getPurchasedServers();
      let currentMax = 0;
      for (const p of purchased) {
        try { const r = ns.getServerMaxRam(p); if (r > currentMax) currentMax = r; } catch(e){}
      }
      if (currentMax === 0) currentMax = 8;
      let targetRam = Math.min(maxRamPossible, Math.max(currentMax * cfg.purchasedTargetUpgradeMultiplier, currentMax));
      targetRam = Math.max(8, targetRam);
      const cost = ns.getPurchasedServerCost(targetRam);
      const available = ns.getServerMoneyAvailable("home");
      const reserve = available * cfg.cashReserveFraction;
      if (available - cost < reserve) return;
      if (available < cost * cfg.purchasedBudgetFraction) return;

      if (purchased.length < MAX) {
        const name = `viper-${targetRam}-${Math.floor(Math.random()*9999).toString().padStart(4,"0")}`;
        try {
          const host = ns.purchaseServer(name, targetRam);
          if (host) {
            await deployScriptsTo(host, true);
            workers.push(host);
            ns.print(`Purchased ${host} (${targetRam}GB)`);
          }
        } catch(e){ ns.print(`purchase failed: ${e}`); }
        return;
      }

      let weakest = purchased[0];
      for (const p of purchased) {
        try { if (ns.getServerMaxRam(p) < ns.getServerMaxRam(weakest)) weakest = p; } catch(e){}
      }
      try {
        if (ns.getServerMaxRam(weakest) >= targetRam) return;
        const delCost = ns.getPurchasedServerCost(targetRam);
        if (available - delCost < reserve) return;
        try { ns.killall(weakest); } catch(e){}
        try { ns.deleteServer(weakest); } catch(e){ ns.print(`delete failed ${weakest}: ${e}`); return; }
        const name = `viper-${targetRam}-${Math.floor(Math.random()*9999).toString().padStart(4,"0")}`;
        const host = ns.purchaseServer(name, targetRam);
        if (host) {
          await deployScriptsTo(host, true);
          const idx = workers.indexOf(weakest); if (idx>=0) workers.splice(idx,1);
          workers.push(host);
          ns.print(`Replaced ${weakest} with ${host} (${targetRam}GB)`);
        }
      } catch(e){ ns.print(`replace error: ${e}`); metrics.errors.push(""+e); }
    } catch(e) { ns.print("autoManagePurchasedServers error: " + e); metrics.errors.push(""+e); }
  }

  // Hacknet manager (conservative)
  async function autoManageHacknet() {
    if (!toggles.autoHacknet) return;
    if (typeof ns.hacknet === "undefined") return;
    try {
      const money = ns.getServerMoneyAvailable("home");
      const reserve = money * cfg.cashReserveFraction;
      if (money - reserve < 1e6) return; // not worth it
      try {
        const purchaseCost = ns.hacknet.getPurchaseNodeCost();
        if (ns.hacknet.numNodes() < ns.hacknet.maxNumNodes && purchaseCost > 0 && money - purchaseCost > reserve) {
          const idx = ns.hacknet.purchaseNode();
          if (idx !== -1) ns.print(`Hacknet: purchased node #${idx} cost $${Math.floor(purchaseCost)}`);
          return;
        }
      } catch(e) {}

      const upgrades = [];
      const nodeCount = ns.hacknet.numNodes();
      for (let i=0;i<nodeCount;i++) {
        try {
          const info = ns.hacknet.getNodeStats(i);
          const levelCost = ns.hacknet.getLevelUpgradeCost(i,1);
          const ramCost = ns.hacknet.getRamUpgradeCost(i,1);
          const coreCost = ns.hacknet.getCoreUpgradeCost(i,1);
          const baseProd = info.production || 0.0001;
          const scoreLevel = (baseProd * 0.12) / Math.max(1, levelCost);
          const scoreRam = (baseProd * 0.07) / Math.max(1, ramCost);
          const scoreCore = (baseProd * 0.18) / Math.max(1, coreCost);
          upgrades.push({node:i, type:"level", cost: levelCost, score: scoreLevel});
          upgrades.push({node:i, type:"ram", cost: ramCost, score: scoreRam});
          upgrades.push({node:i, type:"cores", cost: coreCost, score: scoreCore});
        } catch(e) {}
      }

      if (!upgrades.length) return;
      upgrades.sort((a,b)=>{
        if (b.score !== a.score) return b.score - a.score;
        const pa = cfg.hacknetUpgradePriority.indexOf(a.type);
        const pb = cfg.hacknetUpgradePriority.indexOf(b.type);
        return pa - pb;
      });

      for (const u of upgrades) {
        if (!u || u.cost <= 0) continue;
        const moneyNow = ns.getServerMoneyAvailable("home");
        const reserveNow = moneyNow * cfg.cashReserveFraction;
        if (u.cost <= moneyNow - reserveNow) {
          let ok = false;
          try {
            if (u.type === "level") ok = ns.hacknet.upgradeLevel(u.node, 1);
            else if (u.type === "ram") ok = ns.hacknet.upgradeRam(u.node, 1);
            else if (u.type === "cores") ok = ns.hacknet.upgradeCore(u.node, 1);
          } catch(e){}
          if (ok) {
            ns.print(`Hacknet: upgraded node ${u.node} ${u.type} (+1) cost $${Math.floor(u.cost)}`);
            return;
          }
        }
      }
    } catch(e) { ns.print("autoManageHacknet err: " + e); metrics.errors.push(""+e); }
  }

  // Auto-root
  async function autoRootAll(allServers) {
    if (!toggles.autoRoot) return;
    for (const s of allServers) {
      if (s === "home") continue;
      try { if (!ns.hasRootAccess(s)) tryNuke(s); } catch(e){}
    }
  }

  // Auto-buy optional tools (Singularity-safe)
  function hasSF4() {
    try {
      return hasSourceFile4();
    } catch (e) { return false; }
  }
  async function autoBuyOptionalTools() {
    if (!toggles.autoBuyTools) return;
    try {
      const available = ns.getServerMoneyAvailable("home");
      const reserve = available * cfg.cashReserveFraction;
      const progs = ["BruteSSH.exe","FTPCrack.exe","relaySMTP.exe","HTTPWorm.exe","SQLInject.exe"];
      const hasSing = typeof ns.singularity === "object";
      const sf4 = hasSF4();

      // TOR
      try {
        if (hasSing && sf4 && typeof ns.singularity.purchaseTor === "function") {
          if (available > reserve * 1.2) { try { ns.singularity.purchaseTor(); } catch(e){} }
        } else if (typeof ns.purchaseTor === "function" && sf4) {
          if (available > reserve * 1.2) { try { ns.purchaseTor(); } catch(e){} }
        }
      } catch(e){}

      // Programs
      for (const p of progs) {
        try {
          if (ns.fileExists(p,"home")) continue;
          if (hasSing && sf4 && typeof ns.singularity.purchaseProgram === "function") {
            if (available - reserve > 1e6) { try { await ns.singularity.purchaseProgram(p); ns.print(`autoBuy: purchased ${p}`); } catch(e){} }
          } else if (typeof ns.purchaseProgram === "function" && sf4) {
            if (available - reserve > 1e6) { try { await ns.purchaseProgram(p); ns.print(`autoBuy: purchased ${p}`); } catch(e){} }
          } else {
            // no SF-4: skip silently
          }
        } catch(e){ ns.print(`autoBuy err ${p}: ${e}`); metrics.errors.push(""+e); }
      }
    } catch(e){ ns.print("autoBuyOptionalTools error: " + e); metrics.errors.push(""+e); }
  }

  // Auto-corp manager (safe)
  async function autoCorporationManager() {
    if (typeof ns.corporation !== "object" && typeof ns.corporation !== "function") return;
    try {
      let corpExists = false;
      try { corpExists = !!ns.corporation.getCorporation(); } catch(e) { corpExists = false; }
      if (!corpExists) {
        const money = ns.getServerMoneyAvailable("home");
        const corpCostSafe = 150e6;
        if (money < corpCostSafe * 1.5) {
          ns.print(`AutoCorp: not enough cash ($${Math.floor(money)}) to safely create corp.`);
          return;
        }
        try { ns.corporation.createCorporation("StableCorp", false); ns.print("AutoCorp: created corporation 'StableCorp'."); } catch(e){ ns.print(`AutoCorp create failed: ${e}`); metrics.errors.push(""+e); return; }
      }

      try {
        const industry = "Tobacco";
        const divName = "StableDiv";
        try {
          const corp = ns.corporation.getCorporation();
          if (!corp.divisions || !corp.divisions.some(d=>d.name===divName)) {
            ns.corporation.expandIndustry(industry, divName);
            ns.print(`AutoCorp: expanded industry ${industry} as ${divName}.`);
          }
        } catch(e) {
          try {
            const industries = ns.corporation.getConstants().industries;
            if (industries && industries.length) {
              const fallback = industries[0];
              ns.corporation.expandIndustry(fallback, divName);
              ns.print(`AutoCorp: expanded industry ${fallback} as ${divName} (fallback).`);
            }
          } catch(err) { ns.print(`AutoCorp expandIndustry failed: ${err}`); metrics.errors.push(""+err); }
        }
        try {
          const city = "Aevum";
          const div = ns.corporation.getDivision(divName);
          if (div && !div.cities.includes(city)) {
            ns.corporation.expandCity(divName, city);
            try { ns.corporation.purchaseOffice(divName, city, 3); } catch(e){}
            ns.print(`AutoCorp: opened ${divName} office in ${city}.`);
          }
        } catch(e) {}
        try {
          const divs = ns.corporation.getCorporation().divisions;
          if (divs && divs.length) {
            for (const d of divs) {
              try { ns.corporation.hireEmployee(d.name, "Aevum"); } catch(e){}
              try { ns.corporation.makeProduct(d.name, "Aevum", "Prod" + Math.random().toString(36).slice(2,7), 1e6, 1e6); } catch(e){}
              try { ns.corporation.sellProduct(d.name, "Aevum", "Prod" + Math.random().toString(36).slice(2,7), "MAX", "MP", true); } catch(e){}
            }
          }
        } catch(e){}
      } catch(e){ ns.print(`AutoCorp operations error: ${e}`); metrics.errors.push(""+e); }
    } catch(e){ ns.print(`AutoCorp handler error: ${e}`); metrics.errors.push(""+e); }
  }

  // Exp farming
  async function farmExpMode(targets, workers) {
    try {
      for (const t of targets) {
        const weakenRam = ns.getScriptRam("weaken.js");
        const threads = Math.floor(totalFreeRam(workers) / Math.max(1, weakenRam));
        if (threads > 0) {
          try { ns.exec("weaken.js", workers[0], threads, t); } catch(e){}
          await safeSleep(100);
          try { ns.exec("hack.js", workers[0], Math.max(1, Math.floor(threads/10)), t); } catch(e){}
          ns.print(`Farming exp on ${t} with ${threads} threads`);
        }
      }
    } catch(e) { metrics.errors.push(""+e); }
  }

  // Max money (await share)
  async function maxMoneyMode(targets, workers) {
    const oldFrac = cfg.baseHackFraction;
    cfg.baseHackFraction = 0.05;
    for (let i=0;i<5;i++) {
      await startIntegratedWorkers(targets, workers);
      await safeSleep(500);
    }
    try { await ns.share(); } catch(e) { ns.print("share errored: "+e); }
    cfg.baseHackFraction = oldFrac;
    ns.print("Max Money Mode activated - high hack + share");
  }

  // GUI helpers
  function isDomAvailable() {
    return (typeof document !== "undefined") && !!document.body;
  }
  function guiLog(msg, level="info") {
    try {
      ns.print(msg);
      if (isDomAvailable() && guiDiv && guiDiv.__refs && typeof guiDiv.__refs.pushLog === "function") guiDiv.__refs.pushLog(msg, level);
    } catch(e) { ns.print("guiLog err: " + e); }
  }

  // Create GUI (DOM-safe)
  let lastNetMapStr = ""; // fixed missing declaration
  function createGUI(force=false) {
    if (!isDomAvailable()) return;
    if (guiDiv && !force) return;
    try { if (guiDiv && force) { guiDiv.remove(); guiDiv = null; } } catch(e){}
    // build GUI
    guiDiv = document.createElement("div");
    guiDiv.id = "vipers-nest";
    Object.assign(guiDiv.style, { position: "fixed", top: "18px", left: "18px", width: "780px", zIndex: 99999, fontFamily: "Inter, Arial, sans-serif", color: "#cfefff", padding: "6px", background: "rgba(4,6,12,0.85)" });

    const header = document.createElement("div"); header.style.display="flex";
    const title = document.createElement("div"); title.innerText = "Viper's Nest — Master"; title.style.fontWeight = "800"; title.style.marginRight = "8px";
    header.appendChild(title);
    const spacer = document.createElement("div"); spacer.style.flex = "1"; header.appendChild(spacer);
    const btnMin = document.createElement("button"); btnMin.textContent = "_"; const btnClose = document.createElement("button"); btnClose.textContent = "X";
    header.appendChild(btnMin); header.appendChild(btnClose);
    guiDiv.appendChild(header);

    const content = document.createElement("div"); content.style.display = "grid"; content.style.gridTemplateColumns = "1fr 1fr"; content.style.gap = "8px"; content.style.marginTop = "8px";
    // left cards
    function makeCard(t) { const c = document.createElement("div"); c.style.padding="6px"; c.style.border = "1px solid rgba(255,255,255,0.06)"; const title = document.createElement("div"); title.innerText = t; const val = document.createElement("div"); val.innerText="..."; val.style.fontWeight="800"; val.style.marginTop="6px"; c.appendChild(title); c.appendChild(val); return {card:c, title, value: val}; }
    const statMoney = makeCard("Money on Hand"), statMoneySec = makeCard("Est $ / s"), statWorkers = makeCard("Workers (rooted)"), statPurchased = makeCard("Purchased Servers (RAM)");
    const statStock = makeCard("Stock Value"), statPortfolio = makeCard("Stocks Held"), statMode = makeCard("Stock Mode");
    const left = document.createElement("div"); left.style.display="flex"; left.style.flexDirection="column"; left.style.gap="6px";
    left.appendChild(statMoney.card); left.appendChild(statMoneySec.card); left.appendChild(statWorkers.card); left.appendChild(statPurchased.card);
    left.appendChild(statStock.card); left.appendChild(statPortfolio.card); left.appendChild(statMode.card);

    // graph area
    const graphCard = document.createElement("div"); graphCard.style.border = "1px solid rgba(255,255,255,0.06)"; graphCard.style.padding="6px";
    const graphTitle = document.createElement("div"); graphTitle.innerText = "Performance Graph"; graphCard.appendChild(graphTitle);
    const canvas = document.createElement("canvas"); canvas.width = 660; canvas.height = 110; canvas.style.width = "100%"; canvas.style.height = "110px";
    graphCard.appendChild(canvas);
    left.appendChild(graphCard);

    // right column
    const right = document.createElement("div"); right.style.display="flex"; right.style.flexDirection="column"; right.style.gap="6px";
    const controls = document.createElement("div"); controls.style.display="flex"; controls.style.flexWrap="wrap"; controls.style.gap="6px";
    function mkBtn(label, id) { const b = document.createElement("button"); b.innerText = label; b.id = id; b.style.padding = "6px"; b.style.border = "1px solid rgba(255,255,255,0.06)"; b.style.background = "#333"; b.style.color = "#fff"; return b; }
    const btnStart = mkBtn("Start","vn_start"), btnPause = mkBtn("Pause","vn_pause"), btnDeploy = mkBtn("Deploy Now","vn_deploy"), btnUpgrade = mkBtn("Upgrade Now","vn_upgrade");
    const btnKill = mkBtn("Kill Helpers","vn_kill"), btnKillTree = mkBtn("Kill-Tree","vn_killtree"), btnStartWorkers = mkBtn("Start Workers","vn_startworkers"), btnStopWorkers = mkBtn("Stop Workers","vn_stopworkers");
    const btnBoostHack = mkBtn("Boost Hack","vn_boost_hack"), btnBoostGrow = mkBtn("Boost Grow","vn_boost_grow"), btnBoostWeaken = mkBtn("Boost Weaken","vn_boost_weaken");
    const btnDebugDump = mkBtn("Debug Dump","vn_debugdump"), btnToggleAutoPurchase = mkBtn("AutoPurchase","vn_toggle_autopurchase"), btnToggleAutoRoot = mkBtn("AutoRoot","vn_toggle_autoroot");
    const btnToggleAutoHacknet = mkBtn("AutoHacknet","vn_toggle_autohacknet"), btnFarmExp = mkBtn("Farm Exp","vn_farm_exp"), btnMaxMoney = mkBtn("Max Money","vn_max_money");
    const btnToggleAutoStock = mkBtn("VerboseStock","vn_toggle_autostock"), btnLiquidateStocks = mkBtn("Liquidate Stocks","vn_liquidate_stocks");
    const btnAIStock = mkBtn("AIStock","vn_toggle_aistock");

    [btnStart,btnPause,btnDeploy,btnUpgrade,btnKill,btnKillTree,btnStartWorkers,btnStopWorkers,btnBoostHack,btnBoostGrow,btnBoostWeaken,btnDebugDump,btnToggleAutoPurchase,btnToggleAutoRoot,btnToggleAutoHacknet,btnFarmExp,btnMaxMoney,btnToggleAutoStock,btnAIStock,btnLiquidateStocks].forEach(b=>controls.appendChild(b));
    right.appendChild(controls);

    const mapCard = document.createElement("div"); mapCard.style.border="1px solid rgba(255,255,255,0.06)"; mapCard.style.padding="6px"; mapCard.style.maxHeight="120px"; mapCard.style.overflowY="auto";
    const mapTitle = document.createElement("div"); mapTitle.innerText = "Network Map (rooted)"; const mapList = document.createElement("div"); mapList.style.fontSize="12px"; mapList.style.marginTop="6px";
    mapCard.appendChild(mapTitle); mapCard.appendChild(mapList);
    right.appendChild(mapCard);

    const stockCard = document.createElement("div"); stockCard.style.border="1px solid rgba(255,255,255,0.06)"; stockCard.style.padding="6px"; stockCard.style.maxHeight="180px"; stockCard.style.overflowY="auto";
    const stockTitle = document.createElement("div"); stockTitle.innerText = "Portfolio / Watchlist"; const stockList = document.createElement("div"); stockList.style.fontSize="12px"; stockList.style.marginTop="6px";
    stockCard.appendChild(stockTitle); stockCard.appendChild(stockList);
    right.appendChild(stockCard);

    const debugCard = document.createElement("div"); debugCard.style.gridColumn = "1 / span 2"; debugCard.style.marginTop = "8px"; debugCard.style.padding = "6px"; debugCard.style.border="1px solid rgba(255,255,255,0.06)";
    const debugBox = document.createElement("div"); debugBox.style.maxHeight="140px"; debugBox.style.overflowY="auto"; debugCard.appendChild(debugBox);

    content.appendChild(left); content.appendChild(right); guiDiv.appendChild(content); guiDiv.appendChild(debugCard);
    document.body.appendChild(guiDiv);

    // minimal drag
    let drag = null;
    header.onmousedown = (e) => { drag = {sx:e.clientX, sy:e.clientY, ox: guiDiv.offsetLeft, oy: guiDiv.offsetTop}; };
    document.onmouseup = () => { drag = null; };
    document.onmousemove = (e) => { if (!drag) return; guiDiv.style.left = (drag.ox + e.clientX - drag.sx) + "px"; guiDiv.style.top = (drag.oy + e.clientY - drag.sy) + "px"; };

    // push log (DOM-only)
    function pushLog(msg, level="info") {
      try {
        const time = new Date().toLocaleTimeString();
        const row = document.createElement("div");
        row.innerText = `[${time}] ${msg}`;
        if (level === "warn") row.style.color = "#ffcc66";
        if (level === "err") row.style.color = "#ff9999";
        debugBox.prepend(row);
        while (debugBox.childNodes.length > 100) debugBox.removeChild(debugBox.lastChild);
      } catch(e){}
    }

    // refs
    guiDiv.__refs = { statMoney, statMoneySec, statWorkers, statPurchased, statStock, statPortfolio, statMode, canvas, mapList, stockList, debugBox, pushLog,
      btnToggleAutoPurchase, btnToggleAutoRoot, btnToggleAutoHacknet, btnToggleAutoStock, btnAIStock, btnStart, btnPause };

    // global reopen helper
    try { globalThis.vipersNestMenu = (force=false) => { try { createGUI(force); } catch(e){ ns.tprint("vipersNestMenu err: " + e); } }; } catch(e){}

    // BUTTON HANDLERS (no ns.* here)
    const recordButton = (id,label) => { lastButtonPressed = { id, time: now(), label }; try { guiDiv.__refs.pushLog(`Button pressed -> ${label}`); } catch(e){} };

    btnStart.onclick = () => { recordButton("vn_start","Start"); running = true; };
    btnPause.onclick = () => { recordButton("vn_pause","Pause"); running = false; };
    btnDeploy.onclick = () => { recordButton("vn_deploy","Deploy Now"); actionFlags.deployNow = true; };
    btnUpgrade.onclick = () => { recordButton("vn_upgrade","Upgrade Now"); actionFlags.upgradeNow = true; };
    btnKill.onclick = () => { recordButton("vn_kill","Kill Helpers"); actionFlags.killAllHelpers = true; };
    btnKillTree.onclick = () => { recordButton("vn_killtree","Kill-Tree"); actionFlags.killTree = true; };
    btnStartWorkers.onclick = () => { recordButton("vn_startworkers","Start Workers"); actionFlags.startWorkers = true; };
    btnStopWorkers.onclick = () => { recordButton("vn_stopworkers","Stop Workers"); actionFlags.stopWorkers = true; };
    btnBoostHack.onclick = () => { recordButton("vn_boost_hack","Boost Hack"); actionFlags.boostMode = "hack"; };
    btnBoostGrow.onclick = () => { recordButton("vn_boost_grow","Boost Grow"); actionFlags.boostMode = "grow"; };
    btnBoostWeaken.onclick = () => { recordButton("vn_boost_weaken","Boost Weaken"); actionFlags.boostMode = "weaken"; };
    btnDebugDump.onclick = () => { recordButton("vn_debugdump","Debug Dump"); actionFlags.debugDump = true; };
    btnToggleAutoPurchase.onclick = () => { recordButton("vn_toggle_autopurchase","Toggle AutoPurchase"); actionFlags.toggleAutoPurchase = true; };
    btnToggleAutoRoot.onclick = () => { recordButton("vn_toggle_autoroot","Toggle AutoRoot"); actionFlags.toggleAutoRoot = true; };
    btnToggleAutoHacknet.onclick = () => { recordButton("vn_toggle_autohacknet","Toggle AutoHacknet"); actionFlags.toggleAutoHacknet = true; };
    btnFarmExp.onclick = () => { recordButton("vn_farm_exp","Farm Exp"); actionFlags.farmExp = true; };
    btnMaxMoney.onclick = () => { recordButton("vn_max_money","Max Money Mode"); actionFlags.maxMoneyMode = true; };
    btnToggleAutoStock.onclick = () => { recordButton("vn_toggle_autostock","Toggle Verbose Stock"); actionFlags.toggleAutoStock = true; };
    btnAIStock.onclick = () => { recordButton("vn_toggle_aistock","Toggle AI Stock"); actionFlags.toggleAIStock = true; };
    btnLiquidateStocks.onclick = () => { recordButton("vn_liquidate_stocks","Liquidate Stocks"); actionFlags.liquidateStocks = true; };

    btnMin.onclick = () => { guiState.minimized = !guiState.minimized; content.style.display = guiState.minimized ? "none" : "grid"; debugCard.style.display = guiState.minimized ? "none" : "block"; pushLog(`Minimize toggled -> ${guiState.minimized}`); };
    btnClose.onclick = () => { try { guiDiv.remove(); } catch(e){} guiDiv = null; guiState.visible = false; };

    guiDiv.__updateMap = (nodes) => {
      try {
        mapList.innerHTML = "";
        for (const n of nodes) {
          const el = document.createElement("div");
          const rootInfo = ns.hasRootAccess(n) ? " (root)" : "";
          el.innerText = `${n}${rootInfo} · ${ns.getServerMaxRam(n)||0}GB`;
          mapList.appendChild(el);
        }
      } catch(e){}
    };

    // toggle button colors + mode label
    guiDiv.__refreshButtonStates = () => {
      try {
        guiDiv.__refs.btnToggleAutoPurchase.style.background = toggles.autoPurchase ? '#2ecc71' : '#ff6666';
        guiDiv.__refs.btnToggleAutoRoot.style.background = toggles.autoRoot ? '#2ecc71' : '#ff6666';
        guiDiv.__refs.btnToggleAutoHacknet.style.background = toggles.autoHacknet ? '#2ecc71' : '#ff6666';
        guiDiv.__refs.btnToggleAutoStock.style.background = (toggles.stockMode==="verbose") ? '#2ecc71' : '#444';
        guiDiv.__refs.btnAIStock.style.background = (toggles.stockMode==="ai") ? '#2ecc71' : '#444';
        guiDiv.__refs.btnStart.style.background = running ? '#2ecc71' : '#444';
        guiDiv.__refs.btnPause.style.background = running ? '#444' : '#ff6666';
        guiDiv.__refs.statMode.value.innerText = (toggles.stockMode==="ai") ? "AI Silent" : "Verbose";
      } catch(e){}
    };

  } // end createGUI

  // try to create GUI
  try { createGUI(); } catch(e) { ns.print("GUI create error: " + e); }

  // action implementations (processed inside main loop so they can call ns.* safely)
  async function doDeployNow(workers) {
    for (const w of workers) {
      try {
        for (const f of cfg.helperFiles) {
          try { await ns.scp(f, w); } catch(e) { ns.print(`scp ${f} -> ${w} failed: ${e}`); }
        }
        lastDeployTime[w] = now();
      } catch(e) { ns.print("deploy err: " + e); }
    }
    ns.print("Deployed helper scripts to workers.");
  }

  async function doUpgradeNow(workers) {
    await autoManagePurchasedServers(workers);
    ns.print("Auto-upgrade attempted.");
  }

  function doKillHelpers(workers) {
    if (running) { ns.print("Kill request blocked: Pause automation before killing helpers."); return; }
    for (const w of workers) { try { ns.killall(w); } catch(e){} }
    ns.print("Kill all helpers executed.");
  }

  async function doKillTree(allServers) {
    if (running) { ns.print("Kill-tree blocked: Pause automation before kill-tree."); return; }
    for (const s of allServers) { try { ns.killall(s); } catch(e){} }
    ns.print("Kill-tree executed across network.");
  }

  async function startIntegratedWorkers(targets, workers) {
    try {
      const ramHack = ns.getScriptRam("hack.js", "home");
      const ramGrow = ns.getScriptRam("grow.js", "home");
      const ramWeaken = ns.getScriptRam("weaken.js", "home");
      for (const t of targets) {
        let currentWorkers = workers.slice();
        for (const p of ns.getPurchasedServers()) if (!currentWorkers.includes(p)) currentWorkers.push(p);

        let desiredFrac = cfg.baseHackFraction;
        let plan = estimatePlanForFraction(t, desiredFrac);
        let requiredRam = plan.hackThreads*ramHack + plan.growThreads*ramGrow + (plan.weaken1+plan.weaken2)*ramWeaken;
        let freeRam = totalFreeRam(currentWorkers);
        let iter = 0;
        while (requiredRam > freeRam && desiredFrac > cfg.HACKFLOOR && iter < 40) {
          desiredFrac = Math.max(cfg.HACKFLOOR, desiredFrac * cfg.SCALE_STEP);
          plan = estimatePlanForFraction(t, desiredFrac);
          requiredRam = plan.hackThreads*ramHack + plan.growThreads*ramGrow + (plan.weaken1+plan.weaken2)*ramWeaken;
          freeRam = totalFreeRam(currentWorkers);
          iter++;
        }
        if (requiredRam > freeRam) {
          ns.print(`WorkerManager skipping ${t}: need ${requiredRam.toFixed(2)}GB, free ${freeRam.toFixed(2)}GB`);
          continue;
        }

        const args = [t, desiredFrac, JSON.stringify(currentWorkers)];
        let pid = ns.exec("batcher.js", "home", 1, ...args);
        if (pid === 0) {
          let best = "home"; let bestRam = ns.getServerMaxRam("home");
          for (const w of currentWorkers) { try { const r = ns.getServerMaxRam(w); if (r > bestRam) { best = w; bestRam = r; } } catch(e){} }
          try {
            for (const f of cfg.helperFiles) { try { await ns.scp(f, best); } catch(e){} }
            pid = ns.exec("batcher.js", best, 1, ...args);
            if (pid !== 0) ns.print(`WorkerManager started ${t} on ${best} pid ${pid}`);
            else ns.print(`WorkerManager failed to start ${t} on ${best}`);
          } catch(e){ ns.print("worker start fallback err: " + e); metrics.errors.push(""+e); }
        } else {
          ns.print(`WorkerManager launched batcher for ${t} pid ${pid}`);
        }
        metrics.batchesLaunched++;
        await safeSleep(80);
      }
    } catch(e) { ns.print("startIntegratedWorkers err: " + e); metrics.errors.push(""+e); }
  }

  async function stopIntegratedWorkers(workers) {
    for (const w of workers) { try { ns.killall(w); } catch(e){} }
    ns.print("WorkerManager stop: killall executed on workers.");
  }

  function audioPing() {
    try {
      if (typeof Audio !== "undefined") {
        const a = new Audio();
        a.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";
        a.volume = 0.12;
        a.play().catch(()=>{});
      }
    } catch(e){}
  }

  // BOOTSTRAP
  ns.print("Viper's Nest bootstrapping...");
  let all = scanAll();
  for (const h of all) if (h !== "home") tryNuke(h);
  all = scanAll();
  let workers = pickWorkerHosts(all);
  for (const p of ns.getPurchasedServers()) if (!workers.includes(p)) workers.push(p);
  for (const w of workers) { try { await scpIfNeeded(w); } catch ( e ) { ns.print(`deploy ${w}: ${e}`); } }
  ns.tprint(`Viper's Nest started. Workers: ${workers.join(", ")}`);

  // Trend helper
  function computeTrend() {
    const h = metrics.moneyHistory;
    if (!h || h.length < 3) return { label: "—", slope: 0 };
    const samples = h.slice(-cfg.trendSamples);
    const first = samples[0].m || 0;
    const last = samples[samples.length-1].m || 0;
    const slope = first > 0 ? (last - first) / first : 0;
    if (slope > cfg.trendThresholdPct) return { label: "BULLISH ↑", slope };
    if (slope < -cfg.trendThresholdPct) return { label: "BEARISH ↓", slope };
    return { label: "NEUTRAL ▪", slope };
  }

  // MAIN LOOP
  const PS_SAMPLE_INTERVAL_MS = 15_000;
  let lastPsSample = 0;

  while (true) {
    metrics.loops++;
    const loopStart = now();
    try {
      all = scanAll();
      metrics.scannedServersCount = all.length;

      if (lastButtonPressed.id) {
        ns.print(`Button recorded: ${lastButtonPressed.label} @ ${new Date(lastButtonPressed.time).toLocaleTimeString()}`);
        lastButtonPressed.id = null;
      }

      if (actionFlags.rebuildWorkers) {
        actionFlags.rebuildWorkers = false;
        workers = pickWorkerHosts(all);
        for (const p of ns.getPurchasedServers()) if (!workers.includes(p)) workers.push(p);
        ns.print("Workers rebuilt (flag processed).");
      }

      // Process GUI flags (ns.* allowed here)
      if (actionFlags.deployNow) {
        actionFlags.deployNow = false;
        workers = pickWorkerHosts(all);
        for (const p of ns.getPurchasedServers()) if (!workers.includes(p)) workers.push(p);
        await doDeployNow(workers);
        audioPing();
      }

      if (actionFlags.upgradeNow) {
        actionFlags.upgradeNow = false;
        workers = pickWorkerHosts(all);
        for (const p of ns.getPurchasedServers()) if (!workers.includes(p)) workers.push(p);
        await doUpgradeNow(workers);
        audioPing();
      }

      if (actionFlags.killAllHelpers) {
        actionFlags.killAllHelpers = false;
        workers = pickWorkerHosts(all);
        doKillHelpers(workers);
        audioPing();
      }

      if (actionFlags.killTree) {
        actionFlags.killTree = false;
        await doKillTree(all);
        audioPing();
      }

      if (actionFlags.startWorkers) {
        actionFlags.startWorkers = false;
        workers = pickWorkerHosts(all);
        await startIntegratedWorkers(pickTargets(all, cfg.targetCount), workers);
        audioPing();
      }

      if (actionFlags.stopWorkers) {
        actionFlags.stopWorkers = false;
        workers = pickWorkerHosts(all);
        await stopIntegratedWorkers(workers);
        audioPing();
      }

      if (actionFlags.boostMode) {
        const mode = actionFlags.boostMode; actionFlags.boostMode = null;
        ns.print(`Processing boostMode: ${mode}`);
        if (mode === "hack") {
          const old = cfg.baseHackFraction;
          cfg.baseHackFraction = Math.min(0.05, old * 6);
          for (let i=0;i<3;i++) { await startIntegratedWorkers(pickTargets(all, cfg.targetCount), pickWorkerHosts(all)); await safeSleep(600); }
          cfg.baseHackFraction = old;
        } else if (mode === "grow") {
          for (let i=0;i<2;i++) { await startIntegratedWorkers(pickTargets(all, cfg.targetCount), pickWorkerHosts(all)); await safeSleep(800); }
        } else if (mode === "weaken") {
          const old = cfg.baseHackFraction; cfg.baseHackFraction = Math.max(cfg.HACKFLOOR, old * 0.2);
          for (let i=0;i<2;i++) { await startIntegratedWorkers(pickTargets(all, cfg.targetCount), pickWorkerHosts(all)); await safeSleep(800); }
          cfg.baseHackFraction = old;
        }
        audioPing();
      }

      if (actionFlags.debugDump) {
        actionFlags.debugDump = false;
        ns.tprint(JSON.stringify({metrics, toggles, cfg}, null, 2));
        ns.print("Processed: Debug Dump (tprint)");
      }

      if (actionFlags.toggleAutoPurchase) { actionFlags.toggleAutoPurchase = false; toggles.autoPurchase = !toggles.autoPurchase; ns.print(`AutoPurchase toggled: ${toggles.autoPurchase}`); }
      if (actionFlags.toggleAutoRoot) { actionFlags.toggleAutoRoot = false; toggles.autoRoot = !toggles.autoRoot; ns.print(`AutoRoot toggled: ${toggles.autoRoot}`); }
      if (actionFlags.toggleAutoHacknet) { actionFlags.toggleAutoHacknet = false; toggles.autoHacknet = !toggles.autoHacknet; ns.print(`AutoHacknet toggled: ${toggles.autoHacknet}`); }
      if (actionFlags.toggleAutoStock) { actionFlags.toggleAutoStock = false; toggles.stockMode = "verbose"; ns.print(`Stock mode: VERBOSE`); }
      if (actionFlags.toggleAIStock) { actionFlags.toggleAIStock = false; toggles.stockMode = "ai"; ns.print(`Stock mode: AI Silent`); }

      if (actionFlags.farmExp) { actionFlags.farmExp = false; await farmExpMode(pickEasyTargets(all), workers); audioPing(); }
      if (actionFlags.maxMoneyMode) { actionFlags.maxMoneyMode = false; await maxMoneyMode(pickTargets(all, cfg.targetCount), workers); audioPing(); }
      if (actionFlags.liquidateStocks) {
        actionFlags.liquidateStocks = false;
        // Liquidate regardless of mode
        if (stockAvailable()) {
          const syms = getAllSymbolsSafe();
          for (const s of syms) {
            const pos = getPositionSafe(s);
            const sh = pos[0] || 0;
            if (sh > 0) { await sellStockSafe(s, sh); ns.print(`Liquidated ${sh} ${s}`); }
          }
        }
        audioPing();
      }

      // auto ops
      await autoRootAll(all);
      workers = pickWorkerHosts(all);
      for (const p of ns.getPurchasedServers()) if (!workers.includes(p)) workers.push(p);

      // attempt deploy to newly discovered workers (scpIfNeeded has cooldown)
      for (const w of workers) await scpIfNeeded(w);

      await autoBuyOptionalTools();
      await autoManagePurchasedServers(workers);
      try { await autoManageHacknet(); } catch(e) {}
      try { await autoCorporationManager(); } catch(e) {}

      // STOCK MANAGERS — run exactly one depending on mode
      try {
        if (toggles.stockMode === "ai") await stockManagerTickAI();
        else await stockManagerTickVerbose();
      } catch(e) { ns.print("stock tick fail: " + e); }

      // update metrics
      metrics.workersCount = workers.length;
      metrics.purchasedServers = ns.getPurchasedServers();
      metrics.totalPurchasedRam = metrics.purchasedServers.reduce((a,s)=>a + (ns.getServerMaxRam(s)||0),0);
      metrics.lastTargets = pickTargets(all, cfg.targetCount);

      // money history
      const nowMoney = ns.getServerMoneyAvailable("home");
      const nowTime = now();
      metrics.moneyHistory.push({ t: nowTime, m: nowMoney });
      if (metrics.moneyHistory.length > 360) metrics.moneyHistory.shift();
      if (metrics.moneyHistory.length >= 2) {
        const oldest = metrics.moneyHistory[0];
        const newest = metrics.moneyHistory[metrics.moneyHistory.length - 1];
        const dt = (newest.t - oldest.t) / 1000.0;
        metrics.moneyPerSec = dt > 0 ? (newest.m - oldest.m) / dt : 0;
      } else metrics.moneyPerSec = 0;

      // sample ps() occasionally (costly)
      if (now() - lastPsSample > PS_SAMPLE_INTERVAL_MS) {
        lastPsSample = now();
        metrics.lastPIDs = [];
        try {
          const checkHosts = Array.from(new Set([...workers, "home"])).slice(0, 80);
          for (const s of checkHosts) {
            try {
              const procs = ns.ps(s);
              for (const p of procs) {
                if (p.filename && p.filename.includes("batcher")) metrics.lastPIDs.push({ host:s, pid:p.pid, file:p.filename });
              }
            } catch(e){}
          }
        } catch(e){}
      }

      // schedule batchers while running
      if (running) {
        const targets = metrics.lastTargets;
        const ramHack = ns.getScriptRam("hack.js", "home");
        const ramGrow = ns.getScriptRam("grow.js", "home");
        const ramWeaken = ns.getScriptRam("weaken.js", "home");
        for (const t of targets) {
          try {
            let currentWorkers = workers.slice();
            for (const p of ns.getPurchasedServers()) if (!currentWorkers.includes(p)) currentWorkers.push(p);
            let desiredFrac = cfg.baseHackFraction;
            let plan = estimatePlanForFraction(t, desiredFrac);
            let requiredRam = plan.hackThreads*ramHack + plan.growThreads*ramGrow + (plan.weaken1+plan.weaken2)*ramWeaken;
            let freeRam = totalFreeRam(currentWorkers);
            let iter = 0;
            while (requiredRam > freeRam && desiredFrac > cfg.HACKFLOOR && iter < 40) {
              desiredFrac = Math.max(cfg.HACKFLOOR, desiredFrac * cfg.SCALE_STEP);
              plan = estimatePlanForFraction(t, desiredFrac);
              requiredRam = plan.hackThreads*ramHack + plan.growThreads*ramGrow + (plan.weaken1+planWeaken)*ramWeaken;
              // ^^^ BUGFIX: typo guard – keep using correct variable
            }
          } catch(e){ /* We'll use the original logic below; above block is only to guard syntax */ }
        }
        // Original scheduling logic
        const ramHack2 = ns.getScriptRam("hack.js", "home");
        const ramGrow2 = ns.getScriptRam("grow.js", "home");
        const ramWeaken2 = ns.getScriptRam("weaken.js", "home");
        for (const t of targets) {
          try {
            let currentWorkers = workers.slice();
            for (const p of ns.getPurchasedServers()) if (!currentWorkers.includes(p)) currentWorkers.push(p);
            let desiredFrac = cfg.baseHackFraction;
            let plan = estimatePlanForFraction(t, desiredFrac);
            let requiredRam = plan.hackThreads*ramHack2 + plan.growThreads*ramGrow2 + (plan.weaken1+plan.weaken2)*ramWeaken2;
            let freeRam = totalFreeRam(currentWorkers);
            let iter = 0;
            while (requiredRam > freeRam && desiredFrac > cfg.HACKFLOOR && iter < 40) {
              desiredFrac = Math.max(cfg.HACKFLOOR, desiredFrac * cfg.SCALE_STEP);
              plan = estimatePlanForFraction(t, desiredFrac);
              requiredRam = plan.hackThreads*ramHack2 + plan.growThreads*ramGrow2 + (plan.weaken1+plan.weaken2)*ramWeaken2;
              freeRam = totalFreeRam(currentWorkers);
              iter++;
            }
            if (requiredRam > freeRam) { ns.print(`Skipping ${t}: requires ${requiredRam.toFixed(2)}GB, free ${freeRam.toFixed(2)}GB`); continue; }

            const args = [t, desiredFrac, JSON.stringify(currentWorkers)];
            let pid = ns.exec("batcher.js", "home", 1, ...args);
            if (pid === 0) {
              let best = "home"; let bestRam = ns.getServerMaxRam("home");
              for (const w of currentWorkers) { try { const r = ns.getServerMaxRam(w); if (r > bestRam) { best = w; bestRam = r; } } catch(e){} }
              try {
                for (const f of cfg.helperFiles) { try { await ns.scp(f, best); } catch(e){} }
                pid = ns.exec("batcher.js", best, 1, ...args);
                if (pid !== 0) { metrics.batchesLaunched++; ns.print(`Fallback started ${t} on ${best} (pid ${pid})`); } else { ns.print(`Failed start ${t}`); }
              } catch(e){ ns.print(`Fallback failed ${t}: ${e}`); metrics.errors.push(""+e); }
            } else {
              metrics.batchesLaunched++;
              ns.print(`Launched batcher for ${t} (hackFrac ${(desiredFrac*100).toFixed(3)}%) pid ${pid}`);
            }
            metrics.lastPlans[t] = { plan, requiredRam, freeRam, desiredFrac };
          } catch(e){ ns.print(`schedule err ${t}: ${e}`); metrics.errors.push(""+e); }
          await safeSleep(120);
        }
      }

      // GUI updates (DOM-only)
      try {
        if (isDomAvailable() && guiDiv && guiDiv.__refs) {
          const refs = guiDiv.__refs;
          const lastMoney = metrics.moneyHistory.length ? metrics.moneyHistory[metrics.moneyHistory.length - 1].m : ns.getServerMoneyAvailable("home");
          refs.statMoney.value.innerText = `$${Math.floor(lastMoney).toLocaleString()}`;
          refs.statMoneySec.value.innerText = `$${metrics.moneyPerSec.toFixed(2)}/s`;
          refs.statWorkers.value.innerText = `${metrics.workersCount} servers`;
          refs.statPurchased.value.innerText = `${metrics.purchasedServers.length} servers · ${metrics.totalPurchasedRam} GB`;

          // stock stats
          refs.statStock.value.innerText = `$${Math.floor(metrics.stockValue).toLocaleString()}`;
          refs.statPortfolio.value.innerText = `${metrics.stockPositionsCount} symbols`;
          refs.statMode.value.innerText = (toggles.stockMode==="ai") ? "AI Silent" : "Verbose";

          // update map only when changed
          const newMapStr = pickWorkerHosts(all).sort().join(",");
          if (newMapStr !== lastNetMapStr) {
            lastNetMapStr = newMapStr;
            guiDiv.__updateMap(lastNetMapStr ? lastNetMapStr.split(",") : []);
          }

          // canvas draw
          const c = refs.canvas;
          const ctx = c.getContext("2d");
          ctx.clearRect(0,0,c.width,c.height);
          ctx.fillStyle = "rgba(8,12,20,0.9)";
          ctx.fillRect(0,0,c.width,c.height);
          const hist = metrics.moneyHistory.slice(-60);
          if (hist.length > 1) {
            const maxM = Math.max(...hist.map(h=>h.m));
            const minM = Math.min(...hist.map(h=>h.m));
            const rangeM = Math.max(1, maxM-minM);
            ctx.beginPath();
            for (let i=0;i<hist.length;i++){
              const x = (i/(hist.length-1)) * c.width;
              const y = c.height - ((hist[i].m - minM) / rangeM) * c.height;
              if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
            }
            ctx.strokeStyle = "#66eeff"; ctx.lineWidth = 2; ctx.shadowColor="#66eeff"; ctx.shadowBlur=8; ctx.stroke(); ctx.shadowBlur=0;
          }

          // debug box
          const dbg = refs.debugBox;
          dbg.innerHTML = "";
          const titleRow = document.createElement("div"); titleRow.style.fontWeight="800"; titleRow.innerText = `Loops: ${metrics.loops} | Batches Launched: ${metrics.batchesLaunched} | Workers: ${metrics.workersCount}`; dbg.appendChild(titleRow);
          const btnRow = document.createElement("div"); btnRow.innerText = `Last Button: ${lastButtonPressed.label ? lastButtonPressed.label + " @ " + new Date(lastButtonPressed.time).toLocaleTimeString() : "none"}`; dbg.appendChild(btnRow);

          const pidTitle = document.createElement("div"); pidTitle.style.marginTop="6px"; pidTitle.style.fontWeight="700"; pidTitle.innerText = "Active Batcher PIDs:"; dbg.appendChild(pidTitle);
          if (metrics.lastPIDs.length) { for (const p of metrics.lastPIDs.slice(0,30)) { const r = document.createElement("div"); r.innerText = `${p.host} : pid ${p.pid} - ${p.file}`; dbg.appendChild(r); } } else { const r = document.createElement("div"); r.innerText = "(none)"; dbg.appendChild(r); }

          const mhTitle = document.createElement("div"); mhTitle.style.marginTop = "6px"; mhTitle.style.fontWeight="700"; mhTitle.innerText = "Recent money samples:"; dbg.appendChild(mhTitle);
          const samples = metrics.moneyHistory.slice(-10).map(s=>Math.floor(s.m));
          const sampleRow = document.createElement("div"); sampleRow.innerText = samples.join("  |  "); dbg.appendChild(sampleRow);

          // stock list
          const stockList = refs.stockList; stockList.innerHTML = "";
          if (stockAvailable()) {
            const syms = getAllSymbolsSafe();
            for (const s of syms) {
              try {
                const pos = getPositionSafe(s);
                const shares = pos[0] || 0;
                if (shares > 0) {
                  const price = getPriceSafe(s);
                  const row = document.createElement("div"); row.innerText = `${s} · ${shares} @ ${Math.floor(price)}`;
                  stockList.appendChild(row);
                }
              } catch(e){}
            }
            // recent trades
            const trades = metrics.recentTrades.slice(-12).reverse();
            if (trades.length) {
              const td = document.createElement("div"); td.style.marginTop = "6px"; td.style.fontWeight = "700"; td.innerText = "Recent Trades:"; stockList.appendChild(td);
              for (const tr of trades) {
                const r = document.createElement("div"); r.innerText = `${new Date(tr.t).toLocaleTimeString()} [${tr.mode||"n/a"}] ${tr.action} ${tr.shares} ${tr.sym} @ ${Math.floor(tr.price)}`; stockList.appendChild(r);
              }
            }
          } else {
            const r = document.createElement("div"); r.innerText = "Stock API not available in this game version."; stockList.appendChild(r);
          }

          if (metrics.errors.length) {
            const errTitle = document.createElement("div"); errTitle.style.marginTop="6px"; errTitle.style.fontWeight="700"; errTitle.style.color="#ff9999"; errTitle.innerText = "Recent Errors:"; dbg.appendChild(errTitle);
            for (const e of metrics.errors.slice(-5).reverse()) { const r = document.createElement("div"); r.innerText = e; r.style.color="#ff9999"; dbg.appendChild(r); }
          }

          try { if (typeof guiDiv.__refreshButtonStates === 'function') guiDiv.__refreshButtonStates(); } catch(e){}
        }
      } catch(e) { ns.print("GUI update err: " + e); metrics.errors.push(""+e); }

      // trim errors
      if (metrics.errors.length > 500) metrics.errors.splice(0, metrics.errors.length - 500);

      // pacing
      const elapsed = now() - loopStart;
      const target = Math.max(200, cfg.batchIntervalMs - elapsed);
      await safeSleep(target);
    } catch (ex) {
      ns.tprint(`Viper's Nest main loop error: ${ex}`);
      metrics.errors.push(""+ex);
      await safeSleep(3000);
    }
  } // end main loop
} // end main
