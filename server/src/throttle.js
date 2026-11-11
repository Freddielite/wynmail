// One shared gate for every provider call (campaigns and API sends), so the provider's
// requests-per-second limit is respected no matter where the send comes from.
// Every call has a deadline: one that never answers is cut off, so it cannot hold up
// every send queued behind it.
import { withTimeout } from './timeout.js';

const GAP = Number(process.env.SEND_GAP_MS || 500);
const CALL_LIMIT_MS = Number(process.env.SEND_TIMEOUT_MS || 30000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let chain = Promise.resolve();

export function throttled(fn) {
  const run = chain.then(() => withTimeout(fn(), CALL_LIMIT_MS, 'The email provider did not answer in time'));
  chain = run.then(() => sleep(GAP), () => sleep(GAP));
  return run;
}
