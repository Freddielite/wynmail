import { resendProvider } from './resend.js';
import { consoleProvider } from './console.js';
// Future: import { wynsmtpProvider } from './wynsmtp.js';

const registry = { resend: resendProvider, console: consoleProvider };

export function getProvider(workspace) {
  const name = process.env.FORCE_PROVIDER || workspace.provider || 'resend';
  const provider = registry[name];
  if (!provider) throw new Error(`unknown provider: ${name}`);
  return provider;
}
