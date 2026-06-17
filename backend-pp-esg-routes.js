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
 *    PATAISYTA pagal realią VPT rinkinio struktūrą ir Spinta sintaksę
 *    (testavimas: Arūnas, 2026-06). Esminiai pataisymai:
 *      - teisingas kelias:  gov/vpt/new  (ne org/vpt/cvpp -> davė 404);
 *      - Spinta sintaksė su skliausteliais: limit(N), sort(_id), filtras field="val"
 *        (NE ?limit=10, kurio Spinta nesupranta);
 *      - duomenys NORMALIZUOTI per kelias lenteles -> reikia dviejų žingsnių sujungimo:
 *          Atn1                        – ataskaitos antraštė (perkančioji organizacija, data)
 *          Atn1ContractList            – sutartys su vertėmis (IX. SUTARTYS)
 *          Atn1ContractedCandidateList – LAIMĖJĘ tiekėjai (pavadinimas + įmonės kodas)
 *        Sujungimas: Atn1._id  <-  child.<parentRef>._id
 *      - Litgrid filtruojamas pagal JURIDINIO ASMENS KODĄ 302564383 (ne pavadinimą,
 *        nes pavadinimai rašomi nevienodai: "Litgrid AB" / "LITGRID AB" / "AB LITGRID").
 *    AI NENAUDOJAMAS — tai gryni vieši duomenys; Claude lieka tik ESG/sankcijų vertinimui.
 *
 *    PATVIRTINKITE LAUKŲ PAVADINIMUS perskaitę gyvą įrašą (lentelių aprašymai tušti):
 *      https://get.data.gov.lt/datasets/gov/vpt/new/Atn1?limit(3)
 *      https://get.data.gov.lt/datasets/gov/vpt/new/Atn1ContractList?limit(3)
 *      https://get.data.gov.lt/datasets/gov/vpt/new/Atn1ContractedCandidateList?limit(3)
 *    ir, jei reikia, pakoreguokite žemiau esantį F (laukų kandidatų) žemėlapį.
 *    Normalizatorius bando kelis galimus pavadinimus, todėl veikia lanksčiai.
 *
 *    Užklausos parametrai:
 *      from     = YYYY-MM-DD  (nuo ataskaitos/sutarties datos; numatyta -36 mėn.)
 *      minValue = skaičius    (minimali sutarties vertė EUR; „reikšmingumo" filtras)
 *      buyer    = kodas        (perkančiojo subjekto kodas; numatyta Litgrid 302564383)
 *      limit    = 1..1000      (grąžinamų tiekėjų riba po agregavimo)
 * ==========================================================================*/

const DATAGOV = {
  base: process.env.DATAGOV_BASE || 'https://get.data.gov.lt/datasets/gov/vpt/new',
  litgridCode: process.env.ESG_LITGRID_CODE || '302564383',
};

// Laukų KANDIDATAI (patvirtinkite perskaitę gyvą įrašą; normalizatorius ima pirmą rastą).
const F = {
  // Atn1 (ataskaitos antraštė)
  authorityCode: ['perkanciosios_organizacijos_kodas', 'perkanciosios_kodas', 'pirkejo_kodas', 'organizacijos_kodas', 'authority_code'],
  authorityName: ['perkancioji_organizacija', 'perkancioji', 'organizacija', 'pavadinimas'],
  reportDate:    ['ataskaitos_data', 'paskelbimo_data', 'data', 'sudarymo_data'],
  // child -> tėvinio Atn1 nuoroda (Spinta: { atn1: { _id } })
  parentRef:     ['atn1', 'atn_1', 'parent'],
  parentRefFlat: ['atn1._id', 'parent_id', 'atn1_id'],
  // Atn1ContractList (sutartys su vertėmis)
  contractValue: ['sutarties_verte', 'verte', 'kaina', 'value'],
  contractDate:  ['sutarties_data', 'sudarymo_data', 'data'],
  contractNo:    ['sutarties_nr', 'sutarties_numeris', 'numeris', 'eil_nr'],
  // Atn1ContractedCandidateList (laimėję tiekėjai)
  supplierName:  ['tiekejo_pavadinimas', 'pavadinimas', 'tiekejas', 'candidate_name'],
  supplierCode:  ['tiekejo_kodas', 'imones_kodas', 'kodas', 'candidate_code'],
  supplierCountry: ['salis', 'valstybe', 'tiekejo_salis'],
  candContractNo: ['sutarties_nr', 'sutarties_numeris', 'numeris', 'eil_nr'],
};
function pick(o, names, fb) { for (const n of names) { if (o && o[n] != null && o[n] !== '') return o[n]; } return fb; }
function parseValue(v) { return parseFloat(String(v == null ? '0' : v).replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.')) || 0; }

const cvpisLimiter = rateLimit
  ? rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false })
  : (req, res, next) => next();

const _cvpisCache = new Map();
const CVPIS_TTL_MS = 30 * 60 * 1000;

/* ---- Spinta užklausos pagalbininkai (skliaustelių sintaksė!) ---- */
function spintaUrl(model, conditions, extra) {
  const parts = ['format(json)'].concat(conditions || [], extra || []);
  return DATAGOV.base + '/' + model + '?' + parts.join('&');
}
async function spinta(model, conditions, extra) {
  const r = await fetch(spintaUrl(model, conditions, extra), { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(model + ' HTTP ' + r.status);
  const j = await r.json();
  return Array.isArray(j) ? j : (j._data || j.data || []);
}
// Puslapiavimas per _id kursorių (Spinta neturi offset; naudojam sort(_id)+_id>"...")
async function spintaAll(model, conditions, cap) {
  cap = cap || 5000; const out = []; let last = null; const page = 1000;
  while (out.length < cap) {
    const cond = (conditions || []).slice(); if (last) cond.push('_id>"' + last + '"');
    let rows;
    try { rows = await spinta(model, cond, ['sort(_id)', 'limit(' + page + ')']); }
    catch (e) { if (out.length) break; throw e; }
    if (!rows.length) break;
    out.push(...rows); last = rows[rows.length - 1]._id;
    if (rows.length < page) break;
  }
  return out;
}
function childParentId(row) {
  const ref = pick(row, F.parentRef);
  if (ref && (ref._id || ref.id)) return ref._id || ref.id;
  return pick(row, F.parentRefFlat);
}

router.get('/cvpis-suppliers', cvpisLimiter, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 300, 1), 1000);
  const minValue = req.query.minValue != null ? Math.max(parseFloat(req.query.minValue) || 0, 0) : 0;
  let from = clampStr(req.query.from, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) { const d = new Date(); d.setMonth(d.getMonth() - 36); from = d.toISOString().slice(0, 10); }
  // Litgrid filtruojam pagal KODĄ (jei atėjo pavadinimas „Litgrid", naudojam numatytą kodą):
  const raw = clampStr(req.query.buyer, 60);
  const authCode = /^\d{6,12}$/.test(raw) ? raw : DATAGOV.litgridCode;

  const cacheKey = JSON.stringify({ from, minValue, authCode, limit });
  const cached = _cvpisCache.get(cacheKey);
  if (cached && (Date.now() - cached.at) < CVPIS_TTL_MS) return res.json(cached.data);

  try {
    // ŽINGSNIS 1: Atn1 antraštės pagal perkančiosios kodą (serverio pusėje, jei laukas teisingas;
    // jei nepavyksta — paimam ir filtruojam JS pusėje pagal kandidatų laukus).
    let reports;
    try { reports = await spintaAll('Atn1', [F.authorityCode[0] + '="' + authCode + '"'], 4000); }
    catch (e) { reports = await spintaAll('Atn1', [], 6000); }

    const reportDate = new Map();   // reportId -> data
    const reportIds = new Set();
    for (const a of reports) {
      const code = String(pick(a, F.authorityCode, '') || '');
      const date = String(pick(a, F.reportDate, '') || '').slice(0, 10);
      if (authCode && code && code !== authCode) continue;     // JS atsarginis filtras pagal kodą
      if (from && date && date < from) continue;               // datos filtras
      reportIds.add(a._id); reportDate.set(a._id, date);
    }
    if (!reportIds.size) {
      const empty = { meta: cvpisMeta(from, minValue, authCode, 0), suppliers: [] };
      _cvpisCache.set(cacheKey, { at: Date.now(), data: empty }); return res.json(empty);
    }

    // ŽINGSNIS 2: sutartys (vertės) ir laimėtojai (tiekėjai), priklausantys tiems Atn1.
    const contracts = await spintaAll('Atn1ContractList', [], 12000);
    const winners   = await spintaAll('Atn1ContractedCandidateList', [], 12000);

    // Vertės pagal (reportId | sutarties_nr)
    const valueByKey = new Map();
    for (const c of contracts) {
      const rid = childParentId(c); if (!reportIds.has(rid)) continue;
      const no = String(pick(c, F.contractNo, '') || '');
      const v = parseValue(pick(c, F.contractValue, '0'));
      valueByKey.set(rid + '|' + no, (valueByKey.get(rid + '|' + no) || 0) + v);
    }

    // Agregavimas pagal tiekėjo įmonės kodą (dedubliavimas)
    const bySupplier = new Map();
    for (const w of winners) {
      const rid = childParentId(w); if (!reportIds.has(rid)) continue;
      const name = String(pick(w, F.supplierName, '') || '').trim();
      const code = String(pick(w, F.supplierCode, '') || '').trim();
      if (!name && !code) continue;
      const no = String(pick(w, F.candContractNo, '') || '');
      const val = valueByKey.get(rid + '|' + no) || 0;
      const award = reportDate.get(rid) || '';
      const key = code || name.toLowerCase();
      let agg = bySupplier.get(key);
      if (!agg) { agg = { name, code, country: String(pick(w, F.supplierCountry, 'Lietuva') || 'Lietuva'), contractCount: 0, totalValue: 0, lastAward: '' }; bySupplier.set(key, agg); }
      agg.contractCount += 1; agg.totalValue += val;
      if (award > agg.lastAward) agg.lastAward = award;
      if (!agg.name && name) agg.name = name;
    }

    // „Reikšmingumo" filtras pagal bendrą vertę (taikomas tik kai vertė žinoma > 0)
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
