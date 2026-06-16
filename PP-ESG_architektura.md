# PP-ESG — centrinis ESG ir atitikties variklis

Modulis G-Procure ekosistemai. Viena vieta, kurioje gyvena trys neišskaidomos funkcijos: **tiekėjų rizikos registras**, **sankcijų patikros istorija** ir **ESRS duomenų centras**. Kiti moduliai (PP-TS, PP-PROTOCOLS, PP-NEGOTIATION ir kt.) naudoja šiuos duomenis per API.

---

## 1. Architektūra trumpai

Trys skiltys + apžvalgos skydelis viename `index.html` puslapyje, sujungti per skirtukus (tabs). Visa logika sutvarkyta trimis sluoksniais, kad perėjimas nuo MVP prie tikros duomenų bazės būtų lengvas:

```
┌────────────────────────────────────────────────────────────┐
│  UI sluoksnis (render* funkcijos, modaliniai langai, grafikai)│
│      ↕  niekada netiesiogiai neliečia saugyklos             │
├────────────────────────────────────────────────────────────┤
│  Serviso sluoksnis  =  objektas `Store`                      │
│  getSuppliers() saveSupplier() getChecks() addCheck()        │
│  getEsrs() saveEsrs() ...  + RIZIKOS VARIKLIS computeRisk()  │
├────────────────────────────────────────────────────────────┤
│  Saugykla:  MVP → LocalStorage   |   vėliau → api.g-procure.com│
└────────────────────────────────────────────────────────────┘
```

**Migracija į DB** = pakeisti tik `Store` metodų kūnus `fetch()` kvietimais. UI nieko nežino apie LocalStorage — todėl perrašyti reikės vienos vietos.

Trys funkcijos sujungtos per **vieną tiesos versiją**: kiekvienas tiekėjas turi unikalų ID (`SUP-…`). Sankcijų patikros nukreiptos į tą patį ID; eskalavus patikrą, automatiškai keičiasi tiekėjo statusas registre. ESRS duomenų centras agreguoja tiekėjų požymius (elgesio kodeksas, MVĮ, tvarumo kriterijai) į CSRD rodiklius. Niekas nesidubliuoja.

### Vizualinė tapatybė
Šviesi EPSO-G brandbook kryptis: Smaragdas `#00A072`, Grafitas tekstas `#2E3641`, Nunito Sans, švarūs balti paviršiai, 8 px tarpų sistema. Tamsus žaliai-melsvas gradientas naudojamas tik antraštei ir AI blokams. Pilnas LT/EN perjungimas (žodynas `I18N`, funkcija `applyI18n()`).

---

## 2. Trys funkcijos

### Tiekėjų rizikos registras
Lentelė su filtrais (rizika, sankcijų statusas, šalis, kategorija, paieška, būsena), spalviniu kodavimu (žalia/gintaro/raudona) ir tiekėjo kortele (drawer). **Rizikos skaičiuoklė** (`computeRisk`) iš trijų įvesčių — šalies rizikos, sektoriaus rizikos ir kritiškumo tinklui — apskaičiuoja 0–100 įvertį ir siūlomą lygį; atsakingas asmuo gali jį perrašyti. Kritiškumas tinklui sveriamas labiausiai (0.4), nes tai TSO prioritetas.

#### Automatinis tiekėjų aptikimas iš CVP IS (importas)
Mygtukas „Importuoti iš CVP IS" atveria vediklį, kuris iš viešų Litgrid sudarytų sutarčių (data.gov.lt, rinkinys 2867) automatiškai aptinka tiekėjus. Filtrai: laikotarpis (12/24/36/60 mėn.), minimali sutarties vertė (reikšmingumas), perkantysis subjektas (numatyta Litgrid), priskiriama kategorija. Rezultatai **dedubliuojami pagal įmonės kodą** ir prieš importą sutikrinami su esamu registru (žymima „Nauja" / „Jau registre"). Backend agreguoja sutarčių skaičių, bendrą vertę ir paskutinės sutarties datą. Jei backend neprieinamas, vediklis rodo demonstracinius duomenis (aiškiai pažymėtus).

