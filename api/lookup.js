const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Scrapes the PEPPOL participant lookup page for a given NZBN
 * and returns the AP Certificate owner name.
 */
async function scrapeAccessPoint(nzbn) {
  // Normalize: strip any existing "0088:" prefix, then re-add it
  const clean = nzbn.toString().trim().replace(/^0088:/i, '');
  const value = `0088:${clean}`;
  const encodedValue = encodeURIComponent(value);

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

  return certOwner;
}

/**
 * Vercel Serverless Function
 * GET /api/lookup?nzbn=9429000034753
 * Returns: { owner: "Company Name" } or { owner: null }
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

  const nzbn = ((req.query && req.query.nzbn) || '').toString().trim();

  if (!nzbn) {
    return res.status(400).json({ error: 'Missing nzbn parameter' });
  }

  try {
    const owner = await scrapeAccessPoint(nzbn);
    return res.json({ owner: owner || null });
  } catch (err) {
    console.error(`Lookup error for NZBN "${nzbn}":`, err.message);
    return res.status(500).json({ error: err.message, owner: null });
  }
};
