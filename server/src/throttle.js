// One shared gate for every provider call (campaigns and API sends), so the provider's
// requests-per-second limit is respected no matter where the send comes from.
const GAP = Number(process.env.SEND_GAP_MS || 500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let chain = Promise.resolve();

export function throttled(fn) {
  const run = chain.then(fn);
  chain = run.then(() => sleep(GAP), () => sleep(GAP));
  return run;
}
