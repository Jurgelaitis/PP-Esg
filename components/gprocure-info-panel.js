/* ============================================================================
 * G-Procure · Bendras DVIEJŲ LYGIŲ pagalbos komponentas (Info Panel + Details)
 * ----------------------------------------------------------------------------
 * STANDARTINIS, PERKELIAMAS komponentas visiems G-Procure moduliams.
 *
 *  1 lygis — trumpas sutraukiamas blokas modulio viršuje
 *            ("Kas tai ir kaip naudotis"): paskirtis, žingsniai, pastaba.
 *            Būsena (atidaryta/suskleista) išsaugoma naršyklėje.
 *  2 lygis — detali instrukcija MODALINIAME lange (tame pačiame faile):
 *            išsamus paaiškinimas su kontekstu (CSRD/CSDDD), vizuali proceso
 *            schema, sąvokų paaiškinimai su pavyzdžiais ir DUK.
 *
 * Perkėlimas į kitą modulį = keičiamas TIK tekstinis turinys (content) ir
 * schemos žingsniai. Struktūra, stilius, elgsena ir prieinamumas vienodi.
 *
 * Naudojimas:
 * --------------------------------------------------------------------------
 *   <div id="infoPanelMount"></div>
 *
 *   GProcureInfoPanel.mount({
 *     target: '#infoPanelMount',
 *     moduleId: 'pp-esg',            // unikalus -> atskiras būsenos įsiminimas
 *     getLang: () => currentLang,    // funkcija -> 'lt' | 'en'
 *     defaultOpen: true,
 *     content: {
 *       lt: {
 *         title, purpose, stepsTitle, steps:[...], noteTitle, note,
 *         moreLabel,                 // "Plačiau" (nebūtina)
 *         details: {                 // 2 lygis (nebūtina; nėra -> nerodomas "Plačiau")
 *           title, intro,
 *           processTitle, process:[{title,text}],
 *           conceptsTitle, concepts:[{term,def,example}],
 *           faqTitle, faq:[{q,a}],
 *           closeLabel
 *         }
 *       },
 *       en: { ... }
 *     }
 *   });
 *
 *   GProcureInfoPanel.refresh();     // perjungus kalbą
 *
 * Naudoja bendrus G-Procure CSS kintamuosius -> automatiškai dera prie modulio.
 * ==========================================================================*/
