/* ============================================================================
 * PP-ESG — Backend Express route additions
 * ----------------------------------------------------------------------------
 * Įterpimo instrukcija / Insertion guide:
 *   1. Šis failas yra Express Router modulis. Įdėk jį šalia esamo serverio,
 *      pvz. ./routes/ppEsg.js
 *   2. Pagrindiniame serverio faile (server.js / index.js), kur jau registruoji
 *      kitų modulių proxy maršrutus, pridėk:
 *
 *          const ppEsg = require('./routes/ppEsg');
 *          app.use('/api/esg', ppEsg);
 *
 *   3. Įsitikink, kad ANTHROPIC_API_KEY yra .env faile (NIEKADA ne HTML'e).
 *      Kaip ir kituose moduliuose, raktas lieka tik serveryje.
 *
 * Saugumas / Security (žr. komentarus prie kiekvieno endpoint):
 *   - Įvesties validacija (ribojamas ilgis, tipai) — žemiau `validateBody`.
 *   - Rate limiting — `assessmentLimiter` (express-rate-limit).
 *   - Jokių vartotojo duomenų nepersiunčiame į logus.
 *   - CORS: leisk tik savo modulių domenus (pritaikyk allowlist žemiau).
 * ==========================================================================*/

const express = require('express');
const router = express.Router();

/* ------------------------------------------------------------------ *
 * Priklausomybės, kurių gali prireikti (jei dar neįdiegtos):
 *     npm i express-rate-limit
 * Node 18+ turi įmontuotą global fetch (naudojam jį Anthropic API kvietimui).
 * ------------------------------------------------------------------ */
let rateLimit;
try { rateLimit = require('express-rate-limit'); } catch (_) { rateLimit = null; }

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

/* ---- Rate limiter: brangiems AI kvietimams (apsauga nuo piktnaudžiavimo) ---- */
const assessmentLimiter = rateLimit
  ? rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
      message: { error: 'Per daug užklausų. Bandykite po minutės. / Too many requests.' } })
  : (req, res, next) => next(); // no-op, jei paketas neįdiegtas

/* ---- Įvesties validacija ---- */
function clampStr(v, max) { return typeof v === 'string' ? v.slice(0, max) : ''; }
function validateAssessmentBody(body) {
  if (!body || typeof body !== 'object') return null;
  const lang = body.lang === 'en' ? 'en' : 'lt';
  const s = body.supplier || {};
  const supplier = {
    name: clampStr(s.name, 200),
    country: clampStr(s.country, 100),
    category: clampStr(s.category, 200),
  };
  const context = clampStr(body.context, 2000);
  if (!supplier.name && !context) return null; // bent kažkiek konteksto
  return { lang, supplier, context };
}

/* ============================================================================
 * 1) POST /api/esg/sanctions-assessment
 *    AI PRELIMINARUS sankcijų rizikos vertinimas per Claude API proxy.
 *    SVARBU: AI niekada nepateikia galutinio „švarus/blokuotas" verdikto.
 *    Grąžina struktūrizuotą JSON: { level, factors[], actions[], disclaimer }
 * ==========================================================================*/
