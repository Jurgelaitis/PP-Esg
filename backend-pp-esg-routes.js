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
 * 4) GET /api/esg/cvpis-suppliers
 *    Automatinis tiekėjų APTIKIMAS iš viešų CVP IS / data.gov.lt sutarčių.
 *    Grąžina dedubliuotą (pagal įmonės kodą) tiekėjų sąrašą su agregatais
 *    (sutarčių sk., bendra vertė, paskutinės sutarties data), kad PP-ESG
 *    galėtų užpildyti registrą. SVARBU: tai TIK aptikimas/užpildymas — rizika
 *    ir sankcijos NEatliekamos (importuoti tiekėjai žymimi „reikia vertinimo").
 *
 *    Užklausos parametrai:
 *      from     = YYYY-MM-DD  (nuo kurios sutarties sudarymo datos; numatyta -36 mėn.)
 *      minValue = skaičius    (minimali sutarties vertė EUR; „reikšmingumo" filtras)
 *      buyer    = tekstas      (perkančiojo subjekto kodas/pavadinimas; numatyta Litgrid)
 *      limit    = 1..1000
 *
 *    PASTABA DĖL LAUKŲ: data.gov.lt rinkinys 2867 turi DVI lenteles (sutartys ir
 *    šalys/tiekėjai), sujungtas per dokumento ID. Sutarčių laukų pavadinimai žinomi
 *    (dok_*), o tiekėjų lentelės laukai pervadinti. TIKSLIUS tiekėjų lentelės laukų
 *    pavadinimus PATVIRTINKITE prie rinkinio struktūros (data.gov.lt/datasets/2867)
 *    ir, jei reikia, pakoreguokite FIELD_MAP žemiau. Normalizatorius bando kelis
 *    galimus pavadinimus, kad veiktų lanksčiai.
 * ==========================================================================*/

/* ---- Konfigūracija (pritaikykite pagal savo backend ir rinkinio struktūrą) ---- */
const DATAGOV = {
  base: process.env.DATAGOV_BASE || 'https://get.data.gov.lt',
  // Modelių keliai get.data.gov.lt API (PATVIRTINKITE prie rinkinio 2867 struktūros):
  contractsModel: process.env.DATAGOV_CONTRACTS_MODEL || '/datasets/gov/vpt/pirkimai/Sutartis',
  partiesModel:   process.env.DATAGOV_PARTIES_MODEL   || '/datasets/gov/vpt/pirkimai/Salis',
  // Numatytasis perkantysis subjektas (Litgrid AB įmonės kodas):
  defaultBuyer:   process.env.ESG_DEFAULT_BUYER || '302564383',
};
// Galimi laukų pavadinimai (normalizatorius paima pirmą rastą):
const FIELD_MAP = {
  docId:        ['dok_id', 'dokumento_id', 'dok_pirkimo_numeris', 'pirkimo_numeris'],
  contractName: ['dok_sut_obj_pav', 'objekto_pavadinimas', 'pavadinimas'],
  value:        ['dok_sut_verte', 'verte', 'sutarties_verte'],
  awardDate:    ['dok_sudarymo_data', 'sudarymo_data', 'data'],
  procNumber:   ['dok_pirkimo_numeris', 'pirkimo_numeris'],
  buyerName:    ['perkancioji_organizacija', 'perkantysis', 'pirkejas', 'uzsakovas'],
  buyerCode:    ['perkanciosios_kodas', 'pirkejo_kodas', 'uzsakovo_kodas'],
  // tiekėjų (šalių) lentelė:
  supplierName: ['tiekejo_pavadinimas', 'tiekejas', 'salies_pavadinimas', 'pavadinimas'],
  supplierCode: ['tiekejo_kodas', 'imones_kodas', 'salies_kodas', 'kodas'],
  supplierCountry: ['salis', 'valstybe', 'tiekejo_salis'],
  role:         ['vaidmuo', 'salies_tipas', 'tipas'], // norim role == "tiekėjas"/"laimėtojas"
};
function pick(obj, names, fallback) {
  for (const n of names) { if (obj && obj[n] != null && obj[n] !== '') return obj[n]; }
  return fallback;
}

const cvpisLimiter = rateLimit
  ? rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false })
  : (req, res, next) => next();

// Paprastas in-memory cache (TTL), kad nedubliuotume užklausų į data.gov.lt
const _cvpisCache = new Map(); // key -> { at, data }
const CVPIS_TTL_MS = 10 * 60 * 1000;

