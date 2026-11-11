// Gives a promise a deadline. A call to the outside world (an email provider, a mail
// server) that never answers must not be able to hold up everything behind it.
export class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TimeoutError';
    this.kind = 'timeout';
  }
}

export function withTimeout(promise, ms, message = 'Timed out') {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(message)), ms);
  });
  return Promise.race([Promise.resolve(promise), limit]).finally(() => clearTimeout(timer));
}