router.post('/sanctions-assessment', assessmentLimiter, async (req, res) => {
  const input = validateAssessmentBody(req.body);
  if (!input) return res.status(400).json({ error: 'Netinkami įvesties duomenys / Invalid input.' });
  if (!ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI paslauga nesukonfigūruota (nėra API rakto).' });

  const { lang, supplier, context } = input;

  const sys = lang === 'en'
    ? `You are a procurement compliance assistant for EPSO-G, a Lithuanian electricity transmission group operating under the utilities procurement law (PSĮ). You produce a PRELIMINARY, NON-FINAL sanctions-risk assessment to help a procurement officer decide what to investigate next.
HARD RULES:
- You NEVER issue a final "clean" or "blocked" verdict. That decision belongs to the responsible officer using official EU, OFAC, UN and national sanctions lists.
- You do not claim a supplier is or is not on any sanctions list; you only flag risk indicators worth verifying.
- Be concise, factual, and avoid speculation presented as fact.
Return ONLY valid JSON, no prose, matching exactly:
{"level":"low|medium|high","factors":["..."],"actions":["..."]}`
    : `Esi EPSO-G (Lietuvos elektros perdavimo grupės, veikiančios pagal PSĮ) pirkimų atitikties asistentas. Tu rengi PRELIMINARŲ, NEGALUTINĮ sankcijų rizikos vertinimą, kuris padeda pirkimų specialistui nuspręsti, ką toliau tikrinti.
GRIEŽTOS TAISYKLĖS:
- NIEKADA nepateiki galutinio „švarus" ar „blokuotas" verdikto. Šį sprendimą priima atsakingas asmuo, naudodamas oficialius ES, OFAC, JT ir nacionalinius sankcijų sąrašus.
- Neteigi, kad tiekėjas yra ar nėra kuriame nors sąraše; tik nurodai rizikos požymius, kuriuos verta patikrinti.
- Būk glaustas, faktiškas, nepateik spėlionių kaip faktų.
Grąžink TIK galiojantį JSON, be jokio papildomo teksto, tiksliai tokios formos:
{"level":"low|medium|high","factors":["..."],"actions":["..."]}`;

  const userMsg = (lang === 'en' ? 'Supplier:\n' : 'Tiekėjas:\n') +
    `- ${lang === 'en' ? 'Name' : 'Pavadinimas'}: ${supplier.name || 'n/a'}\n` +
    `- ${lang === 'en' ? 'Country' : 'Šalis'}: ${supplier.country || 'n/a'}\n` +
    `- ${lang === 'en' ? 'Category' : 'Kategorija'}: ${supplier.category || 'n/a'}\n` +
    `\n${lang === 'en' ? 'Additional context' : 'Papildomas kontekstas'}: ${context || 'n/a'}`;

  try {
    const aiRes = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 700,
        temperature: 0.2,
        system: sys,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });

    if (!aiRes.ok) {
      const detail = await aiRes.text().catch(() => '');
      console.error('Anthropic API error', aiRes.status, detail.slice(0, 200));
      return res.status(502).json({ error: 'AI paslaugos klaida / AI service error.' });
    }

    const data = await aiRes.json();
    const text = (data.content && data.content[0] && data.content[0].text) || '';

    // Robustiškai ištraukiam JSON (modelis turėtų grąžinti gryną JSON)
    let parsed;
    try {
      const match = text.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(match ? match[0] : text);
    } catch (_) {
      return res.status(502).json({ error: 'Nepavyko apdoroti AI atsakymo / Could not parse AI response.' });
    }

    const allowed = ['low', 'medium', 'high'];
    const out = {
      level: allowed.includes(parsed.level) ? parsed.level : 'medium',
      factors: Array.isArray(parsed.factors) ? parsed.factors.slice(0, 8).map(String) : [],
      actions: Array.isArray(parsed.actions) ? parsed.actions.slice(0, 8).map(String) : [],
      disclaimer: lang === 'en'
        ? 'Preliminary AI assessment only. Final decision by the responsible officer using official EU/OFAC/UN/national lists.'
        : 'Tik preliminarus AI vertinimas. Galutinį sprendimą priima atsakingas asmuo, naudodamas oficialius ES/OFAC/JT/nacionalinius sąrašus.',
      generatedAt: new Date().toISOString(),
    };
    return res.json(out);
  } catch (err) {
    console.error('sanctions-assessment failure:', err.message);
    return res.status(500).json({ error: 'Vidinė klaida / Internal error.' });
  }
});

/* ============================================================================
 * 2) (Neprivaloma) POST /api/esg/csrd-export
 *    Serverio pusės CSRD eksporto apdorojimas. MVP etape eksportas
 *    generuojamas naršyklėje; šis endpoint paliktas, jei reikės centralizuoto,
 *    audituojamo eksporto su grupės metaduomenimis ar parašu.
 * ==========================================================================*/
router.post('/csrd-export', express.json({ limit: '1mb' }), (req, res) => {
  const payload = req.body || {};
  if (!payload.dataPoints) return res.status(400).json({ error: 'Trūksta dataPoints / Missing dataPoints.' });
  const enriched = {
    ...payload,
    meta: { ...(payload.meta || {}), processedAt: new Date().toISOString(), processedBy: 'PP-ESG backend' },
  };
  // Pvz., čia galima pridėti audito įrašą, suformuoti XBRL ar pasirašyti.
  return res.json({ ok: true, export: enriched });
});

/* ============================================================================
 * 3) Integracijos endpoint'ai KITIEMS MODULIAMS (viena tiesos versija).
 *    MVP etape duomenys gyvena naršyklės LocalStorage, todėl šie endpoint'ai
 *    pateikiami kaip kontraktas (stub). Migravus į DB, jie grąžins realius
 *    duomenis iš centrinės saugyklos.
 *
 *    GET /api/esg/supplier/:id/risk             -> { id, esgRisk, riskScore }
 *    GET /api/esg/supplier/:id/sanctions-status -> { id, status, lastCheck }
 * ==========================================================================*/