> **Svarbu (sąmoningas dizaino sprendimas):** importas yra TIK aptikimas ir registro užpildymas, ne stebėjimas. Importuoti tiekėjai gauna `source: "cvpis"`, `assessment: "pending"`, rizika `unassessed`, sankcijos `review` ir registre žymimi **„Reikia vertinimo"**. ESG rizika ir sankcijos NEatliekamos automatiškai — galutinį vertinimą atlieka atsakingas asmuo (rankiniu būdu įvertinus, „Reikia vertinimo" būsena nuimama).

#### Stebėjimas — periodinis pakartotinis tikrinimas (4 etapas)
Atskiras nuo importo. Rizika grįsta periodika (`RESCREEN_DAYS`): aukšta rizika kas 90 d., vidutinė kas 180 d., žema kas 365 d. Funkcija `dueForRescreen()` pažymi tiekėjus, kuriems patikra pavėluota (neįtraukia dar neįvertintų „pending" ir „blokuotų"). Apžvalgos skydelyje yra rodikliai („Reikia vertinimo", „Laukia patikros") ir **stebėjimo lentelė** su veiksmų mygtukais (Įvertinti / Patikra). Registre — filtrai „Reikia vertinimo" ir „Laukia pakartotinės patikros". Automatinius priminimus galima įjungti per asistentą (suplanuota užduotis) arba backend cron, kai bus įdiegta DB.

### Sankcijų patikros istorija
Audituojamas, **nekeičiamas (write-once)** žurnalas: data, kas tikrino, tikrinti sąrašai (ES/OFAC/JT/UK/nacionaliniai), rezultatas, pastabos. Įrašų negalima trinti ar redaguoti — tik pridėti naujus. **Eskalavimo taisyklė:** rezultatas „atitikmuo rastas" automatiškai pažymi įrašą raudonai ir pakeičia tiekėjo statusą į „blokuotas". **AI mygtukas** „Įvertinti sankcijų riziką" kreipiasi per backend proxy ir grąžina preliminarų vertinimą (rizikos lygis, veiksniai, tolesni veiksmai) — niekada galutinio verdikto.

### ESRS duomenų centras
Struktūrizuoti pirkimams aktualūs ESRS taškai: **E1** (Scope 3 emisijos iš perkamų prekių/paslaugų), **S2** (vertės grandinės darbuotojai), **G1** (verslo etika, mokėjimo praktikos). Kiekvienam taškui: pavadinimas, ESRS kodas, vertė, vienetas, šaltinis (modulis/rankinis), data, padengimo %. Suvestinės skydelis ir „ramsčių" kortelės. **Eksportas** JSON ir CSV formatu CSRD ataskaitai. **Proporcingumas:** MVĮ pažymimos `VSME` ženklu — iš jų prašoma tik VSME apimties duomenų (Omnibus value-chain cap principas).

---

## 3. API endpoint'ai

### PP-ESG atidengia kitiems moduliams (viena tiesos versija)

| Metodas | Kelias | Grąžina | Kas naudoja |
|---|---|---|---|
| `GET` | `/api/esg/supplier/:id/risk` | `{ id, esgRisk, riskScore }` | PP-TS, PP-NEGOTIATION (rizikos kontekstas vertinant pasiūlymus) |
| `GET` | `/api/esg/supplier/:id/sanctions-status` | `{ id, status, lastCheck }` | PP-PROTOCOLS, PP-TS (atitikties patikra prieš sutartį) |
| `GET` | `/api/esg/suppliers` *(siūloma)* | tiekėjų sąrašas su rizika/statusu | PP-PLANNING, PP-MARKET-KPI |
| `GET` | `/api/esg/esrs/export` *(siūloma)* | ESRS duomenų paketas | grupės CSRD ataskaitos rinkimas |

### PP-ESG vidiniai (backend proxy)

