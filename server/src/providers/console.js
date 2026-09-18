// Dev provider. Logs instead of sending. Keeps the same contract as real providers.
export const consoleProvider = {
  name: 'console',
  async send({ to, subject }) {
    console.log(`[console provider] -> ${to} :: ${subject}`);
    return { id: `console_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` };
  }
};