async function fetchDatagov(modelPath, query) {
  const url = new URL(DATAGOV.base + modelPath);
  Object.entries(query || {}).forEach(([k, v]) => { if (v != null) url.searchParams.set(k, v); });
  url.searchParams.set('format', 'json');
  const r = await fetch(url.toString(), { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('data.gov.lt HTTP ' + r.status);
  const j = await r.json();
  // get.data.gov.lt grąžina { _data: [...] } arba tiesiog masyvą — palaikom abu
  return Array.isArray(j) ? j : (j._data || j.data || []);
}

router.get('/cvpis-suppliers', cvpisLimiter, async (req, res) => {
  // ---- įvesties validacija ----
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 300, 1), 1000);
  const minValue = req.query.minValue != null ? Math.max(parseFloat(req.query.minValue) || 0, 0) : 0;
  const buyer = clampStr(req.query.buyer, 120) || DATAGOV.defaultBuyer;
  let from = clampStr(req.query.from, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    const d = new Date(); d.setMonth(d.getMonth() - 36); from = d.toISOString().slice(0, 10);
  }

  const cacheKey = JSON.stringify({ from, minValue, buyer, limit });
  const cached = _cvpisCache.get(cacheKey);
  if (cached && (Date.now() - cached.at) < CVPIS_TTL_MS) return res.json(cached.data);

  try {
    // 1) Gauti sutartis pagal perkantįjį ir datą (filtravimas serverio pusėje, kiek leidžia API).
    //    Pastaba: get.data.gov.lt palaiko filtrus per query (pvz. ?dok_sudarymo_data>='from').
    //    Čia darom paprastą gavimą ir filtruojam JS pusėje dėl laukų pavadinimų lankstumo.
    const contracts = await fetchDatagov(DATAGOV.contractsModel, { limit });
    const parties = await fetchDatagov(DATAGOV.partiesModel, { limit: limit * 3 });

    // 2) Indeksuoti šalis pagal dokumento ID
    const partiesByDoc = new Map();
    for (const p of parties) {
      const docId = pick(p, FIELD_MAP.docId);
      if (docId == null) continue;
      if (!partiesByDoc.has(docId)) partiesByDoc.set(docId, []);
      partiesByDoc.get(docId).push(p);
    }

    // 3) Sujungti, filtruoti, agreguoti pagal įmonės kodą
    const bySupplier = new Map();
    for (const c of contracts) {
      const docId = pick(c, FIELD_MAP.docId);
      const value = parseFloat(String(pick(c, FIELD_MAP.value, '0')).replace(/[^\d.,-]/g, '').replace(',', '.')) || 0;
      const award = String(pick(c, FIELD_MAP.awardDate, '') || '').slice(0, 10);
      const bName = String(pick(c, FIELD_MAP.buyerName, '') || '');
      const bCode = String(pick(c, FIELD_MAP.buyerCode, '') || '');

      // filtrai
      if (minValue && value < minValue) continue;
      if (award && from && award < from) continue;
      if (buyer && !(bName.toLowerCase().includes(buyer.toLowerCase()) || bCode === buyer)) continue;

      const docParties = partiesByDoc.get(docId) || [];
      const suppliers = docParties.filter(p => {
        const role = String(pick(p, FIELD_MAP.role, '') || '').toLowerCase();
        // jei role laukas yra — imam tik tiekėjus/laimėtojus; jei nėra — imam visus
        return !role || /tiek|laim|winner|suppl/.test(role);
      });
      for (const p of suppliers) {
        const code = String(pick(p, FIELD_MAP.supplierCode, '') || '').trim();
        const name = String(pick(p, FIELD_MAP.supplierName, '') || '').trim();
        if (!name && !code) continue;
        const key = code || name.toLowerCase(); // dedupe pagal kodą (atsarginis — pagal pavadinimą)
        const country = String(pick(p, FIELD_MAP.supplierCountry, 'Lietuva') || 'Lietuva');
        let agg = bySupplier.get(key);
        if (!agg) { agg = { name, code, country, contractCount: 0, totalValue: 0, lastAward: '', procNumbers: [] }; bySupplier.set(key, agg); }
        agg.contractCount += 1;
        agg.totalValue += value;
        if (award > agg.lastAward) agg.lastAward = award;
        const proc = String(pick(c, FIELD_MAP.procNumber, '') || '');
        if (proc && agg.procNumbers.length < 5 && !agg.procNumbers.includes(proc)) agg.procNumbers.push(proc);
        if (!agg.name && name) agg.name = name;
      }
    }

    const suppliers = Array.from(bySupplier.values())
      .map(s => ({ ...s, totalValue: Math.round(s.totalValue) }))
      .sort((a, b) => b.totalValue - a.totalValue);

    const payload = {
      meta: { source: 'CVP IS / data.gov.lt', dataset: '2867', from, minValue, buyer, fetchedAt: new Date().toISOString(), count: suppliers.length },
      suppliers,
    };
    _cvpisCache.set(cacheKey, { at: Date.now(), data: payload });
    return res.json(payload);
  } catch (err) {
    console.error('cvpis-suppliers failure:', err.message);
    return res.status(502).json({ error: 'Nepavyko gauti CVP IS duomenų / Could not fetch CVP IS data.', detail: err.message });
  }
});

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