router.get('/supplier/:id/risk', (req, res) => {
  // TODO (DB etapas): const s = await db.suppliers.findById(req.params.id);
  return res.json({ id: req.params.id, esgRisk: null, riskScore: null,
    note: 'Stub. Įjungus DB, grąžins realų rizikos lygį iš centrinio registro.' });
});
router.get('/supplier/:id/sanctions-status', (req, res) => {
  return res.json({ id: req.params.id, status: null, lastCheck: null,
    note: 'Stub. Įjungus DB, grąžins realų sankcijų statusą iš audito žurnalo.' });
});

/* ============================================================================
 * 4) GET /api/esg/cvpis-suppliers — automatinis tiekėjų APTIKIMAS iš data.gov.lt
 *    TIKRI LAUKAI patvirtinti iš gyvų duomenų (Arūnas, 2026-06):
 *      Rinkinys:  gov/vpt/new  ("Pirkimų, vykdytų po 2017-07-01 duomenys")
 *      Atn1 (ataskaitos antraštė):
 *         _id, authority_org_nr (perkančiosios kodas), published_date, title ...
 *      Atn1ContractList (sutartys — turi ir tiekėją, ir vertę!):
 *         atn1._id (nuoroda į ataskaitą), selected_tenderer ("kodas;pavadinimas"),
 *         total_value_of_part, conclusion_date, expiry_date, part_number ...
 *    Spinta sintaksė suderinta su jūsų /api/price: _limit=N, _sort=, select(), filtras laukas="val".
 *    Litgrid filtruojamas pagal authority_org_nr = 302564383. AI nenaudojamas.
 * ==========================================================================*/

const DATAGOV = {
  base: process.env.DATAGOV_BASE || 'https://get.data.gov.lt/datasets/gov/vpt/new',
  litgridCode: process.env.ESG_LITGRID_CODE || '302564383',
};

function parseValue(v) {
  return parseFloat(String(v == null ? '0' : v).replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.')) || 0;
}
// "302912288;ERGO Insurance SE Lietuvos filialas" -> { code, name }
function parseTenderer(s) {
  s = String(s == null ? '' : s).trim();
  if (!s) return null;
  const i = s.indexOf(';');
  if (i >= 0) return { code: s.slice(0, i).trim(), name: s.slice(i + 1).trim() };
  return /^\d{6,}$/.test(s) ? { code: s, name: '' } : { code: '', name: s };
}
function childParentId(row) {
  if (row && row.atn1 && (row.atn1._id || row.atn1.id)) return row.atn1._id || row.atn1.id;
  return row ? (row['atn1._id'] || null) : null;
}

const cvpisLimiter = rateLimit
  ? rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false })
  : (req, res, next) => next();

const _cvpisCache = new Map();
const CVPIS_TTL_MS = 30 * 60 * 1000;

