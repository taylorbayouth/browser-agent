'use strict';

// Prompt-facing URL cleanup. Keep semantically useful query params (e.g. `q`)
// but remove common tracking/search boilerplate and cap long tails.
const NOISY_URL_PARAMS = new Set([
  // Ad-click IDs (one per vendor; per-click, never change page content).
  'dclid', 'fbclid', 'gclid', 'gbraid', 'wbraid', 'igshid', 'mc_cid', 'mc_eid', 'msclkid',
  'yclid', 'twclid', 'ttclid', 'li_fat_id', 'epik', 'rdt_cid', 'sccid', 'irclickid', 'gad_source',
  // Professional-network / job-site link trackers (pure per-link IDs; don't change page content).
  // LinkedIn: trk= on every share/apply link. Job boards: refid/trackingid/sessionredirect.
  'trk', 'refid', 'trackingid', 'sessionredirect',
  // Email/marketing trackers (per-recipient identifiers; don't affect content).
  'mkt_tok', '_hsenc', '_hsmi', '_openstat', 'vero_id', 'oly_anon_id', 'oly_enc_id', 's_cid', 'srsltid',
  // Common Google/Search boilerplate. Keep `q`, `tbm`, `tbs`, and content-bearing
  // params like `hl`/`gl`. `sstk` is a per-request signed token — stripping it
  // also keeps re-issued identical searches from looking novel to revisit detection.
  'ei', 'gs_lcrp', 'gs_lp', 'ie', 'oq', 'sca_esv', 'sclient', 'sourceid', 'sxsrf', 'uact', 'ved',
  'biw', 'bih', 'sstk', 'sa', 'dpr', 'aqs', 'rlz', 'gs_ssp', 'cad', 'usg',
]);

function cleanUrl(url, opts = {}) {
  if (!url) return null;
  const max = typeof opts === 'number' ? opts : (opts?.max ?? 500);
  let clean;
  try {
    const u = new URL(String(url));
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (lower.startsWith('utm_') || NOISY_URL_PARAMS.has(lower) || u.searchParams.get(key) === '') {
        u.searchParams.delete(key);
      }
    }
    clean = u.toString();
  } catch {
    const raw = String(url);
    const hash = raw.indexOf('#');
    clean = hash === -1 ? raw : raw.slice(0, hash);
  }
  return max > 0 && clean.length > max ? `${clean.slice(0, Math.max(0, max - 3))}...` : clean;
}

module.exports = { cleanUrl };
