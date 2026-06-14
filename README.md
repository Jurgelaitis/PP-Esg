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
Lentelė su filtrais (rizika, sankcijų statusas, šalis, kategorija, paieška), spalviniu kodavimu (žalia/gintaro/raudona) ir tiekėjo kortele (drawer). **Rizikos skaičiuoklė** (`computeRisk`) iš trijų įvesčių — šalies rizikos, sektoriaus rizikos ir kritiškumo tinklui — apskaičiuoja 0–100 įvertį ir siūlomą lygį; atsakingas asmuo gali jį perrašyti. Kritiškumas tinklui sveriamas labiausiai (0.4), nes tai TSO prioritetas.

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
| `POST` | `/api/esg/csrd-export` | (neprivaloma) serverio pusės CSRD eksporto apdorojimas / audito įrašas |

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
| `index.html` | Pilnas, savarankiškas frontend MVP (CSS + JS įdiegti viename faile). Veikia atidarius naršyklėje; demonstraciniai duomenys įkeliami automatiškai. |
| `backend-pp-esg-routes.js` | Express maršrutų papildymai su įterpimo instrukcija ir saugumo gairėmis. |
| `PP-ESG_architektura.md` | Šis dokumentas. |

> **Demonstraciniai duomenys:** pirmą kartą atidarius, įkeliami 8 pavyzdiniai tiekėjai, 5 patikros ir 7 ESRS taškai, kad sąsają galima būtų iškart išbandyti. Norint pradėti nuo tuščio registro — naršyklės konsolėje: `localStorage.clear()` ir perkrauti.
