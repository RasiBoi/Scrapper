const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Singapore InvoiceNow requires the literal "SGUEN" prefix before the UEN:
 *   0195:SGUEN201711618K  (not 0195:201711618K)
 */
function toSguenValue(value) {
  const v = value.toString().replace(/[\s-]/g, '').toUpperCase();
  return v.startsWith('SGUEN') ? v : `SGUEN${v}`;
}

/**
 * Detect business ID type and map to the correct PEPPOL ICD scheme:
 *   NZBN → 0088:<nzbn>
 *   ABN  → 0151:<abn>
 *   UEN  → 0195:SGUEN<uen>
 */
function detectScheme(id, country) {
  const raw = (id || '').toString().trim();
  if (!raw) return null;

  // Already prefixed with a known scheme
  const prefixed = raw.match(/^(0088|0151|0195):(.+)$/i);
  if (prefixed) {
    const scheme = prefixed[1];
    let value = prefixed[2].replace(/[\s-]/g, '');
    const type = scheme === '0151' ? 'ABN' : scheme === '0195' ? 'UEN' : 'NZBN';
    if (type === 'UEN') value = toSguenValue(value);
    return { scheme, value, type };
  }

  const cleaned = raw.replace(/[\s-]/g, '');
  if (!cleaned || /^(unverified|n\/?a|none|null|-|not\s*found)$/i.test(cleaned)) {
    return null;
  }

  const c = (country || '').toString().toLowerCase();
  const isSG = /singapore|\bsg\b/i.test(c);
  const isAU = /australia|\bau\b/i.test(c);
  const isNZ = /new\s*zealand|\bnz\b/i.test(c);

  // Unsupported markets for this PEPPOL lookup (don't mis-classify as NZBN/UEN)
  if (c && !isSG && !isAU && !isNZ) {
    return null;
  }

  // Clear numeric formats win over country (ABN=11, NZBN=13)
  if (/^\d{11}$/.test(cleaned)) {
    return { scheme: '0151', value: cleaned, type: 'ABN' };
  }
  if (/^\d{13}$/.test(cleaned)) {
    return { scheme: '0088', value: cleaned, type: 'NZBN' };
  }

  // Singapore UEN (country or alphanumeric format)
  if (isSG || (/[A-Za-z]/.test(cleaned) && /^[A-Za-z0-9]+$/.test(cleaned) && cleaned.length >= 8 && cleaned.length <= 12)) {
    return { scheme: '0195', value: toSguenValue(cleaned), type: 'UEN' };
  }

  // Country fallback for other numeric lengths
  if (isAU && /^\d+$/.test(cleaned)) {
    return { scheme: '0151', value: cleaned, type: 'ABN' };
  }
  if (isNZ && /^\d+$/.test(cleaned)) {
    return { scheme: '0088', value: cleaned, type: 'NZBN' };
  }

  // Default: treat as NZBN (backward compatible) only for pure numeric IDs
  if (/^\d+$/.test(cleaned)) {
    return { scheme: '0088', value: cleaned, type: 'NZBN' };
  }

  return null;
}

/**
 * Scrapes the PEPPOL participant lookup page for a given business ID
 * and returns the AP Certificate owner name.
 */
async function scrapeAccessPoint(id, country) {
  const detected = detectScheme(id, country);
  if (!detected) {
    return { owner: null, type: null, scheme: null, value: null, skipped: true };
  }

  const { scheme, value, type } = detected;
  const peppolValue = `${scheme}:${value}`;
  const encodedValue = encodeURIComponent(peppolValue);

  const url = `https://peppol.helger.com/public/locale-en_US/menuitem-tools-participant?scheme=iso6523-actorid-upis&value=${encodedValue}&sml=autodetect&querybc=yes&xsdvalidation=yes&verifysignatures=yes&action=perform`;

  const response = await axios.get(url, {
    timeout: 25000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
  });

  const $ = cheerio.load(response.data);
  let certOwner = null;

  // Strategy 1: find the "Endpoint AP Certificate" heading, then look for card-header below it
  $('h2, h3, h4').each((i, el) => {
    const headingText = $(el).text().trim();
    if (headingText.toLowerCase().includes('endpoint ap certificate')) {
      $(el).nextAll().each((j, sibling) => {
        if ($(sibling).is('h2, h3, h4')) return false; // stop at next heading

        $(sibling).find('.card-header').each((k, ch) => {
          const text = $(ch).text();
          if (text.toLowerCase().includes('certificate owner')) {
            const strong = $(ch).find('strong').first();
            if (strong.length) {
              certOwner = strong.text().trim();
              return false;
            }
          }
        });
        if (certOwner) return false;
      });
      if (certOwner) return false;
    }
  });

  // Strategy 2: fallback — find any .card-header with "Certificate owner:"
  if (!certOwner) {
    $('.card-header').each((i, el) => {
      const text = $(el).text();
      if (text.toLowerCase().includes('certificate owner')) {
        const strong = $(el).find('strong').first();
        if (strong.length) {
          certOwner = strong.text().trim();
          return false;
        }
      }
    });
  }

  return { owner: certOwner, type, scheme, value: peppolValue, skipped: false };
}

/**
 * Vercel Serverless Function
 * GET /api/lookup?id=9429000034753&country=New Zealand
 * Also accepts legacy ?nzbn= for backward compatibility.
 * Returns: { owner, type, scheme, value } or { owner: null }
 */
module.exports = async (req, res) => {
  // CORS headers — allow requests from any origin (needed for local dev + Vercel)
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const q = req.query || {};
  const id = ((q.id || q.nzbn) || '').toString().trim();
  const country = (q.country || '').toString().trim();

  if (!id) {
    return res.status(400).json({ error: 'Missing id parameter (NZBN, ABN, or UEN)' });
  }

  try {
    const result = await scrapeAccessPoint(id, country);
    return res.json({
      owner: result.owner || null,
      type: result.type || null,
      scheme: result.scheme || null,
      value: result.value || null,
      skipped: !!result.skipped,
    });
  } catch (err) {
    console.error(`Lookup error for ID "${id}":`, err.message);
    return res.status(500).json({ error: err.message, owner: null });
  }
};
