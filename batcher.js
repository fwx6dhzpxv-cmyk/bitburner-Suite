/** batcher.js
 * Silent, RAM-aware scheduler used by master.js (Stable mode)
 *
 * Args:
 *   target
 *   hackFraction
 *   workerList (JSON)
 */

export async function main(ns) {
    ns.disableLog("exec");
    ns.disableLog("getServerUsedRam");
    ns.disableLog("getServerMaxRam");
    ns.disableLog("sleep");

    const target = ns.args[0];
    const frac   = ns.args[1];
    const workers = JSON.parse(ns.args[2]);

    const ramH = ns.getScriptRam("hack.js");
    const ramG = ns.getScriptRam("grow.js");
    const ramW = ns.getScriptRam("weaken.js");

    // --- security multipliers ----
    const SEC_HACK = 0.002;
    const SEC_GROW = 0.004;
    const SEC_WEAK = 0.05;

    function estimatePlan() {
        const maxMoney = ns.getServerMaxMoney(target);
        const currentMoney = Math.max(1, ns.getServerMoneyAvailable(target));
        const steal = Math.max(1, Math.min(maxMoney * frac, currentMoney));

        const hackThreads = Math.max(1, Math.ceil(ns.hackAnalyzeThreads(target, steal)));

        const postHack = Math.max(1, maxMoney - steal);
        const growthFactor = Math.max(1, maxMoney / postHack);
        const growThreads = Math.max(0, Math.ceil(ns.growthAnalyze(target, growthFactor)));

        const secGain = hackThreads * SEC_HACK + growThreads * SEC_GROW;
        const weakenThreads1 = Math.max(1, Math.ceil(secGain / SEC_WEAK));

        const secGap = Math.max(0, ns.getServerSecurityLevel(target) - ns.getServerMinSecurityLevel(target));
        const weakenThreads2 = Math.max(0, Math.ceil(secGap / SEC_WEAK));

        return { hackThreads, growThreads, weakenThreads1, weakenThreads2 };
    }

    function getFreeRamList() {
        return workers.map(w => ({
            host: w,
            free: ns.getServerMaxRam(w) - ns.getServerUsedRam(w)
        })).filter(e => e.free > 0);
    }

    async function trySchedule(host, script, threads, ...args) {
        if (threads <= 0) return true;

        const free = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
        const need = threads * ns.getScriptRam(script);

        if (free < need) return false;

        const pid = ns.exec(script, host, threads, ...args);
        return pid !== 0;
    }

    // --- SILENCE FLAGS ----
    const VERBOSE = false; // set to true if you ever want debug prints

    while (true) {
        const plan = estimatePlan();

        const jobs = [
            { script: "weaken.js", threads: plan.weakenThreads1, args: [target] },
            { script: "hack.js",   threads: plan.hackThreads,     args: [target] },
            { script: "grow.js",   threads: plan.growThreads,     args: [target] },
            { script: "weaken.js", threads: plan.weakenThreads2,  args: [target] }
        ];

        let scheduledAll = true;

        for (const job of jobs) {
            let remaining = job.threads;
            let freeHosts = getFreeRamList();

            for (const h of freeHosts) {
                if (remaining <= 0) break;

                const scriptRam = ns.getScriptRam(job.script);
                const maxFits = Math.floor(h.free / scriptRam);
                if (maxFits <= 0) continue;

                const runThreads = Math.min(maxFits, remaining);

                const ok = await trySchedule(h.host, job.script, runThreads, ...job.args);
                if (!ok) continue;

                remaining -= runThreads;
            }

            if (remaining > 0) {
                scheduledAll = false;

                if (VERBOSE) {
                    ns.print(
                        `WARN: ${job.script} needed ${job.threads} but ${remaining} could not schedule.`
                    );
                }
            }
        }

        if (!scheduledAll) {
            // Instead of spamming terminal, sleep quietly and retry later
            await ns.sleep(2000);
            continue;
        }

        // Fully scheduled — sleep until next batch window
        await ns.sleep(2000);
    }
}
