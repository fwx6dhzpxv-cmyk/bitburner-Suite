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
    let frac = ns.args[1];
    const workers = JSON.parse(ns.args[2]);

    const ramH = ns.getScriptRam("hack.js");
    const ramG = ns.getScriptRam("grow.js");
    const ramW = ns.getScriptRam("weaken.js");

    // --- security multipliers ----
    const SEC_HACK = 0.002;
    const SEC_GROW = 0.004;
    const SEC_WEAK = 0.05;

    function estimatePlan(myFrac) {
        const maxMoney = ns.getServerMaxMoney(target);
        const currentMoney = Math.max(1, ns.getServerMoneyAvailable(target));
        const steal = Math.max(1, Math.min(maxMoney * myFrac, currentMoney));

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

    function getTotalFreeRam() {
        return workers.reduce((acc, w) => acc + ns.getServerMaxRam(w) - ns.getServerUsedRam(w), 0);
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
        let myFrac = frac;
        let plan = estimatePlan(myFrac);

        // First, schedule as many weaken2 as possible (partial OK)
        let w2Remaining = plan.weakenThreads2;
        if (w2Remaining > 0) {
            let freeHosts = getFreeRamList();
            for (const h of freeHosts) {
                if (w2Remaining <= 0) break;
                const scriptRam = ramW;
                const maxFits = Math.floor(h.free / scriptRam);
                if (maxFits <= 0) continue;
                const runThreads = Math.min(maxFits, w2Remaining);
                const ok = await trySchedule(h.host, "weaken.js", runThreads, target);
                if (ok) w2Remaining -= runThreads;
            }
        }

        // Now, for the batch, check if full possible; if not, binary search for smaller frac
        let batchJobs = [
            { script: "hack.js", threads: plan.hackThreads, args: [target] },
            { script: "grow.js", threads: plan.growThreads, args: [target] },
            { script: "weaken.js", threads: plan.weakenThreads1, args: [target] }
        ];

        // Function to check if jobs can be scheduled (dry run)
        function canSchedule(jobs) {
            const simFree = getFreeRamList().map(e => ({ ...e }));
            for (const job of jobs) {
                let simRemaining = job.threads;
                for (const h of simFree) {
                    if (simRemaining <= 0) break;
                    const scriptRam = ns.getScriptRam(job.script);
                    const maxFits = Math.floor(h.free / scriptRam);
                    if (maxFits <= 0) continue;
                    const runThreads = Math.min(maxFits, simRemaining);
                    h.free -= runThreads * scriptRam;
                    simRemaining -= runThreads;
                }
                if (simRemaining > 0) return false;
            }
            return true;
        }

        let scheduled = canSchedule(batchJobs);

        if (!scheduled) {
            // Binary search for max myFrac
            let low = 0;
            let high = myFrac;
            let bestFrac = 0;
            let bestPlan = null;
            for (let i = 0; i < 20; i++) {
                let mid = (low + high) / 2;
                let tempPlan = estimatePlan(mid);
                let tempJobs = [
                    { script: "hack.js", threads: tempPlan.hackThreads, args: [target] },
                    { script: "grow.js", threads: tempPlan.growThreads, args: [target] },
                    { script: "weaken.js", threads: tempPlan.weakenThreads1, args: [target] }
                ];
                if (canSchedule(tempJobs) && mid > bestFrac) {
                    bestFrac = mid;
                    bestPlan = tempPlan;
                    low = mid;
                } else {
                    high = mid;
                }
            }
            if (bestFrac > 0 && bestPlan.hackThreads >= 1) {
                myFrac = bestFrac;
                plan = bestPlan;
                batchJobs = [
                    { script: "hack.js", threads: plan.hackThreads, args: [target] },
                    { script: "grow.js", threads: plan.growThreads, args: [target] },
                    { script: "weaken.js", threads: plan.weakenThreads1, args: [target] }
                ];
                scheduled = true;
            }
        }

        if (!scheduled) {
            if (VERBOSE && plan.weakenThreads2 === 0) {
                ns.print(`No room for batch, sleeping.`);
            }
            await ns.sleep(2000);
            continue;
        }

        // Schedule the batch
        let scheduledAll = true;
        for (const job of batchJobs) {
            let remaining = job.threads;
            let freeHosts = getFreeRamList();
            for (const h of freeHosts) {
                if (remaining <= 0) break;
                const scriptRam = ns.getScriptRam(job.script);
                const maxFits = Math.floor(h.free / scriptRam);
                if (maxFits <= 0) continue;
                const runThreads = Math.min(maxFits, remaining);
                const ok = await trySchedule(h.host, job.script, runThreads, ...job.args);
                if (!ok) {
                    scheduledAll = false;
                    break;
                }
                remaining -= runThreads;
            }
            if (remaining > 0) {
                scheduledAll = false;
                if (VERBOSE) {
                    ns.print(`WARN: ${job.script} needed ${job.threads} but ${remaining} could not schedule.`);
                }
                break;
            }
        }

        if (!scheduledAll) {
            // Should not happen due to dry run
            await ns.sleep(2000);
        }
        // No sleep if successful, loop immediately to try next batch
    }
}