| Metodas | Kelias | Paskirtis |
|---|---|---|
| `POST` | `/api/esg/sanctions-assessment` | AI preliminarus sankcijų rizikos vertinimas per Claude API (raktas tik serveryje) |
| `GET` | `/api/esg/cvpis-suppliers` | Automatinis tiekėjų aptikimas iš data.gov.lt (rinkinys 2867): jungia sutarčių ir tiekėjų lenteles, filtruoja (from/minValue/buyer), dedubliuoja pagal kodą, agreguoja. Parametrai konfigūruojami `FIELD_MAP` / `DATAGOV`. |
| `POST` | `/api/esg/csrd-export` | (neprivaloma) serverio pusės CSRD eksporto apdorojimas / audito įrašas |

> **Diegimo pastaba (CVP IS):** data.gov.lt rinkinys 2867 turi dvi lenteles (sutartys ir tiekėjai/šalys), sujungtas per dokumento ID. Sutarčių laukai žinomi (`dok_*`), o tiekėjų lentelės laukai pervadinti — **tiksliuosius pavadinimus patvirtinkite prie rinkinio struktūros** ([data.gov.lt/datasets/2867](https://data.gov.lt/datasets/2867/)) ir, jei reikia, pakoreguokite `FIELD_MAP` bei `DATAGOV` modelių kelius `backend-pp-esg-routes.js`. Normalizatorius bando kelis galimus pavadinimus, todėl veikia lanksčiai.

Backend kodas — faile `backend-pp-esg-routes.js` su įterpimo instrukcija ir saugumo kontroliniu sąrašu (įvesties validacija, rate limiting, CORS allowlist).

---

## 4. AI valdikliai (atitikties svarba)

Sankcijų vertinimo prompt'as turi griežtas taisykles, įtvirtintas backend system prompt'e:
- aiškiai įvardyta, kad vertinimas **preliminarus ir negalutinis**;
- AI **niekada** nepateikia „švarus/blokuotas" verdikto — sprendžia atsakingas asmuo pagal oficialius sąrašus;
- AI neteigia, kad tiekėjas yra/nėra kuriame nors sąraše, tik nurodo tikrintinus rizikos požymius;
- atsakymas grąžinamas modulio kalba (LT arba EN), struktūrizuotas JSON.
UI papildomai rodo įspėjimą (disclaimer) prie kiekvieno AI bloko.

---

## 5. Tolesni žingsniai (po MVP)

1. **Duomenų bazė** — perkelti `Store` metodus į `api.g-procure.com` (PostgreSQL). Sankcijų žurnalui — append-only lentelė su DB lygmens apsauga nuo redagavimo.
2. **Realaus laiko sankcijų sąrašai** — integracija su oficialiais ES konsoliduotu, OFAC, JT sąrašais (pakeičia rankinį statusą realiu tikrinimu); AI lieka kaip preliminarus filtras.
3. **Vartotojų autentifikacija ir rolės** — kad audito žurnale „kas tikrino" būtų patikimas, ne rankinis įvestis.
4. **Modulių integracija** — PP-TS / PP-PROTOCOLS tikrina sankcijų statusą prieš sutarties sudarymą per atidengtus endpoint'us.
5. **Automatiniai duomenų srautai į ESRS** — emisijų ir tvarumo kriterijų duomenys automatiškai keliami iš PP-COST-BENEFIT ir PP-PROTOCOLS.
6. **XBRL / ESRS taksonomija** — CSRD eksportą papildyti mašininiu formatu grupės konsolidacijai.
7. **Pranešimai** — automatiniai priminimai, kai artėja pakartotinės patikros terminas (pvz. >90 d. nuo paskutinės).

---

## 6. Failai

| Failas | Turinys |
|---|---|
| `index.html` | Pilnas, savarankiškas frontend MVP (CSS + JS įdiegti viename faile). Veikia atidarius naršyklėje; demonstraciniai duomenys įkeliami automatiškai. Viršuje — informacinė (help) skiltis. |
| `components/gprocure-info-panel.js` | **Standartinis, perkeliamas** informacinės skilties komponentas visiems G-Procure moduliams (žr. žemiau). |
| `backend-pp-esg-routes.js` | Express maršrutų papildymai su įterpimo instrukcija ir saugumo gairėmis. |
| `PP-ESG_architektura.md` | Šis dokumentas. |

---

## 7. Dviejų lygių pagalbos sistema (bendras komponentas visiems moduliams)

Modulio viršuje yra savaime suprantama pagalbos sistema su **dviem lygiais**, įgyvendinta kaip vienas standartinis, perkeliamas komponentas (`components/gprocure-info-panel.js`). Į PP-ESG jis įdiegtas **inline viename `index.html`** (jokio antro failo), tačiau identiškas šaltinio failas tinka bet kuriam moduliui. Komponentas pats įsideda savo CSS, naudodamas bendrus G-Procure spalvų/tarpų kintamuosius, todėl atrodo kaip natūrali modulio dalis.

**1 lygis — trumpas sutraukiamas blokas.** „Kas tai ir kaip naudotis": paskirtis, naudojimo žingsniai, pastaba apie duomenis ir taisykles (PSĮ, CSRD/ESRS, AI ribas). Sutraukiamas, pagal nutylėjimą atidarytas; būsena išsaugoma naršyklėje atskirai kiekvienam moduliui. Greta „Suskleisti" yra mygtukas **„Plačiau"**.

**2 lygis — detali instrukcija modaliniame lange.** Paspaudus „Plačiau" atsidaro modalinis langas (tame pačiame faile) su tamsia navy „hero" antrašte ir šviesiu turiniu: išsamus paskirties paaiškinimas su CSRD/CSDDD kontekstu, **vizuali proceso schema** (grafiniai numeruoti žingsniai su jungtimis), **pagrindinių sąvokų** kortelės su pavyzdžiais (ESRS E1/S2/G1, CSDDD, sankcijų sąrašai, VSME) ir **DUK** (išskleidžiami). Elgsena: pagal nutylėjimą uždarytas; uždaromas „X", klavišu **Esc** ir paspaudus už lango ribų; atidarius **užrakinamas fono slinkimas**. Prieinamumas: atidarius dėmesys (focus) perkeliamas į langą, Tab cikluoja tik lango viduje (focus trap), uždarius focus grįžta į „Plačiau" mygtuką.

**Perkėlimas į kitą modulį (keičiamas tik tekstas ir schemos žingsniai):**

```html
<div id="infoPanelMount"></div>
<script src="components/gprocure-info-panel.js"></script>
<script>
  GProcureInfoPanel.mount({
    target: "#infoPanelMount",
    moduleId: "pp-ts",                 // unikalus ID -> atskiras įsiminimas
    defaultOpen: true,
    getLang: () => LANG,               // funkcija, grąžinanti 'lt'|'en'
    content: {
      lt: {
        title, purpose, stepsTitle, steps:[...], noteTitle, note,   // 1 lygis
        moreLabel: "Plačiau",
        details: {                                                   // 2 lygis (nebūtina)
          title, intro,
          processTitle, process:[{title,text}, ...],                 // vizuali schema
          conceptsTitle, concepts:[{code,term,def,example}, ...],
          faqTitle, faq:[{q,a}, ...],
          closeLabel
        }
      },
      en: { ... }
    }
  });
  // perjungus kalbą modulyje:  GProcureInfoPanel.refresh();
</script>
```

Jei `details` nėra, mygtukas „Plačiau" tiesiog nerodomas — komponentas veikia kaip vieno lygio. Įsiminimo raktas: `localStorage["gprocure.infoPanel.<moduleId>"]` (`"open"`/`"closed"`).

> **Demonstraciniai duomenys:** pirmą kartą atidarius, įkeliami 8 pavyzdiniai tiekėjai, 5 patikros ir 7 ESRS taškai, kad sąsają galima būtų iškart išbandyti. Norint pradėti nuo tuščio registro — naršyklės konsolėje: `localStorage.clear()` ir perkrauti.
