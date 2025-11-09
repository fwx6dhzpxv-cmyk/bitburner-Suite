/** weaken.js
 * Usage: run weaken.js <target> <delayMs>
 *
 * Sleeps <delayMs> milliseconds (optional), then runs a single ns.weaken(target).
 * This file intentionally uses only the `ns` API to avoid "undefined" globals.
 */

export async function main(ns) {
  const target = ns.args[0];
  const delay = Math.max(0, Number(ns.args[1]) || 0);

  if (!target) {
    ns.tprint("Usage: run weaken.js <target> <delayMs>");
    return;
  }

  if (delay > 0) await ns.sleep(delay);

  try {
    await ns.weaken(target);
  } catch (err) {
    ns.print(`weaken.js error on target=${target}: ${err}`);
    ns.tprint(`weaken.js failed: ${err}`);
  }
}
