/** hack.js
 * Usage: run hack.js target delayMs
 * The script sleeps delayMs then does one ns.hack(target) call (single thread).
 */

export async function main(ns) {
    const target = ns.args[0];
    const delay = Math.max(0, Number(ns.args[1]) || 0);
    if (!target) {
        ns.tprint("Usage: run hack.js target delayMs");
        return;
    }
    await ns.sleep(delay);
    try {
        await ns.hack(target);
    } catch (e) {
        ns.print("hack.js error: " + e);
    }
}
