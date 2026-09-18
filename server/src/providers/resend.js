import { Resend } from 'resend';

// Contract every provider implements:
//   send({ to, from, replyTo, subject, html, text, headers }) -> { id }
// Swap this out for the in-house SMTP engine later without touching the queue.
export const resendProvider = {
  name: 'resend',
  async send({ to, from, replyTo, subject, html, text, headers, apiKey }) {
    const client = new Resend(apiKey || process.env.RESEND_API_KEY);
    const { data, error } = await client.emails.send({
      from, to, subject, html, text, reply_to: replyTo, headers
    });
    if (error) throw new Error(error.message || 'resend send failed');
    return { id: data?.id };
  }
};
