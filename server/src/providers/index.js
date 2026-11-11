import { resendProvider } from './resend.js';
import { consoleProvider } from './console.js';
import { smtpProviderFor } from './smtp.js';

const registry = { resend: resendProvider, console: consoleProvider };

// Tests use this to plug in a provider that fails or hangs on purpose.
export function registerProvider(name, provider) {
  registry[name] = provider;
}

// FORCE_PROVIDER (used by tests and dry runs) wins over the workspace's choice. SMTP is built per workspace, because it
// picks among that workspace's own mailboxes.
export function getProvider(workspace) {
  const name = process.env.FORCE_PROVIDER || workspace.provider || 'resend';
  if (name === 'smtp') return smtpProviderFor(workspace);
  const provider = registry[name];
  if (!provider) throw new Error(`unknown provider: ${name}`);
  return provider;
}
