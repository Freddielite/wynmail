import { checkDomain } from '../src/dnscheck.js';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const err = (code) => Object.assign(new Error(code), { code });

// A fake DNS: records maps "TYPE host" to an array, errors maps it to an error code.
const dns = (records = {}, errors = {}) => {
  const get = (type, host) => { if (errors[`${type} ${host}`]) throw err(errors[`${type} ${host}`]); if (records[`${type} ${host}`]) return records[`${type} ${host}`]; throw err('ENODATA'); };
  return { resolveTxt: async (h) => get('TXT', h).map((r) => [r]), resolveMx: async (h) => get('MX', h), resolveCname: async (h) => get('CNAME', h), resolve4: async (h) => get('A', h) };
};
const by = (list, key) => list.find((c) => c.key === key);
const D = 'acme.ng';

const good = dns({
  [`TXT resend._domainkey.${D}`]: ['p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQ'], [`TXT send.${D}`]: ['v=spf1 include:amazonses.com ~all'],
  [`MX send.${D}`]: [{ exchange: 'feedback-smtp.eu-west-1.amazonses.com', priority: 10 }], [`TXT _dmarc.${D}`]: ['v=DMARC1; p=reject; rua=mailto:d@acme.ng'],
  'CNAME track.acme.ng': ['wynmail.onrender.com']
});
let r = await checkDomain({ domain: D, tracking: 'track.acme.ng', resolver: good });
check('a fully set up domain passes every check', r.length === 5 && r.every((c) => c.status === 'ok'), JSON.stringify(r.map((c) => [c.key, c.status])));

r = await checkDomain({ domain: D, resolver: dns() });
check('an empty domain is told what is missing', by(r, 'dkim').status === 'missing' && by(r, 'spf').status === 'missing' && by(r, 'dmarc').status === 'missing' && by(r, 'mx').status === 'warn');
check('the tracking check is skipped when no tracking domain is set', !by(r, 'tracking'));

r = await checkDomain({ domain: D, resolver: dns({ [`TXT _dmarc.${D}`]: ['v=DMARC1; p=none'] }) });
check('DMARC in monitor mode is a warning, not a failure', by(r, 'dmarc').status === 'warn' && /monitor/.test(by(r, 'dmarc').detail));

r = await checkDomain({ domain: D, resolver: dns({ [`TXT ${D}`]: ['v=spf1 include:a.com ~all', 'v=spf1 include:b.com ~all'] }) });
check('two SPF records are flagged', by(r, 'spf').status === 'warn');

r = await checkDomain({ domain: D, resolver: dns({ [`TXT ${D}`]: ['v=spf1 include:amazonses.com ~all'] }) });
check('an SPF record on the main domain is accepted', by(r, 'spf').status === 'ok' && by(r, 'spf').host === D);

r = await checkDomain({ domain: D, resolver: dns({}, { [`TXT resend._domainkey.${D}`]: 'ESERVFAIL', [`TXT send.${D}`]: 'ETIMEOUT', [`TXT ${D}`]: 'ETIMEOUT' }) });
check('a failed lookup says unknown instead of blaming the record', by(r, 'dkim').status === 'unknown' && by(r, 'spf').status === 'unknown');

r = await checkDomain({ domain: D, tracking: 'https://track.acme.ng/path', resolver: dns({ 'A track.acme.ng': ['1.2.3.4'] }) });
check('a tracking domain with an A record passes, and URLs are cleaned to a host', by(r, 'tracking').status === 'ok' && by(r, 'tracking').host === 'track.acme.ng');

r = await checkDomain({ domain: D, tracking: 'track.acme.ng', resolver: dns() });
check('a missing tracking record is reported', by(r, 'tracking').status === 'missing');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