/* Spinta užklausa (sintaksė kaip /api/price): _limit, _sort, select(), filtras laukas="val". */
function spintaUrl(model, opts) {
  opts = opts || {};
  const qs = [];
  (opts.filters || []).forEach(f => qs.push(f));
  if (opts.select && opts.select.length) qs.push('select(' + opts.select.join(',') + ')');
  if (opts.sort) qs.push('_sort=' + opts.sort);
  qs.push('_limit=' + (opts.limit || 5000));
  return DATAGOV.base + '/' + model + '?' + qs.join('&');
}
async function spinta(model, opts) {
  const r = await fetch(spintaUrl(model, opts), { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(model + ' HTTP ' + r.status);
  const j = await r.json();
  return Array.isArray(j) ? j : (j._data || j.data || []);
}

router.get('/cvpis-suppliers', cvpisLimiter, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 300, 1), 1000);
  const minValue = req.query.minValue != null ? Math.max(parseFloat(req.query.minValue) || 0, 0) : 0;
  let from = clampStr(req.query.from, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) { const d = new Date(); d.setMonth(d.getMonth() - 36); from = d.toISOString().slice(0, 10); }
  const raw = clampStr(req.query.buyer, 60);
  const authCode = /^\d{6,12}$/.test(raw) ? raw : DATAGOV.litgridCode;

  const cacheKey = JSON.stringify({ from, minValue, authCode, limit });
  const cached = _cvpisCache.get(cacheKey);
  if (cached && (Date.now() - cached.at) < CVPIS_TTL_MS) return res.json(cached.data);

  try {
    // PIRMINIS kelias: vienas kvietimas su filtru per nuorodą į tėvinę Atn1 lentelę.
    // SVARBU: rūšiuojam pagal sutarties datą MAŽĖJANČIA tvarka, kad 5000 įrašų riba
    // paimtų NAUJAUSIAS sutartis (kitaip trumpi laikotarpiai liktų tušti).
    const primaryFilters = ['atn1.authority_org_nr="' + authCode + '"'];
    let rows = null;
    try {
      rows = await spinta('Atn1ContractList', { filters: primaryFilters, sort: '-conclusion_date', limit: 5000 });
    } catch (e1) {
      // jei rūšiavimas pagal šį lauką nepalaikomas — bandom be rūšiavimo
      try { rows = await spinta('Atn1ContractList', { filters: primaryFilters, limit: 5000 }); }
      catch (e2) { rows = null; }
    }

    // ATSARGINIS kelias: dviejų žingsnių sujungimas (jei filtras per nuorodą nepalaikomas).
    if (!rows || !rows.length) {
      let reports;
      try { reports = await spinta('Atn1', { filters: ['authority_org_nr="' + authCode + '"'], sort: '-published_date', limit: 5000 }); }
      catch (e) {
        try { reports = await spinta('Atn1', { filters: ['authority_org_nr="' + authCode + '"'], limit: 5000 }); }
        catch (e2) { reports = await spinta('Atn1', { limit: 6000 }); }
      }
      const ids = new Set(reports.filter(a => String(a.authority_org_nr || '') === authCode).map(a => a._id));
      let all;
      try { all = await spinta('Atn1ContractList', { sort: '-conclusion_date', limit: 5000 }); }
      catch (e) { all = await spinta('Atn1ContractList', { limit: 5000 }); }
      rows = all.filter(c => ids.has(childParentId(c)));
    }

    // Agregavimas pagal tiekėjo įmonės kodą (dedubliavimas)
    const bySupplier = new Map();
    for (const c of rows) {
      const t = parseTenderer(c.selected_tenderer);
      if (!t || (!t.code && !t.name)) continue;
      const date = String(c.conclusion_date || '').slice(0, 10);
      if (from && date && date < from) continue;            // datos filtras pagal sutarties sudarymą
      const val = parseValue(c.total_value_of_part);
      const key = t.code || t.name.toLowerCase();
      let agg = bySupplier.get(key);
      if (!agg) { agg = { name: t.name || t.code, code: t.code, country: 'Lietuva', contractCount: 0, totalValue: 0, lastAward: '' }; bySupplier.set(key, agg); }
      agg.contractCount += 1;
      agg.totalValue += val;
      if (date > agg.lastAward) agg.lastAward = date;
      if ((!agg.name || agg.name === agg.code) && t.name) agg.name = t.name;
    }

    let suppliers = Array.from(bySupplier.values()).map(s => ({ ...s, totalValue: Math.round(s.totalValue) }));
    if (minValue) suppliers = suppliers.filter(s => !s.totalValue || s.totalValue >= minValue);
    suppliers.sort((a, b) => b.totalValue - a.totalValue);
    suppliers = suppliers.slice(0, limit);

    const payload = { meta: cvpisMeta(from, minValue, authCode, suppliers.length), suppliers };
    _cvpisCache.set(cacheKey, { at: Date.now(), data: payload });
    return res.json(payload);
  } catch (err) {
    console.error('cvpis-suppliers failure:', err.message);
    return res.status(502).json({ error: 'Nepavyko gauti CVP IS duomenų / Could not fetch CVP IS data.', detail: err.message });
  }
});
function cvpisMeta(from, minValue, authCode, count) {
  return { source: 'CVP IS / data.gov.lt', dataset: 'gov/vpt/new', authorityCode: authCode, from, minValue, fetchedAt: new Date().toISOString(), count };
}
module.exports = router;

/* ============================================================================
 * SAUGUMO KONTROLINIS SĄRAŠAS (prieš produkciją):
 *  [ ] ANTHROPIC_API_KEY tik .env, niekada repo/HTML.
 *  [ ] CORS allowlist: leisti tik savo modulių originus.
 *  [ ] Rate limiting įjungtas (express-rate-limit įdiegtas).
 *  [ ] Įvesties dydžio ribos (jau taikomos: name 200, context 2000).
 *  [ ] HTTPS (jau turima per Nginx + Let's Encrypt).
 *  [ ] Klaidų logai be jautrių vartotojo duomenų.
 *  [ ] (Vėliau) Autentifikacija/autorizacija prieš endpoint'us.
 *  [ ] CVP IS: patvirtinti tiekėjų lentelės laukų pavadinimus (FIELD_MAP) ir
 *      modelių kelius (DATAGOV) prie rinkinio 2867 struktūros; įvertinti cache TTL.
 * ==========================================================================*/
