/** master.js - Viper's Nest Mega (Fully integrated GUI + automation + Hacknet manager)
 *
 * Single-file: automation + Sci-Fi GUI + button debug + graphs + integrated worker manager + trend indicator + visible debug overlay
 * Helpers assumed present in home: hack.js, grow.js, weaken.js, batcher.js
 *
 * Notes:
 *  - DOM handlers only set flags / local JS state (no ns.* in handlers).
 *  - Main loop reads flags and performs ns.* operations with proper await to avoid concurrency issues.
 */

/** @param {NS} ns **/
export async function main(ns) {
  // ---------------- basic setup ----------------
  ns.disableLog("sleep");
  ns.disableLog("getServerMoneyAvailable");
  ns.disableLog("scan");
  ns.disableLog("scp");
  ns.disableLog("exec");
  ns.tail();

  // ---------------- CONFIG (stable defaults) ----------------
  const cfg = {
    targetCount: 4,
    baseHackFraction: 0.005,
    batchIntervalMs: 2500,
    minRamForHost: 8,
    cashReserveFraction: 0.20,
    purchasedBudgetFraction: 0.20,
    purchasedTargetUpgradeMultiplier: 2,
    HACKFLOOR: 0.0005,
    SCALE_STEP: 0.92,
    helperFiles: ["hack.js", "grow.js", "weaken.js", "batcher.js"],
    trendSamples: 12,
    trendThresholdPct: 0.03,
    // Hacknet configuration
    hacknetBudgetFraction: 0.12,
    hacknetUpgradePriority: ["level","ram","cores"]
  };

  // ---------------- runtime state & metrics ----------------
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
    boostMode: null,        // "hack"|"grow"|"weaken"|null
    debugDump: false
  };
  const toggles = {
    autoPurchase: true,
    autoRoot: true,
    autoBuyTools: true,
    autoHacknet: true
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
    lastPIDs: []
  };

  // ---------------- small helpers ----------------
  async function safeSleep(ms) { try { await ns.sleep(ms); } catch (e) { ns.print("sleep err: " + e); } }

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
      } catch (e) { ns.print("scan err " + e); }
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

  async function deployScriptsTo(host) {
    for (const f of cfg.helperFiles) {
      try { await ns.scp(f, host); } catch (e) { ns.print(`scp ${f} -> ${host} failed: ${e}`); }
    }
  }

  function totalFreeRam(hostList) {
    let t = 0;
    for (const h of hostList) {
      try {
        const free = ns.getServerMaxRam(h) - ns.getServerUsedRam(h);
        if (free > 0) t += free;
      } catch(e){}
    }
    return t;
  }

  function estimatePlanForFraction(targetHost, frac) {
    const SEC_WEAKEN_PER_THREAD = 0.05;
    const SEC_INC_HACK = 0.002;
    const SEC_INC_GROW = 0.004;
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
  }

  function pickWorkerHosts(allServers) {
    const purchased = ns.getPurchasedServers();
    const workers = ["home"];
    for (const p of purchased) {
      try { if (ns.getServerMaxRam(p) >= cfg.minRamForHost) workers.push(p); } catch(e){}
    }
    for (const s of allServers) {
      if (s === "home") continue;
      if (purchased.includes(s)) continue;
      try { if (ns.hasRootAccess(s) && ns.getServerMaxRam(s) >= cfg.minRamForHost) workers.push(s); } catch(e){}
    }
    return Array.from(new Set(workers));
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

  // ---------------- Purchased servers manager (conservative) ----------------
  async function autoManagePurchasedServers(workers) {
    try {
      const MAX = ns.getPurchasedServerLimit();
      const maxRamPossible = ns.getPurchasedServerMaxRam();
      const purchased = ns.getPurchasedServers();
      let currentMax = 0;
      for (const p of purchased) {
        try { const r = ns.getServerMaxRam(p); if (r > currentMax) currentMax = r; } catch(e){}
      }
      if (currentMax === 0) currentMax = 8;
      let targetRam = Math.min(maxRamPossible, Math.max(currentMax * cfg.purchasedTargetUpgradeMultiplier, currentMax));
      const cost = ns.getPurchasedServerCost(targetRam);
      const available = ns.getServerMoneyAvailable("home");
      const reserve = available * cfg.cashReserveFraction;
      if (!toggles.autoPurchase) return;
      if (available - cost < reserve) return;
      if (available < cost * cfg.purchasedBudgetFraction) return;
      if (purchased.length < MAX) {
        const name = `viper-${targetRam}-${Math.floor(Math.random()*9999).toString().padStart(4,"0")}`;
        try {
          const host = ns.purchaseServer(name, targetRam);
          if (host) {
            await deployScriptsTo(host);
            workers.push(host);
            if (guiDiv) guiDiv.__pushLog(`Purchased ${host} (${targetRam}GB)`);
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
          await deployScriptsTo(host);
          const idx = workers.indexOf(weakest); if (idx>=0) workers.splice(idx,1);
          workers.push(host);
          if (guiDiv) guiDiv.__pushLog(`Replaced ${weakest} with ${host} (${targetRam}GB)`);
        }
      } catch(e){ ns.print(`replace error: ${e}`); metrics.errors.push(""+e); }
    } catch(e) { ns.print("autoManagePurchasedServers error: " + e); metrics.errors.push(""+e); }
  }

  // ---------------- Hacknet manager (smart) ----------------
  async function autoManageHacknet() {
    if (!toggles.autoHacknet) return;
    if (typeof ns.hacknet === "undefined") return;
    try {
      const money = ns.getServerMoneyAvailable("home");
      const reserve = money * cfg.cashReserveFraction;
      const budget = Math.max(0, money * cfg.hacknetBudgetFraction);
      if (money - reserve < 1e6) return; // not worth it
      // Try to purchase a node if affordable and below max
      try {
        const purchaseCost = ns.hacknet.getPurchaseNodeCost();
        if (ns.hacknet.numNodes() < ns.hacknet.maxNumNodes && purchaseCost > 0 && money - purchaseCost > reserve) {
          const idx = ns.hacknet.purchaseNode();
          if (idx !== -1 && guiDiv) guiDiv.__pushLog(`Hacknet: purchased node #${idx} cost $${Math.floor(purchaseCost)}`);
          // be conservative: do one purchase per loop
          return;
        }
      } catch(e) { /* ignore purchase cost failures */ }

      // Build list of candidate single-step upgrades across nodes
      const upgrades = [];
      const nodeCount = ns.hacknet.numNodes();
      for (let i = 0; i < nodeCount; i++) {
        try {
          const info = ns.hacknet.getNodeStats(i);
          const levelCost = ns.hacknet.getLevelUpgradeCost(i, 1);
          const ramCost = ns.hacknet.getRamUpgradeCost(i, 1);
          const coreCost = ns.hacknet.getCoreUpgradeCost(i, 1);
          // approximate production as info.production; if absent fallback to hacknet node money per second estimate via hacknet interface might vary
          const baseProd = info.production || 0.0001;
          // heuristic ROI score = estimated marginal production / cost
          const scoreLevel = (baseProd * 0.12) / Math.max(1, levelCost);
          const scoreRam = (baseProd * 0.07) / Math.max(1, ramCost);
          const scoreCore = (baseProd * 0.18) / Math.max(1, coreCost);
          upgrades.push({node:i, type:"level", cost: levelCost, score: scoreLevel});
          upgrades.push({node:i, type:"ram", cost: ramCost, score: scoreRam});
          upgrades.push({node:i, type:"cores", cost: coreCost, score: scoreCore});
        } catch(e) {
          // skip node if info fails
        }
      }

      if (upgrades.length === 0) return;
      // Sort by score desc, then by priority (if equal score)
      upgrades.sort((a,b)=>{
        if (b.score !== a.score) return b.score - a.score;
        const pa = cfg.hacknetUpgradePriority.indexOf(a.type);
        const pb = cfg.hacknetUpgradePriority.indexOf(b.type);
        return pa - pb;
      });

      // Try to apply the best affordable upgrade that leaves reserve
      for (const u of upgrades) {
        if (!u || u.cost <= 0) continue;
        const moneyNow = ns.getServerMoneyAvailable("home");
        const reserveNow = moneyNow * cfg.cashReserveFraction;
        if (u.cost <= moneyNow - reserveNow) {
          let ok = false;
          try {
            if (u.type === "level") ok = ns.hacknet.upgradeLevel(u.node, 1);
            else if (u.type === "ram") ok = ns.hacknet.upgradeRam(u.node, 1);
            else if (u.type === "cores" || u.type === "cores") ok = ns.hacknet.upgradeCore(u.node, 1);
          } catch(e){}
          if (ok) {
            if (guiDiv) guiDiv.__pushLog(`Hacknet: upgraded node ${u.node} ${u.type} (+1) cost $${Math.floor(u.cost)}`);
            // only do one upgrade per main-loop iteration (conservative)
            return;
          }
        }
      }
    } catch (e) {
      ns.print("autoManageHacknet err: " + e);
      metrics.errors.push(""+e);
    }
  }

  // ---------------- Auto-root ----------------
  async function autoRootAll(allServers) {
    if (!toggles.autoRoot) return;
    for (const s of allServers) { if (s==="home") continue; if (ns.hasRootAccess(s)) continue; tryNuke(s); }
  }

  // ---------------- Auto-buy optional tools ----------------
  async function autoBuyOptionalTools() {
    if (!toggles.autoBuyTools) return;
    try {
      const available = ns.getServerMoneyAvailable("home");
      const reserve = available * cfg.cashReserveFraction;
      const progs = ["BruteSSH.exe","FTPCrack.exe","relaySMTP.exe","HTTPWorm.exe","SQLInject.exe"];
      for (const p of progs) {
        try {
          if (ns.fileExists(p,"home")) continue;
          if (typeof ns.purchaseProgram === "function") {
            if (ns.getServerMoneyAvailable("home") - reserve > 1e6) {
              await ns.purchaseProgram(p);
              if (guiDiv) guiDiv.__pushLog(`autoBuy: purchased ${p}`);
            }
          }
        } catch(e){ ns.print(`autoBuy err ${p}: ${e}`); metrics.errors.push(""+e); }
      }
      try { if (typeof ns.purchaseTor === "function" && ns.getServerMoneyAvailable("home") > reserve*1.5) await ns.purchaseTor(); } catch(e){}
    } catch(e){ ns.print("autoBuyOptionalTools error: " + e); metrics.errors.push(""+e); }
  }

  // ---------------- Auto-Corporation Manager (safe / conservative) ----------------
  async function autoCorporationManager() {
    if (typeof ns.corporation !== "object" && typeof ns.corporation !== "function") {
      return; // corp not available - skip quietly
    }
    try {
      let corpExists = false;
      try { corpExists = !!ns.corporation.getCorporation(); } catch(e) { corpExists = false; }
      if (!corpExists) {
        const money = ns.getServerMoneyAvailable("home");
        const corpCostSafe = 150e6;
        if (money < corpCostSafe * 1.5) {
          if (guiDiv) guiDiv.__pushLog(`AutoCorp: not enough cash ($${Math.floor(money)}) to safely create corp.`, "warn");
          return;
        }
        try { ns.corporation.createCorporation("StableCorp", false); if (guiDiv) guiDiv.__pushLog("AutoCorp: created corporation 'StableCorp'."); } catch(e){ ns.print(`AutoCorp create failed: ${e}`); metrics.errors.push(""+e); return; }
      }

      try {
        const industry = "Tobacco";
        let divName = "StableDiv";
        try {
          const corp = ns.corporation.getCorporation();
          if (!corp.divisions || !corp.divisions.some(d=>d.name===divName)) {
            ns.corporation.expandIndustry(industry, divName);
            if (guiDiv) guiDiv.__pushLog(`AutoCorp: expanded industry ${industry} as ${divName}.`);
          }
        } catch(e) {
          try {
            const industries = ns.corporation.getIndustries();
            if (industries && industries.length) {
              const fallback = industries[0].name || industries[0];
              ns.corporation.expandIndustry(fallback, divName);
              if (guiDiv) guiDiv.__pushLog(`AutoCorp: expanded industry ${fallback} as ${divName} (fallback).`);
            }
          } catch(err) { ns.print(`AutoCorp expandIndustry failed: ${err}`); metrics.errors.push(""+err); }
        }
        try {
          const city = "Aevum";
          const div = ns.corporation.getDivision(divName);
          if (div && !div.cities.includes(city)) {
            ns.corporation.expandCity(divName, city);
            try { ns.corporation.expandOffice(divName, city, 3); } catch(e){}
            if (guiDiv) guiDiv.__pushLog(`AutoCorp: opened ${divName} office in ${city}.`);
          }
        } catch(e) {}
        try {
          const divs = ns.corporation.getCorporation().divisions;
          if (divs && divs.length) {
            for (const d of divs) {
              try { ns.corporation.hireEmployee(d.name || d, "Aevum", 3); } catch(e){}
            }
          }
        } catch(e){}
      } catch(e){ ns.print(`AutoCorp operations error: ${e}`); metrics.errors.push(""+e); }
    } catch(e){ ns.print(`AutoCorp handler error: ${e}`); metrics.errors.push(""+e); }
  }

  // ---------------- GUI Implementation ----------------
  let guiDiv = null;
  function createGUI(force=false) {
    if (guiDiv && !force) return;
    if (guiDiv && force) try { guiDiv.remove(); } catch(e){}

    // root div
    guiDiv = document.createElement("div");
    guiDiv.id = "vipers-nest";
    Object.assign(guiDiv.style, {
      position: "fixed", top: "18px", left: "18px", width: "640px", zIndex: 99999,
      fontFamily: "Inter, Arial, sans-serif", color: "#cfefff", borderRadius: "12px",
      boxShadow: "0 10px 30px rgba(0,0,0,0.6)", background: "linear-gradient(135deg, rgba(6,6,15,0.95), rgba(12,8,25,0.95))",
      border: "1px solid rgba(120,200,255,0.12)", overflow: "hidden", userSelect: "none",
      transition: "all 0.3s ease-in-out"
    });

    // header
    const header = document.createElement("div");
    header.style.display = "flex"; header.style.alignItems = "center"; header.style.padding = "8px 12px"; header.style.gap = "10px";
    const title = document.createElement("div"); title.innerText = "Viper's Nest — Master (trend + debug)"; Object.assign(title.style, {fontWeight:"900", fontSize:"15px", color:"#6fffd1", textShadow:"0 0 6px #66ffff"});
    header.appendChild(title);
    const spacer = document.createElement("div"); spacer.style.flex = "1"; header.appendChild(spacer);
    const pauseInfo = document.createElement("div"); pauseInfo.innerText = "⚠ PAUSE REQUIRED before Kill/Restart"; Object.assign(pauseInfo.style, {fontSize:"11px", color:"#ffdca3", fontWeight:"700", marginRight:"8px"});
    header.appendChild(pauseInfo);

    const btnMin = document.createElement("button"); btnMin.innerText = "▢"; btnMin.title = "Minimize"; Object.assign(btnMin.style, {background:"transparent",border:"none",color:"#88dfff",cursor:"pointer",fontSize:"14px",fontWeight:"700"});
    header.appendChild(btnMin);
    const btnClose = document.createElement("button"); btnClose.innerText = "✕"; btnClose.title = "Close (vipersNestMenu() to reopen)"; Object.assign(btnClose.style, {background:"transparent",border:"none",color:"#ff9b9b",cursor:"pointer",fontSize:"14px",fontWeight:"700"});
    header.appendChild(btnClose);

    guiDiv.appendChild(header);

    // content grid
    const content = document.createElement("div"); content.style.display = "grid"; content.style.gridTemplateColumns = "1fr 1fr"; content.style.gap = "10px"; content.style.padding = "8px 12px 12px 12px";

    // make card helper (animated)
    function makeCard(titleText) {
      const c = document.createElement("div");
      Object.assign(c.style, {
        background: "linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01))",
        border: "1px solid rgba(100,180,255,0.06)",
        borderRadius: "8px",
        padding: "8px",
        minHeight: "56px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        transition: "all 0.5s ease",
        overflow: "hidden"
      });
      const t = document.createElement("div"); t.innerText = titleText; t.style.fontSize = "11px"; t.style.color = "#8fdfff"; t.style.fontWeight="700"; c.appendChild(t);
      const v = document.createElement("div"); v.innerText = "..."; v.style.fontSize = "16px"; v.style.fontWeight = "800"; v.style.color = "#dffeff"; v.style.transition="all 0.4s ease"; c.appendChild(v);
      return {card:c, title:t, value:v};
    }

    // left column stats & graph
    const statMoney = makeCard("Money on Hand");
    const statMoneySec = makeCard("Est $ / sec");
    const statWorkers = makeCard("Workers (rooted)");
    const statPurchased = makeCard("Purchased Servers (RAM)");

    const left = document.createElement("div"); left.style.display="flex"; left.style.flexDirection="column"; left.style.gap="8px";
    left.appendChild(statMoney.card); left.appendChild(statMoneySec.card); left.appendChild(statWorkers.card); left.appendChild(statPurchased.card);

    // graph card
    const graphCard = document.createElement("div");
    Object.assign(graphCard.style, {background:"rgba(255,255,255,0.01)", border:"1px solid rgba(120,200,255,0.06)", borderRadius:"8px", padding:"6px", minHeight:"120px"});
    const graphTitleRow = document.createElement("div"); graphTitleRow.style.display="flex"; graphTitleRow.style.justifyContent="space-between"; graphTitleRow.style.alignItems="center";
    const graphTitle = document.createElement("div"); graphTitle.innerText="Performance Graph"; graphTitle.style.color="#a8eaff"; graphTitle.style.fontSize="11px";
    const trendBadge = document.createElement("div"); trendBadge.innerText = "TREND: —"; Object.assign(trendBadge.style,{fontSize:"12px", fontWeight:"800", color:"#dffeff"});
    graphTitleRow.appendChild(graphTitle); graphTitleRow.appendChild(trendBadge);
    graphCard.appendChild(graphTitleRow);
    const canvas = document.createElement("canvas"); canvas.width = 560; canvas.height = 110; canvas.style.width="100%"; canvas.style.height="110px"; graphCard.appendChild(canvas);
    left.appendChild(graphCard);

    // right column controls, map, AI
    const right = document.createElement("div"); right.style.display="flex"; right.style.flexDirection="column"; right.style.gap="8px";

    // controls area
    const controls = document.createElement("div"); Object.assign(controls.style,{display:"flex",flexWrap:"wrap",gap:"6px"});
    function mkBtn(label, tooltip, id, color) {
      const b = document.createElement("button");
      b.innerText = label;
      b.title = tooltip;
      b.id = id;
      Object.assign(b.style, {
        padding: "8px 10px",
        borderRadius: "8px",
        border: "none",
        background: color || "linear-gradient(180deg, #3a3f5a, #1b1d2a)",
        color: "#000",
        fontWeight: "800",
        cursor: "pointer",
        transition: "transform 0.12s ease, box-shadow 0.12s ease"
      });
      b.onmouseenter = () => { b.style.transform = "translateY(-3px)"; b.style.boxShadow = "0 10px 20px rgba(0,0,0,0.3)"; };
      b.onmouseleave = () => { b.style.transform = "translateY(0)"; b.style.boxShadow = "none"; };
      return b;
    }

    const btnStart = mkBtn("Start","Start automations","vn_start","linear-gradient(180deg,#9eff9e,#66ff66)");
    const btnPause = mkBtn("Pause","Pause automations","vn_pause","linear-gradient(180deg,#ffdca3,#ffb36b)");
    const btnDeploy = mkBtn("Deploy Now","Deploy helper scripts to all workers now","vn_deploy","linear-gradient(180deg,#6fffd1,#2feaff)");
    const btnUpgrade = mkBtn("Upgrade Now","Attempt immediate purchased-server upgrade","vn_upgrade","linear-gradient(180deg,#ff6fcf,#ff88ff)");
    const btnKill = mkBtn("Kill Helpers","Kill helper scripts on purchased servers (PAUSE first)","vn_kill","linear-gradient(180deg,#ff9b9b,#ff6b6b)");
    const btnKillTree = mkBtn("Kill-Tree","Kill helpers across network (PAUSE first)","vn_killtree","linear-gradient(180deg,#ff9b9b,#ff6b6b)");
    const btnStartWorkers = mkBtn("Start Workers","Start integrated worker manager (launch batchers)","vn_startworkers","linear-gradient(180deg,#6f9fff,#4f6fff)");
    const btnStopWorkers = mkBtn("Stop Workers","Stop integrated worker manager (kill batchers)","vn_stopworkers","linear-gradient(180deg,#ffdca3,#ffb36b)");
    const btnBoostHack = mkBtn("Boost Hack","Temporary aggressive hack mode","vn_boost_hack","linear-gradient(180deg,#fffc6f,#ffea6f)");
    const btnBoostGrow = mkBtn("Boost Grow","Temporary aggressive grow mode","vn_boost_grow","linear-gradient(180deg,#6fffd1,#2feaff)");
    const btnBoostWeaken = mkBtn("Boost Weaken","Temporary heavy weaken mode","vn_boost_weaken","linear-gradient(180deg,#9eff9e,#66ff66)");
    const btnDebugDump = mkBtn("Debug Dump","Dump debug info to log","vn_debugdump","linear-gradient(180deg,#d0d0ff,#a0a0ff)");

    [btnStart,btnPause,btnDeploy,btnUpgrade,btnKill,btnKillTree,btnStartWorkers,btnStopWorkers,btnBoostHack,btnBoostGrow,btnBoostWeaken,btnDebugDump].forEach(b=>controls.appendChild(b));
    right.appendChild(controls);

    // map card
    const mapCard = document.createElement("div"); Object.assign(mapCard.style, {background:"linear-gradient(180deg, rgba(0,0,0,0.12), rgba(0,0,0,0.06))", border:"1px solid rgba(120,200,255,0.06)", borderRadius:"8px", padding:"8px", minHeight:"100px", overflow:"auto"});
    const mapTitle = document.createElement("div"); mapTitle.innerText = "Network Map (rooted)"; mapTitle.style.color="#a8eaff"; mapTitle.style.fontSize="11px"; mapCard.appendChild(mapTitle);
    const mapList = document.createElement("div"); mapList.style.fontSize="12px"; mapList.style.color="#dffaff"; mapList.style.marginTop="6px"; mapCard.appendChild(mapList);
    right.appendChild(mapCard);

    // AI card
    const aiCard = document.createElement("div"); Object.assign(aiCard.style, {display:"flex",alignItems:"center",gap:"10px",background:"linear-gradient(180deg, rgba(5,10,20,0.2), rgba(0,0,0,0.05))",border:"1px solid rgba(120,200,255,0.06)",borderRadius:"8px",padding:"8px"});
    const aiBubble = document.createElement("div"); Object.assign(aiBubble.style,{width:"46px",height:"46px",borderRadius:"999px",background:"radial-gradient(circle at 30% 30%, #2feaff, #005b8a)",boxShadow:"0 8px 20px rgba(47,234,255,0.08)"}); aiCard.appendChild(aiBubble);
    const aiText = document.createElement("div"); aiText.style.display="flex"; aiText.style.flexDirection="column"; aiText.innerHTML = `<div style="font-weight:700;color:#aeefff">Assistant Core</div><div style="font-size:11px;color:#cfefff">Status: active</div>`;
    aiCard.appendChild(aiText);
    right.appendChild(aiCard);

    // debug overlay
    const debugCard = document.createElement("div"); Object.assign(debugCard.style, {gridColumn:"1/span 2", minHeight:"120px", maxHeight:"220px", overflow:"auto", padding:"8px", borderRadius:"8px", border:"1px solid rgba(255,200,100,0.06)", background:"linear-gradient(180deg, rgba(8,8,12,0.25), rgba(0,0,0,0.06))"});
    const debugTitle = document.createElement("div"); debugTitle.innerText="Debug Overlay (visible)"; debugTitle.style.color="#ffdca3"; debugTitle.style.fontSize="12px"; debugCard.appendChild(debugTitle);
    const debugBox = document.createElement("div"); debugBox.style.color="#dffaff"; debugBox.style.fontSize="12px"; debugBox.style.marginTop="6px"; debugCard.appendChild(debugBox);

    // attach layout
    content.appendChild(left); content.appendChild(right); guiDiv.appendChild(content); guiDiv.appendChild(debugCard);
    document.body.appendChild(guiDiv);

    // drag logic
    let drag = {active:false, startX:0, startY:0, origX:0, origY:0};
    header.onmousedown = (e) => { drag.active = true; drag.startX = e.clientX; drag.startY = e.clientY; drag.origX = guiDiv.offsetLeft; drag.origY = guiDiv.offsetTop; e.preventDefault(); };
    document.onmouseup = () => { drag.active = false; };
    document.onmousemove = (e) => { if (!drag.active) return; guiDiv.style.left = (drag.origX + e.clientX - drag.startX) + "px"; guiDiv.style.top = (drag.origY + e.clientY - drag.startY) + "px"; };

    // push log (DOM-only)
    function pushLog(msg, level="info") {
      const time = new Date().toLocaleTimeString();
      const row = document.createElement("div");
      row.innerText = `[${time}] ${msg}`;
      row.style.marginBottom = "4px";
      if (level === "warn") row.style.color = "#ffcc66";
      if (level === "err") row.style.color = "#ff9999";
      try { debugBox.prepend(row); } catch(e){}
      while (debugBox.childNodes.length > 400) debugBox.removeChild(debugBox.lastChild);
    }

    // refs for updates
    guiDiv.__refs = {
      statMoney, statMoneySec, statWorkers, statPurchased, canvas, mapList, aiBubble, debugBox, pushLog, trendBadge
    };

    // expose minimal GUI reopen function
    if (typeof globalThis.vipersNestMenu === "undefined") {
      globalThis.vipersNestMenu = function(force=false){ try { createGUI(force); } catch(e){ ns.tprint("vipersNestMenu err: " + e); } };
    }

    // BUTTON HANDLERS (DOM-only set flags + local log)
    function recordButtonPress(id, label) {
      lastButtonPressed = { id, time: Date.now(), label };
      try { guiDiv.__refs.pushLog(`Button pressed -> ${label}`); } catch(e){}
    }

    btnStart.onclick = () => { recordButtonPress("vn_start","Start"); running = true; };
    btnPause.onclick = () => { recordButtonPress("vn_pause","Pause"); running = false; };
    btnDeploy.onclick = () => { recordButtonPress("vn_deploy","Deploy Now"); actionFlags.deployNow = true; };
    btnUpgrade.onclick = () => { recordButtonPress("vn_upgrade","Upgrade Now"); actionFlags.upgradeNow = true; };
    btnKill.onclick = () => { recordButtonPress("vn_kill","Kill Helpers"); actionFlags.killAllHelpers = true; };
    btnKillTree.onclick = () => { recordButtonPress("vn_killtree","Kill-Tree"); actionFlags.killTree = true; };
    btnStartWorkers.onclick = () => { recordButtonPress("vn_startworkers","Start Workers"); actionFlags.startWorkers = true; };
    btnStopWorkers.onclick = () => { recordButtonPress("vn_stopworkers","Stop Workers"); actionFlags.stopWorkers = true; };
    btnBoostHack.onclick = () => { recordButtonPress("vn_boost_hack","Boost Hack"); actionFlags.boostMode = "hack"; };
    btnBoostGrow.onclick = () => { recordButtonPress("vn_boost_grow","Boost Grow"); actionFlags.boostMode = "grow"; };
    btnBoostWeaken.onclick = () => { recordButtonPress("vn_boost_weaken","Boost Weaken"); actionFlags.boostMode = "weaken"; };
    btnDebugDump.onclick = () => { recordButtonPress("vn_debugdump","Debug Dump"); actionFlags.debugDump = true; };

    btnMin.onclick = () => { guiState.minimized = !guiState.minimized; content.style.display = guiState.minimized ? "none" : "grid"; debugCard.style.display = guiState.minimized ? "none" : "block"; pushLog(`Minimize toggled -> ${guiState.minimized}`); };
    btnClose.onclick = () => { guiDiv.remove(); guiDiv = null; guiState.visible = false; if (typeof globalThis.vipersNestMenu === "function") globalThis.vipersNestMenu(false); };

    // map update helper
    guiDiv.__updateMap = (nodes) => {
      try {
        mapList.innerHTML = "";
        for (const n of nodes) {
          const el = document.createElement("div");
          const rootInfo = ns.hasRootAccess(n) ? " ✓" : "";
          el.innerText = `${n}${rootInfo} (${ns.getServerMaxRam(n)||0}GB)`;
          mapList.appendChild(el);
        }
      } catch(e){}
    };

    guiDiv.__canvas = canvas;
    guiDiv.__aiBubble = aiBubble;
    guiDiv.__pushLog = pushLog;
  } // createGUI end

  // create GUI initially
  try { createGUI(); } catch (e) { ns.print("GUI create error: " + e); }

  // ---------------- Action implementations (called from main loop) ----------------
  async function doDeployNow(workers) {
    for (const w of workers) {
      try { await deployScriptsTo(w); } catch (e) { ns.print("deploy err: " + e); }
    }
    if (guiDiv) guiDiv.__pushLog("Deployed helper scripts to workers.");
  }

  async function doUpgradeNow(workers) {
    await autoManagePurchasedServers(workers);
    if (guiDiv) guiDiv.__pushLog("Auto-upgrade attempted.");
  }

  function doKillHelpers(workers) {
    if (running) {
      if (guiDiv) guiDiv.__pushLog("Kill request blocked: Please PAUSE automation before killing helpers.", "warn");
      return;
    }
    for (const w of workers) {
      try { ns.killall(w); } catch (e) {}
    }
    if (guiDiv) guiDiv.__pushLog("Kill all helpers executed.");
  }

  async function doKillTree(allServers) {
    if (running) {
      if (guiDiv) guiDiv.__pushLog("Kill-tree blocked: Please PAUSE automation before kill-tree.", "warn");
      return;
    }
    for (const s of allServers) {
      try { ns.killall(s); } catch (e) {}
    }
    if (guiDiv) guiDiv.__pushLog("Kill-tree executed across network.");
  }

  async function startIntegratedWorkers(targets, workers) {
    try {
      const ramHack = ns.getScriptRam("hack.js","home");
      const ramGrow = ns.getScriptRam("grow.js","home");
      const ramWeaken = ns.getScriptRam("weaken.js","home");
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
          if (guiDiv) guiDiv.__pushLog(`WorkerManager skipping ${t}: need ${requiredRam.toFixed(2)}GB free ${freeRam.toFixed(2)}GB`);
          continue;
        }
        const args = [t, desiredFrac, JSON.stringify(currentWorkers)];
        let pid = ns.exec("batcher.js","home",1,...args);
        if (pid === 0) {
          let best="home"; let bestRam = ns.getServerMaxRam("home");
          for (const w of currentWorkers) { try { const r = ns.getServerMaxRam(w); if (r > bestRam) { best = w; bestRam = r; } } catch(e){} }
          try { await ns.scp(["batcher.js"], best); pid = ns.exec("batcher.js", best, 1, ...args); if (pid !==0 && guiDiv) guiDiv.__pushLog(`WorkerManager started ${t} on ${best} pid ${pid}`); } catch(e){ ns.print("worker start fallback err: " + e); metrics.errors.push(""+e); }
        } else {
          if (guiDiv) guiDiv.__pushLog(`WorkerManager launched batcher for ${t} pid ${pid}`);
        }
        metrics.batchesLaunched++;
        await safeSleep(80);
      }
    } catch(e){ ns.print("startIntegratedWorkers err: " + e); metrics.errors.push(""+e); }
  }

  async function stopIntegratedWorkers(workers) {
    for (const w of workers) {
      try { ns.killall(w); } catch(e) {}
    }
    if (guiDiv) guiDiv.__pushLog("WorkerManager stop: killall executed on workers.");
  }

  // ---------------- audio ping ----------------
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

  // ---------------- bootstrap ----------------
  ns.print("Viper's Nest (trend + debug) bootstrapping...");
  let all = scanAll();
  for (const h of all) if (h !== "home") tryNuke(h);
  all = scanAll();
  let workers = pickWorkerHosts(all);
  for (const p of ns.getPurchasedServers()) if (!workers.includes(p)) workers.push(p);
  for (const w of workers) { try { await deployScriptsTo(w); } catch (e) { ns.print(`deploy ${w}: ${e}`); } }
  ns.tprint(`Viper's Nest started. Workers: ${workers.join(", ")}`);

  // ---------------- helper: compute trend ----------------
  function computeTrend() {
    const h = metrics.moneyHistory;
    if (h.length < 3) return { label: "—", slope: 0 };
    const samples = h.slice(-cfg.trendSamples);
    const first = samples[0].m;
    const last = samples[samples.length-1].m;
    const slope = first > 0 ? (last-first)/first : 0;
    const pct = slope;
    if (pct > cfg.trendThresholdPct) return { label: "BULLISH ▲", slope: pct };
    if (pct < -cfg.trendThresholdPct) return { label: "BEARISH ▼", slope: pct };
    return { label: "NEUTRAL ■", slope: pct };
  }

  // ---------------- main loop ----------------
  while (true) {
    metrics.loops++;
    const loopStart = Date.now();
    try {
      all = scanAll();
      metrics.scannedServersCount = all.length;

      // handle GUI recorded button press logging (DOM side already logged; this just echoes)
      if (lastButtonPressed.id) {
        if (guiDiv) guiDiv.__pushLog(`Button recorded: ${lastButtonPressed.label} @ ${new Date(lastButtonPressed.time).toLocaleTimeString()}`);
        lastButtonPressed.id = null;
      }

      // rebuild workers if flagged
      if (actionFlags.rebuildWorkers) {
        actionFlags.rebuildWorkers = false;
        workers = pickWorkerHosts(all);
        for (const p of ns.getPurchasedServers()) if (!workers.includes(p)) workers.push(p);
        if (guiDiv) guiDiv.__pushLog("Workers rebuilt (flag processed).");
      }

      // process GUI-triggered flags (only here we call ns.*)
      if (actionFlags.deployNow) {
        actionFlags.deployNow = false;
        workers = pickWorkerHosts(all);
        for (const p of ns.getPurchasedServers()) if (!workers.includes(p)) workers.push(p);
        await doDeployNow(workers);
        audioPing();
        if (guiDiv) guiDiv.__pushLog("Processed: Deploy Now");
      }
      if (actionFlags.upgradeNow) {
        actionFlags.upgradeNow = false;
        workers = pickWorkerHosts(all);
        for (const p of ns.getPurchasedServers()) if (!workers.includes(p)) workers.push(p);
        await doUpgradeNow(workers);
        audioPing();
        if (guiDiv) guiDiv.__pushLog("Processed: Upgrade Now");
      }
      if (actionFlags.killAllHelpers) {
        actionFlags.killAllHelpers = false;
        workers = pickWorkerHosts(all);
        for (const p of ns.getPurchasedServers()) if (!workers.includes(p)) workers.push(p);
        doKillHelpers(workers);
        audioPing();
        if (guiDiv) guiDiv.__pushLog("Processed: Kill Helpers");
      }
      if (actionFlags.killTree) {
        actionFlags.killTree = false;
        await doKillTree(all);
        audioPing();
        if (guiDiv) guiDiv.__pushLog("Processed: Kill-Tree");
      }
      if (actionFlags.startWorkers) {
        actionFlags.startWorkers = false;
        workers = pickWorkerHosts(all);
        for (const p of ns.getPurchasedServers()) if (!workers.includes(p)) workers.push(p);
        await startIntegratedWorkers(pickTargets(all, cfg.targetCount), workers);
        audioPing();
        if (guiDiv) guiDiv.__pushLog("Processed: Start Workers");
      }
      if (actionFlags.stopWorkers) {
        actionFlags.stopWorkers = false;
        workers = pickWorkerHosts(all);
        for (const p of ns.getPurchasedServers()) if (!workers.includes(p)) workers.push(p);
        await stopIntegratedWorkers(workers);
        audioPing();
        if (guiDiv) guiDiv.__pushLog("Processed: Stop Workers");
      }
      if (actionFlags.boostMode) {
        const mode = actionFlags.boostMode; actionFlags.boostMode = null;
        if (guiDiv) guiDiv.__pushLog(`Processing boostMode: ${mode}`);
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
        if (guiDiv) guiDiv.__pushLog(`Processed: Boost ${mode}`);
      }
      if (actionFlags.debugDump) {
        actionFlags.debugDump = false;
        ns.tprint(JSON.stringify({metrics, toggles, cfg}, null, 2));
        if (guiDiv) guiDiv.__pushLog("Processed: Debug Dump (tprint)");
      }

      // auto ops
      await autoRootAll(all);
      workers = pickWorkerHosts(all);
      for (const p of ns.getPurchasedServers()) if (!workers.includes(p)) workers.push(p);
      for (const w of workers) { try { await deployScriptsTo(w); } catch (e) { /*ignore*/ } }
      await autoBuyOptionalTools();
      await autoManagePurchasedServers(workers);
      try { await autoManageHacknet(); } catch(e) { /* ignore hacknet errors */ }
      try { await autoCorporationManager(); } catch(e) { /* ignore corporation errors */ }

      // update metrics
      metrics.workersCount = workers.length;
      metrics.purchasedServers = ns.getPurchasedServers();
      metrics.totalPurchasedRam = metrics.purchasedServers.reduce((a,s)=>a + (ns.getServerMaxRam(s)||0),0);
      metrics.lastTargets = pickTargets(all, cfg.targetCount);

      // money/sec
      const nowMoney = ns.getServerMoneyAvailable("home");
      const nowTime = Date.now();
      metrics.moneyHistory.push({t: nowTime, m: nowMoney});
      if (metrics.moneyHistory.length > 240) metrics.moneyHistory.shift();
      if (metrics.moneyHistory.length >= 2) {
        const oldest = metrics.moneyHistory[0];
        const newest = metrics.moneyHistory[metrics.moneyHistory.length-1];
        const dt = (newest.t - oldest.t) / 1000.0;
        metrics.moneyPerSec = dt > 0 ? (newest.m - oldest.m) / dt : 0;
      } else metrics.moneyPerSec = 0;

      // find running PIDs for "batcher.js" (best-effort) for debug overlay
      try {
        metrics.lastPIDs = [];
        for (const s of [...workers, "home"]) {
          try {
            const procs = ns.ps(s);
            for (const p of procs) {
              if (p.filename && p.filename.indexOf("batcher") !== -1) metrics.lastPIDs.push({host:s, pid:p.pid, file:p.filename});
            }
          } catch(e){}
        }
      } catch(e){}

      // Schedule batchers if running
      if (running) {
        const targets = metrics.lastTargets;
        const ramHack = ns.getScriptRam("hack.js","home");
        const ramGrow = ns.getScriptRam("grow.js","home");
        const ramWeaken = ns.getScriptRam("weaken.js","home");
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
              requiredRam = plan.hackThreads*ramHack + plan.growThreads*ramGrow + (plan.weaken1+plan.weaken2)*ramWeaken;
              freeRam = totalFreeRam(currentWorkers);
              iter++;
            }
            if (requiredRam > freeRam) {
              if (guiDiv) guiDiv.__pushLog(`Skipping ${t}: requires ${requiredRam.toFixed(2)}GB, free ${freeRam.toFixed(2)}GB`);
              continue;
            }
            const args = [t, desiredFrac, JSON.stringify(currentWorkers)];
            let pid = ns.exec("batcher.js","home",1,...args);
            if (pid === 0) {
              let best="home"; let bestRam = ns.getServerMaxRam("home");
              for (const w of currentWorkers) { try { const r = ns.getServerMaxRam(w); if (r > bestRam) { best = w; bestRam = r; } } catch(e){} }
              try { await ns.scp(["batcher.js"], best); pid = ns.exec("batcher.js", best, 1, ...args); if (pid!==0) { metrics.batchesLaunched++; if (guiDiv) guiDiv.__pushLog(`Fallback started ${t} on ${best} (pid ${pid})`); } else { if (guiDiv) guiDiv.__pushLog(`Failed start ${t}`); } } catch(e){ ns.print(`Fallback failed ${t}: ${e}`); metrics.errors.push(""+e); }
            } else {
              metrics.batchesLaunched++;
              if (guiDiv) guiDiv.__pushLog(`Launched batcher for ${t} (hackFrac ${(desiredFrac*100).toFixed(3)}%) pid ${pid}`);
            }
            metrics.lastPlans[t] = { plan, requiredRam, freeRam, desiredFrac };
          } catch(e){ ns.print(`schedule err ${t}: ${e}`); metrics.errors.push(""+e); }
          await safeSleep(120);
        }
      }

      // GUI updates (DOM-only)
      try {
        if (guiDiv) {
          const refs = guiDiv.__refs;
          refs.statMoney.value.innerText = `$${Math.floor(metrics.moneyHistory.length?metrics.moneyHistory[metrics.moneyHistory.length-1].m:ns.getServerMoneyAvailable("home")).toLocaleString()}`;
          refs.statMoneySec.value.innerText = `$${metrics.moneyPerSec.toFixed(2)}/s`;
          refs.statWorkers.value.innerText = `${metrics.workersCount} servers`;
          refs.statPurchased.value.innerText = `${metrics.purchasedServers.length} servers · ${metrics.totalPurchasedRam} GB total`;

          // update map
          guiDiv.__updateMap(pickWorkerHosts(all));

          // canvas draw
          const c = guiDiv.__canvas;
          const ctx = c.getContext("2d");
          ctx.clearRect(0,0,c.width,c.height);
          ctx.fillStyle = "rgba(10,10,18,0.7)";
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
            ctx.strokeStyle = "#66eeff";
            ctx.lineWidth = 2;
            ctx.stroke();
          }
          // purchased ram bar
          const ramPercent = Math.min(1, metrics.totalPurchasedRam / Math.max(1, cfg.purchasedTargetUpgradeMultiplier*512));
          ctx.fillStyle = "rgba(100,200,255,0.12)";
          ctx.fillRect(0,c.height-8,c.width*ramPercent,6);
          ctx.fillStyle = "#66ffcc";
          ctx.fillRect(0,c.height-8,c.width*ramPercent,2);

          // AI bubble pulse
          const totalRamAll = metrics.totalPurchasedRam + (ns.getServerMaxRam("home")||0) + (pickWorkerHosts(all).reduce((a,s)=>a + (ns.getServerMaxRam(s)||0),0) || 0);
          const freeRamAll = totalFreeRam(pickWorkerHosts(all));
          const freePct = Math.min(1, totalRamAll === 0 ? 0 : freeRamAll / Math.max(1, totalRamAll));
          const scale = 0.9 + (freePct * 0.4);
          guiDiv.__aiBubble.style.transform = `scale(${scale})`;

          // trend indicator
          const trend = computeTrend();
          try {
            guiDiv.__refs.trendBadge.innerText = `TREND: ${trend.label}`;
            if (trend.label.indexOf("BULL")>=0) guiDiv.__refs.trendBadge.style.color = "#9eff9e";
            else if (trend.label.indexOf("BEAR")>=0) guiDiv.__refs.trendBadge.style.color = "#ff9b9b";
            else guiDiv.__refs.trendBadge.style.color = "#ffdca3";
          } catch(e){}

          // debug overlay content
          const dbg = guiDiv.__refs.debugBox;
          dbg.innerHTML = "";
          const titleRow = document.createElement("div"); titleRow.style.fontWeight="800"; titleRow.style.marginBottom="6px"; titleRow.innerText = `Loops: ${metrics.loops} | Batches Launched: ${metrics.batchesLaunched} | Workers: ${metrics.workersCount}`;
          dbg.appendChild(titleRow);
          const btnRow = document.createElement("div"); btnRow.innerText = `Last Button: ${lastButtonPressed.label ? lastButtonPressed.label + " @ " + new Date(lastButtonPressed.time).toLocaleTimeString() : "none"}`;
          dbg.appendChild(btnRow);

          const pidTitle = document.createElement("div"); pidTitle.style.marginTop="6px"; pidTitle.style.fontWeight="700"; pidTitle.innerText = "Active Batcher PIDs:";
          dbg.appendChild(pidTitle);
          if (metrics.lastPIDs.length) {
            for (const p of metrics.lastPIDs.slice(0,30)) {
              const r = document.createElement("div"); r.innerText = `${p.host} : pid ${p.pid} - ${p.file}`; dbg.appendChild(r);
            }
          } else {
            const r = document.createElement("div"); r.innerText = "(none)"; dbg.appendChild(r);
          }

          const mhTitle = document.createElement("div"); mhTitle.style.marginTop="6px"; mhTitle.style.fontWeight="700"; mhTitle.innerText = "Recent money samples (last -> now):";
          dbg.appendChild(mhTitle);
          const samples = metrics.moneyHistory.slice(-10).map(s=>Math.floor(s.m));
          const sampleRow = document.createElement("div"); sampleRow.innerText = samples.join("  |  ");
          dbg.appendChild(sampleRow);

          // errors short
          if (metrics.errors.length) {
            const errTitle = document.createElement("div"); errTitle.style.marginTop="6px"; errTitle.style.fontWeight="700"; errTitle.style.color="#ff9999"; errTitle.innerText = "Recent Errors:";
            dbg.appendChild(errTitle);
            for (const e of metrics.errors.slice(-5).reverse()) {
              const r = document.createElement("div"); r.innerText = e; r.style.color="#ff9999"; dbg.appendChild(r);
            }
          }
        }
      } catch(e){ ns.print("GUI update err: " + e); metrics.errors.push(""+e); }

      // sleep pacing
      const elapsed = Date.now() - loopStart;
      const target = Math.max(200, cfg.batchIntervalMs - elapsed);
      await safeSleep(target);
    } catch (ex) {
      ns.tprint(`Viper's Nest main loop error: ${ex}`);
      metrics.errors.push(""+ex);
      await safeSleep(3000);
    }
  } // end main while
} // end main
