// Dev provider. Logs instead of sending. Keeps the same contract as real providers.
// The open-tracking token is logged too, so tests can open and click the way a person would.
export const consoleProvider = {
  name: 'console',
  async send({ to, subject, html }) {
    const t = String(html || '').match(/\/t\/o\/([a-f0-9]{32})/);
    console.log(`[console provider] -> ${to} :: ${subject}${t ? ` | t=${t[1]}` : ''}`);
    return { id: `console_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` };
  }
};