(function (global) {
  "use strict";

  var STYLE_ID = "gpi-styles";
  var LS_PREFIX = "gprocure.infoPanel.";
  var current = null;        // paskutinė konfigūracija (refresh)
  var modalEl = null;        // modalinio lango DOM (kuriamas vieną kartą)
  var lastFocus = null;      // elementas, į kurį grąžinamas focus uždarius
  var keyHandler = null;

  var UI = {
    lt: { collapse: "Suskleisti", expand: "Išskleisti", more: "Plačiau", close: "Uždaryti", aria: "Informacinė skiltis", dialog: "Detali instrukcija" },
    en: { collapse: "Collapse", expand: "Expand", more: "Learn more", close: "Close", aria: "Information panel", dialog: "Detailed guide" }
  };

  /* ---------------------------------------------------------------- *
   *  CSS (savaiminis įdėjimas; naudoja bendrus modulio kintamuosius)
   * ---------------------------------------------------------------- */
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      /* --- 1 lygis: trumpas blokas --- */
      ".gpi{background:var(--color-white,#fff);border:1px solid var(--color-graphite-15,#E1E2E4);border-left:4px solid var(--color-emerald,#00A072);border-radius:var(--radius-md,12px);box-shadow:var(--shadow-card,0 1px 2px rgba(46,54,65,.04));margin-bottom:var(--space-3,24px);overflow:hidden}",
      ".gpi-head{display:flex;align-items:center;gap:var(--space-1,8px);padding:14px var(--space-3,24px);cursor:pointer;user-select:none}",
      ".gpi-ic{width:34px;height:34px;border-radius:9px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:var(--color-green-5,#EFF9F1);color:var(--color-emerald,#00A072)}",
      ".gpi-ic svg{width:19px;height:19px}",
      ".gpi-titles{flex:1;min-width:0}",
      ".gpi-title{font-size:16px;font-weight:800;color:var(--color-graphite,#2E3641);font-family:var(--font-base,'Nunito Sans',Arial,sans-serif)}",
      ".gpi-purpose{font-size:13px;color:var(--color-graphite-50,#737483);margin-top:1px;line-height:1.45}",
      ".gpi-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}",
      ".gpi-btn{display:inline-flex;align-items:center;gap:6px;background:transparent;border:1px solid var(--color-graphite-30,#C7CDD3);color:var(--color-graphite-50,#737483);font-family:inherit;font-size:13px;font-weight:700;padding:6px 12px;border-radius:999px;cursor:pointer;transition:all 180ms ease}",
      ".gpi-btn:hover{border-color:var(--color-emerald,#00A072);color:var(--color-emerald,#00A072)}",
      ".gpi-btn.gpi-more{background:var(--color-emerald,#00A072);border-color:var(--color-emerald,#00A072);color:#fff}",
      ".gpi-btn.gpi-more:hover{background:var(--color-emerald-120,#128A76);border-color:var(--color-emerald-120,#128A76);color:#fff}",
      ".gpi-btn:focus-visible,.gpi-x:focus-visible,.gpi-faq summary:focus-visible{outline:2px solid var(--color-emerald,#00A072);outline-offset:2px}",
      ".gpi-chev{width:15px;height:15px;transition:transform 200ms ease}",
      ".gpi.collapsed .gpi-chev{transform:rotate(-90deg)}",
      ".gpi-body{max-height:1400px;overflow:hidden;transition:max-height 260ms ease,opacity 200ms ease,padding 200ms ease;opacity:1}",
      ".gpi.collapsed .gpi-body{max-height:0;opacity:0;padding-top:0;padding-bottom:0}",
      ".gpi-inner{padding:0 var(--space-3,24px) var(--space-3,24px) calc(var(--space-3,24px) + 34px + var(--space-1,8px))}",
      ".gpi-steps-title{font-size:12px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--color-graphite-50,#737483);margin:4px 0 10px}",
      ".gpi-steps{display:grid;gap:10px;margin:0 0 var(--space-2,16px)}",
      "@media(min-width:760px){.gpi-steps{grid-template-columns:1fr 1fr}}",
      ".gpi-step{display:flex;gap:10px;align-items:flex-start}",
      ".gpi-num{width:24px;height:24px;border-radius:50%;flex-shrink:0;background:var(--color-emerald,#00A072);color:#fff;font-size:12px;font-weight:800;display:flex;align-items:center;justify-content:center;margin-top:1px}",
      ".gpi-step-tx{font-size:13.5px;color:var(--color-graphite,#2E3641);line-height:1.45}",
      ".gpi-step-tx b{font-weight:800}",
      ".gpi-note{display:flex;gap:10px;background:var(--color-cyan-5,#E8F7F9);border:1px solid var(--color-graphite-15,#E1E2E4);border-radius:var(--radius-sm,8px);padding:12px 14px;font-size:12.5px;color:var(--color-graphite,#2E3641);line-height:1.5}",
      ".gpi-note svg{width:18px;height:18px;flex-shrink:0;color:var(--color-blue,#00667D);margin-top:1px}",
      ".gpi-note-title{font-weight:800;display:block;margin-bottom:2px}",
      /* --- 2 lygis: modalinis langas --- */
      ".gpi-overlay{position:fixed;inset:0;z-index:1000;display:none;align-items:flex-start;justify-content:center;padding:var(--space-3,24px);background:rgba(11,18,32,.55);backdrop-filter:blur(3px);overflow-y:auto}",
      ".gpi-overlay.open{display:flex}",
      ".gpi-modal{background:var(--color-white,#fff);width:100%;max-width:880px;border-radius:var(--radius-lg,16px);box-shadow:0 24px 60px rgba(11,18,32,.35);margin:auto;overflow:hidden;animation:gpiPop .22s ease;font-family:var(--font-base,'Nunito Sans',Arial,sans-serif)}",
      "@keyframes gpiPop{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}",
      ".gpi-hero{position:relative;background:linear-gradient(120deg,#0B3B33 0%,#0E5247 45%,#00667D 100%);color:#fff;padding:var(--space-4,32px) var(--space-4,32px) var(--space-3,24px)}",
      ".gpi-hero-tag{display:inline-flex;align-items:center;gap:7px;font-size:11px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--color-emerald-50,#16C492)}",
      ".gpi-hero-tag svg{width:15px;height:15px}",
      ".gpi-hero h2{font-size:24px;font-weight:800;margin:8px 0 0;line-height:1.2}",
      ".gpi-hero-intro{font-size:14px;line-height:1.6;color:rgba(255,255,255,.88);margin-top:12px;max-width:62ch}",
      ".gpi-x{position:absolute;top:18px;right:18px;width:38px;height:38px;border-radius:10px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.12);color:#fff;border:none;cursor:pointer;transition:background 180ms ease}",
      ".gpi-x:hover{background:rgba(255,255,255,.24)}",
      ".gpi-x svg{width:18px;height:18px}",
      ".gpi-mbody{padding:var(--space-4,32px);max-height:calc(90vh - 220px);overflow-y:auto}",
      ".gpi-sec{margin-bottom:var(--space-4,32px)}",
      ".gpi-sec:last-child{margin-bottom:0}",
      ".gpi-h3{font-size:13px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--color-emerald,#00A072);margin:0 0 16px;display:flex;align-items:center;gap:8px}",
      ".gpi-h3 svg{width:17px;height:17px}",
      /* proceso schema */
      ".gpi-flow{display:flex;gap:0;flex-wrap:wrap}",
      ".gpi-flow-step{flex:1;min-width:150px;position:relative;padding:0 10px;text-align:center}",
      ".gpi-flow-step:not(:last-child)::after{content:'';position:absolute;top:22px;right:-12px;width:24px;height:2px;background:var(--color-graphite-30,#C7CDD3)}",
      "@media(max-width:680px){.gpi-flow{flex-direction:column;gap:4px}.gpi-flow-step{display:flex;text-align:left;gap:12px;padding:8px 0;min-width:0}.gpi-flow-step:not(:last-child)::after{display:none}}",
      ".gpi-flow-node{width:46px;height:46px;border-radius:50%;margin:0 auto 10px;background:var(--color-green-5,#EFF9F1);border:2px solid var(--color-emerald,#00A072);color:var(--color-emerald,#00A072);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;flex-shrink:0}",
      "@media(max-width:680px){.gpi-flow-node{margin:0}}",
      ".gpi-flow-title{font-size:13.5px;font-weight:800;color:var(--color-graphite,#2E3641)}",
      ".gpi-flow-text{font-size:12px;color:var(--color-graphite-50,#737483);margin-top:3px;line-height:1.4}",
      /* sąvokos */
      ".gpi-concepts{display:grid;gap:12px}",
      "@media(min-width:680px){.gpi-concepts{grid-template-columns:1fr 1fr}}",
      ".gpi-concept{border:1px solid var(--color-graphite-15,#E1E2E4);border-radius:var(--radius-md,12px);padding:14px 16px;background:var(--color-graphite-5,#EFF1F1)}",
      ".gpi-term{font-size:14px;font-weight:800;color:var(--color-graphite,#2E3641);display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".gpi-term .gpi-code{font-size:11px;font-weight:800;background:var(--color-green-15,#D7EEDB);color:var(--color-green,#459D54);padding:2px 8px;border-radius:6px}",
      ".gpi-def{font-size:12.5px;color:var(--color-graphite,#2E3641);margin-top:6px;line-height:1.5}",
      ".gpi-ex{font-size:12px;color:var(--color-graphite-50,#737483);margin-top:6px;line-height:1.5;border-left:2px solid var(--color-emerald-50,#16C492);padding-left:10px}",
      ".gpi-ex b{color:var(--color-graphite,#2E3641)}",
      /* DUK */
      ".gpi-faq{display:flex;flex-direction:column;gap:8px}",
      ".gpi-faq details{border:1px solid var(--color-graphite-15,#E1E2E4);border-radius:var(--radius-sm,8px);overflow:hidden;background:#fff}",
      ".gpi-faq summary{list-style:none;cursor:pointer;padding:13px 16px;font-size:13.5px;font-weight:700;color:var(--color-graphite,#2E3641);display:flex;align-items:center;justify-content:space-between;gap:10px}",
      ".gpi-faq summary::-webkit-details-marker{display:none}",
      ".gpi-faq summary::after{content:'+';font-size:18px;font-weight:700;color:var(--color-emerald,#00A072);flex-shrink:0;transition:transform 180ms ease}",
      ".gpi-faq details[open] summary::after{content:'\\2212'}",
      ".gpi-faq .gpi-a{padding:0 16px 14px;font-size:12.5px;color:var(--color-graphite,#2E3641);line-height:1.55}",
      ".gpi-mfoot{display:flex;justify-content:flex-end;gap:8px;padding:var(--space-2,16px) var(--space-4,32px);border-top:1px solid var(--color-graphite-15,#E1E2E4);background:var(--color-graphite-5,#EFF1F1)}",
      ".gpi-close-btn{display:inline-flex;align-items:center;gap:8px;background:var(--color-emerald,#00A072);color:#fff;border:none;font-family:inherit;font-size:14px;font-weight:700;padding:10px 18px;border-radius:var(--radius-sm,8px);cursor:pointer;transition:background 180ms ease}",
      ".gpi-close-btn:hover{background:var(--color-emerald-120,#128A76)}",
      "body.gpi-noscroll{overflow:hidden}"
    ].join("");
    var el = document.createElement("style");
    el.id = STYLE_ID; el.textContent = css;
    document.head.appendChild(el);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (m) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m];
    });
  }
  function storageKey(id) { return LS_PREFIX + id; }
  function isOpen(cfg) {
    try {
      var v = localStorage.getItem(storageKey(cfg.moduleId));
      if (v === "open") return true;
      if (v === "closed") return false;
    } catch (e) {}
    return cfg.defaultOpen !== false;
  }
  function setOpen(cfg, open) {
    try { localStorage.setItem(storageKey(cfg.moduleId), open ? "open" : "closed"); } catch (e) {}
  }

  var ICON_INFO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>';
  var ICON_CHEV = '<svg class="gpi-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
  var ICON_SHIELD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 4 6v6c0 5 3.4 7.7 8 10 4.6-2.3 8-5 8-10V6z"/></svg>';
  var ICON_BOOK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>';
  var ICON_FLOW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="6" r="3"/><circle cx="19" cy="6" r="3"/><circle cx="12" cy="18" r="3"/><path d="M8 6h8M6.5 8.5 10.5 15M17.5 8.5 13.5 15"/></svg>';
  var ICON_TAG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.6 13.4 12 22l-9-9V4a1 1 0 0 1 1-1h8z"/><path d="M7 7h.01"/></svg>';
  var ICON_Q = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/></svg>';
  var ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  /* ---------------------------------------------------------------- *
   *  1 LYGIS — trumpas blokas
   * ---------------------------------------------------------------- */
  function render(cfg) {
    injectStyles();
    var lang = (cfg.getLang && cfg.getLang()) || "lt";
    var c = cfg.content[lang] || cfg.content.lt || {};
    var ui = UI[lang] || UI.lt;
    var open = isOpen(cfg);
    var hasDetails = !!c.details;

    var steps = (c.steps || []).map(function (s, i) {
      return '<div class="gpi-step"><div class="gpi-num">' + (i + 1) + '</div><div class="gpi-step-tx">' + s + '</div></div>';
    }).join("");

    var noteHtml = c.note
      ? '<div class="gpi-note">' + ICON_SHIELD + '<div>' + (c.noteTitle ? '<span class="gpi-note-title">' + esc(c.noteTitle) + '</span>' : "") + c.note + '</div></div>'
      : "";

    var moreBtn = hasDetails
      ? '<button type="button" class="gpi-btn gpi-more" data-gpi-more aria-haspopup="dialog">' + ICON_BOOK + '<span>' + esc(c.moreLabel || ui.more) + '</span></button>'
      : "";

    var html =
      '<div class="gpi' + (open ? "" : " collapsed") + '" role="region" aria-label="' + esc(ui.aria) + '">' +
        '<div class="gpi-head">' +
          '<div class="gpi-ic" data-gpi-toggle>' + ICON_INFO + '</div>' +
          '<div class="gpi-titles" data-gpi-toggle>' +
            '<div class="gpi-title">' + esc(c.title || "") + '</div>' +
            (c.purpose ? '<div class="gpi-purpose">' + c.purpose + '</div>' : "") +
          '</div>' +
          '<div class="gpi-actions">' + moreBtn +
            '<button type="button" class="gpi-btn" data-gpi-toggle aria-expanded="' + (open ? "true" : "false") + '">' +
              '<span data-gpi-label>' + esc(open ? ui.collapse : ui.expand) + '</span>' + ICON_CHEV +
            '</button>' +
          '</div>' +
        '</div>' +
        '<div class="gpi-body"><div class="gpi-inner">' +
          (c.stepsTitle ? '<div class="gpi-steps-title">' + esc(c.stepsTitle) + '</div>' : "") +
          '<div class="gpi-steps">' + steps + '</div>' + noteHtml +
        '</div></div>' +
      '</div>';

    var mount = typeof cfg.target === "string" ? document.querySelector(cfg.target) : cfg.target;
    if (!mount) return;
    mount.innerHTML = html;

    var root = mount.querySelector(".gpi");
    var label = mount.querySelector("[data-gpi-label]");
    var toggleBtn = mount.querySelector('.gpi-btn[aria-expanded]');
    function toggle() {
      var nowOpen = root.classList.toggle("collapsed") === false;
      setOpen(cfg, nowOpen);
      if (label) label.textContent = nowOpen ? ui.collapse : ui.expand;
      if (toggleBtn) toggleBtn.setAttribute("aria-expanded", nowOpen ? "true" : "false");
    }
    mount.querySelectorAll("[data-gpi-toggle]").forEach(function (el) {
      el.addEventListener("click", function (e) { e.stopPropagation(); toggle(); });
    });
    var moreEl = mount.querySelector("[data-gpi-more]");
    if (moreEl) moreEl.addEventListener("click", function (e) { e.stopPropagation(); openDetails(cfg, moreEl); });
  }

  /* ---------------------------------------------------------------- *
   *  2 LYGIS — detalus modalinis langas
   * ---------------------------------------------------------------- */
  function buildModalHtml(c, ui) {
    var d = c.details || {};
    var process = (d.process || []).map(function (p, i) {
      return '<div class="gpi-flow-step"><div class="gpi-flow-node">' + (i + 1) + '</div>' +
        '<div><div class="gpi-flow-title">' + esc(p.title) + '</div>' +
        (p.text ? '<div class="gpi-flow-text">' + esc(p.text) + '</div>' : "") + '</div></div>';
    }).join("");
    var concepts = (d.concepts || []).map(function (k) {
      return '<div class="gpi-concept"><div class="gpi-term">' +
        (k.code ? '<span class="gpi-code">' + esc(k.code) + '</span>' : "") + esc(k.term) + '</div>' +
        (k.def ? '<div class="gpi-def">' + k.def + '</div>' : "") +
        (k.example ? '<div class="gpi-ex"><b>' + (ui === UI.en ? "Example" : "Pavyzdys") + ':</b> ' + k.example + '</div>' : "") +
        '</div>';
    }).join("");
    var faq = (d.faq || []).map(function (f) {
      return '<details><summary>' + esc(f.q) + '</summary><div class="gpi-a">' + f.a + '</div></details>';
    }).join("");

    var sections = "";
    if (process) sections += '<div class="gpi-sec"><div class="gpi-h3">' + ICON_FLOW + esc(d.processTitle || (ui === UI.en ? "How it works" : "Kaip vyksta procesas")) + '</div><div class="gpi-flow">' + process + '</div></div>';
    if (concepts) sections += '<div class="gpi-sec"><div class="gpi-h3">' + ICON_TAG + esc(d.conceptsTitle || (ui === UI.en ? "Key concepts" : "Pagrindinės sąvokos")) + '</div><div class="gpi-concepts">' + concepts + '</div></div>';
    if (faq) sections += '<div class="gpi-sec"><div class="gpi-h3">' + ICON_Q + esc(d.faqTitle || (ui === UI.en ? "FAQ" : "Dažniausi klausimai")) + '</div><div class="gpi-faq">' + faq + '</div></div>';

    return '<div class="gpi-modal" role="dialog" aria-modal="true" aria-labelledby="gpi-dlg-title" tabindex="-1">' +
        '<div class="gpi-hero">' +
          '<button type="button" class="gpi-x" data-gpi-close aria-label="' + esc(ui.close) + '">' + ICON_X + '</button>' +
          '<span class="gpi-hero-tag">' + ICON_BOOK + esc(ui.dialog) + '</span>' +
          '<h2 id="gpi-dlg-title">' + esc(d.title || c.title || "") + '</h2>' +
          (d.intro ? '<div class="gpi-hero-intro">' + d.intro + '</div>' : "") +
        '</div>' +
        '<div class="gpi-mbody">' + sections + '</div>' +
        '<div class="gpi-mfoot"><button type="button" class="gpi-close-btn" data-gpi-close>' + esc(d.closeLabel || ui.close) + '</button></div>' +
      '</div>';
  }

  function focusable(container) {
    return Array.prototype.slice.call(container.querySelectorAll(
      'a[href],button:not([disabled]),textarea,input,select,summary,[tabindex]:not([tabindex="-1"])'
    )).filter(function (el) { return el.offsetParent !== null || el === document.activeElement; });
  }

  function openDetails(cfg, triggerEl) {
    injectStyles();
    var lang = (cfg.getLang && cfg.getLang()) || "lt";
    var c = cfg.content[lang] || cfg.content.lt || {};
    var ui = UI[lang] || UI.lt;
    if (!c.details) return;

    lastFocus = triggerEl || document.activeElement;

    if (!modalEl) {
      modalEl = document.createElement("div");
      modalEl.className = "gpi-overlay";
      document.body.appendChild(modalEl);
      // klikas už lango ribų -> uždaryti
      modalEl.addEventListener("mousedown", function (e) { if (e.target === modalEl) closeDetails(); });
    }
    modalEl.innerHTML = buildModalHtml(c, ui);
    modalEl.classList.add("open");
    document.body.classList.add("gpi-noscroll");

    // uždarymo mygtukai
    modalEl.querySelectorAll("[data-gpi-close]").forEach(function (el) {
      el.addEventListener("click", closeDetails);
    });

    // focus į langą
    var dialog = modalEl.querySelector(".gpi-modal");
    var closeX = modalEl.querySelector(".gpi-x");
    (closeX || dialog).focus();

    // klaviatūra: Esc uždaro, Tab cikluoja viduje (focus trap)
    keyHandler = function (e) {
      if (e.key === "Escape") { e.preventDefault(); closeDetails(); return; }
      if (e.key === "Tab") {
        var f = focusable(modalEl);
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", keyHandler, true);
  }

  function closeDetails() {
    if (!modalEl) return;
    modalEl.classList.remove("open");
    modalEl.innerHTML = "";
    document.body.classList.remove("gpi-noscroll");
    if (keyHandler) { document.removeEventListener("keydown", keyHandler, true); keyHandler = null; }
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
    lastFocus = null;
  }

  var GProcureInfoPanel = {
    mount: function (cfg) { current = cfg; render(cfg); return this; },
    refresh: function () { if (current) render(current); },
    open: function () { if (current) { setOpen(current, true); render(current); } },
    collapse: function () { if (current) { setOpen(current, false); render(current); } },
    openDetails: function () { if (current) openDetails(current, null); },
    closeDetails: closeDetails
  };

  global.GProcureInfoPanel = GProcureInfoPanel;
  if (typeof module !== "undefined" && module.exports) module.exports = GProcureInfoPanel;
})(typeof window !== "undefined" ? window : globalThis);
