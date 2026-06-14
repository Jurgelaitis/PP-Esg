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
 * ==========================================================================*/
