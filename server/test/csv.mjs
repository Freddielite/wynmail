import { parseCsv, readContacts } from '../src/csv.js';
import { isEmail, normEmail } from '../src/validate.js';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const read = (text) => readContacts(parseCsv(text), { isEmail, normEmail });

let r = read('email,first_name,company\nada@example.com,Ada,"Zenith, Lagos"\n');
check('quoted comma stays in one field', r.contacts[0].attributes.company === 'Zenith, Lagos', JSON.stringify(r));

r = read('email,name\r\nada@example.com,"She said ""hi"""\r\n');
check('doubled quotes are unescaped', r.contacts[0].attributes.name === 'She said "hi"', JSON.stringify(r));

r = read('email,notes\nada@example.com,"line one\nline two"\nbob@example.com,ok\n');
check('newline inside quotes does not split the row', r.contacts.length === 2 && r.contacts[0].attributes.notes === 'line one\nline two', JSON.stringify(r));

r = read('\uFEFFEmail;First Name;City\nada@example.com;Ada;Abuja\n');
check('BOM, semicolons and header aliases work', r.contacts[0].first_name === 'Ada' && r.contacts[0].attributes.city === 'Abuja', JSON.stringify(r));

r = read('email\tfirst\nada@example.com\tAda\n');
check('tab separated files work', r.contacts[0].first_name === 'Ada');

r = read('Email Address,Surname\nADA@Example.com,Obi\nada@example.com,Obi\nnot-an-email,X\n,Y\n');
check('duplicates and bad rows are counted', r.contacts.length === 1 && r.duplicates === 1 && r.skipped === 2 && r.errors[0].row === 4, JSON.stringify(r));
check('emails are lower-cased and last name aliases map', r.contacts[0].email === 'ada@example.com' && r.contacts[0].last_name === 'Obi');

r = read('name,city\nAda,Abuja\n');
check('missing email column gives a clear error', /email/i.test(r.error || ''), JSON.stringify(r));

r = read('email\n');
check('header only gives a clear error', !!r.error);

const big = 'email\n' + Array.from({ length: 6 }, (_, i) => `u${i}@example.com`).join('\n');
r = readContacts(parseCsv(big), { maxRows: 5, isEmail, normEmail });
check('row cap is enforced', !!r.error);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
