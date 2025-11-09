/** grow.js
 * Usage: run grow.js target delayMs
 */

export async function main(ns) {
    const target = ns.args[0];
    const delay = Math.max(0, Number(ns.args[1]) || 0);
    if (!target) {
        ns.tprint("Usage: run grow.js target delayMs");
        return;
    }
    await ns.sleep(delay);
    try {
        await ns.grow(target);
    } catch (e) {
        ns.print("grow.js error: " + e);
    }
}
