import fs from 'node:fs';
import { fetchPage } from './safefetch.js';
import { normalizeSite, registrableDomain, userAgent, cleanCandidate } from './finder.js';

// Finds businesses by category and city from OpenStreetMap (free, open data). Many list a website, some a phone or email.
// Each query is one polite request to a public Overpass server, capped in size and time.

export const CATEGORIES = {
  restaurants: { label: 'Restaurants and cafes', tags: ['amenity=restaurant', 'amenity=cafe', 'amenity=fast_food', 'amenity=bar'] },
  hotels: { label: 'Hotels and guest houses', tags: ['tourism=hotel', 'tourism=guest_house', 'tourism=hostel', 'tourism=apartment'] },
  health: { label: 'Clinics, hospitals and dentists', tags: ['amenity=clinic', 'amenity=hospital', 'amenity=dentist', 'amenity=doctors'] },
  pharmacies: { label: 'Pharmacies', tags: ['amenity=pharmacy'] },
  schools: { label: 'Schools, colleges and universities', tags: ['amenity=school', 'amenity=college', 'amenity=university', 'amenity=kindergarten'] },
  shops: { label: 'Shops and stores', tags: ['shop'] },
  fashion: { label: 'Fashion, clothing and beauty', tags: ['shop=clothes', 'shop=boutique', 'shop=shoes', 'shop=jewelry', 'shop=beauty', 'shop=hairdresser', 'shop=cosmetics'] },
  supermarkets: { label: 'Supermarkets and groceries', tags: ['shop=supermarket', 'shop=convenience', 'shop=greengrocer', 'shop=bakery'] },
  cars: { label: 'Car dealers and garages', tags: ['shop=car', 'shop=car_repair', 'shop=tyres', 'amenity=car_rental'] },
  realestate: { label: 'Real estate agents', tags: ['office=estate_agent', 'office=property_management'] },
  legal: { label: 'Lawyers and accountants', tags: ['office=lawyer', 'office=accountant', 'office=tax_advisor', 'office=notary'] },
  finance: { label: 'Banks and insurance', tags: ['amenity=bank', 'office=insurance', 'amenity=bureau_de_change'] },
  fitness: { label: 'Gyms and fitness', tags: ['leisure=fitness_centre', 'leisure=sports_centre'] },
  tech: { label: 'IT, software and telecom', tags: ['office=it', 'office=company', 'office=telecommunication', 'shop=computer', 'shop=mobile_phone', 'shop=electronics'] },
  construction: { label: 'Construction, engineering and crafts', tags: ['craft', 'office=engineer', 'office=architect'] },
  offices: { label: 'Other offices and companies', tags: ['office'] },
  ngos: { label: 'NGOs and associations', tags: ['office=ngo', 'office=association', 'office=foundation', 'amenity=place_of_worship'] }
};

export const COUNTRIES = { NG: 'Nigeria', GH: 'Ghana', KE: 'Kenya', ZA: 'South Africa', UG: 'Uganda', TZ: 'Tanzania', EG: 'Egypt', AE: 'United Arab Emirates', GB: 'United Kingdom', US: 'United States', CA: 'Canada', IN: 'India' };

// Social pages and link-in-bio tools are not a business's own site: there is nothing to read there.
const NOT_A_SITE = /(^|\.)(facebook|instagram|twitter|x|linkedin|tiktok|youtube|wa|whatsapp|linktr|linktree|t|telegram|pinterest|google|goo|bit|maps|business|wixsite|blogspot|wordpress|weebly|jimdosite)\.(com|me|ee|gl|ly|site|co|page|link|org|net)$/i;

export function cleanPlace(city) {
  const c = String(city || '').replace(/\s+/g, ' ').trim();
  return /^[\p{L}\p{M}0-9 .'’-]{2,60}$/u.test(c) ? c : null;
}

export function buildQuery({ category, city, country, limit = 250 }) {
  const cat = CATEGORIES[category];
  const place = cleanPlace(city);
  if (!cat) throw Object.assign(new Error('Pick a business type'), { status: 400 });
  if (!place) throw Object.assign(new Error('Type a city or town (letters only)'), { status: 400 });
  if (!COUNTRIES[country]) throw Object.assign(new Error('Pick a country'), { status: 400 });
  const filters = cat.tags.map((t) => {
    const [k, v] = t.split('=');
    return v ? `nwr["${k}"="${v}"](area.a);` : `nwr["${k}"](area.a);`;
  }).join('');
  return `[out:json][timeout:25];area["ISO3166-1"="${country}"]->.c;area["name"="${place.replace(/"/g, '')}"](area.c)->.a;(${filters});out tags center ${Math.min(limit, 500)};`;
}

const SERVERS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const tag = (t, ...keys) => keys.map((k) => t[k]).find((v) => typeof v === 'string' && v.trim());

export function readBusinesses(json, { city, category }) {
  const seen = new Set(), out = [];
  for (const el of json?.elements || []) {
    const t = el.tags || {};
    const name = (t.name || '').trim().slice(0, 100);
    if (!name) continue;
    const rawSite = tag(t, 'website', 'contact:website', 'url');
    const site = rawSite ? normalizeSite(rawSite.split(';')[0]) : null;
    const usable = site && !NOT_A_SITE.test(site.host) ? site : null;
    const email = cleanCandidate((tag(t, 'email', 'contact:email') || '').split(';')[0]);
    if (!usable && !email) continue;
    const key = usable ? usable.domain : `${el.type}/${el.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name, website: usable ? usable.origin : null, email: email || null,
      phone: (tag(t, 'phone', 'contact:phone', 'contact:mobile') || '').split(';')[0].slice(0, 30) || null,
      category: CATEGORIES[category]?.label || category, city: tag(t, 'addr:city') || city,
      listed_page: `https://www.openstreetmap.org/${el.type}/${el.id}`
    });
  }
  return out;
}

// Returns { businesses, total }. `get` can be replaced in tests.
export async function discoverBusinesses({ category, city, country = 'NG' }, { get = fetchPage } = {}) {
  const query = buildQuery({ category, city, country });
  if (process.env.PROSPECT_DISCOVER_FIXTURE && process.env.NODE_ENV !== 'production') { // tests only
    const json = JSON.parse(fs.readFileSync(process.env.PROSPECT_DISCOVER_FIXTURE, 'utf8'));
    const businesses = readBusinesses(json, { city, category });
    return { businesses, total: businesses.length };
  }
  let lastError = 'The map service did not answer. Try again in a minute.';
  for (const server of SERVERS) {
    const r = await get(`${server}?data=${encodeURIComponent(query)}`, { userAgent: userAgent(), accept: 'application/json', types: /json/, timeout: 30000, maxBytes: 6000000 });
    if (r.status === 429 || r.status === 504) { lastError = 'The map service is busy. Try again in a minute.'; continue; }
    if (r.body) {
      let json;
      try { json = JSON.parse(r.body); } catch { continue; }
      const businesses = readBusinesses(json, { city, category });
      return { businesses, total: businesses.length };
    }
  }
  throw Object.assign(new Error(lastError), { status: 502 });
}

export { registrableDomain };
