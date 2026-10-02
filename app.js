/* =====================================================================
   SPESE DI CASA — logica dell'app
   Regole contabili:
   - Prelievo, carta di credito, bancomat  -> sono USCITE DI CASSA
   - Contanti -> spesa pagata con contante già prelevato: NON si somma
     alle uscite, serve solo a classificare il contante per categoria.
   ===================================================================== */
(function () {
  "use strict";

  // ------------------------------------------------------------------
  // Costanti
  // ------------------------------------------------------------------
  const TIPI = {
    prelievo:      { label: "Prelievo",         breve: "Prelievo",  uscita: true,
      nota: "Conta subito come uscita di cassa. Le spese fatte con questo contante registrale poi come «Contanti» per dire in cosa sono andati i soldi." },
    carta_credito: { label: "Carta di credito", breve: "Carta",     uscita: true,
      nota: "Conta come uscita alla data dell'acquisto." },
    bancomat:      { label: "Bancomat",         breve: "Bancomat",  uscita: true,
      nota: "Conta come uscita alla data del pagamento." },
    contanti:      { label: "Contanti",         breve: "Contanti",  uscita: false,
      nota: "Non si somma alle uscite, perché il prelievo è già stato contato: serve solo a classificare il contante." },
  };
  const PAGE = 1000;
  const eur = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" });
  const fmt = (cents) => eur.format(cents / 100);

  // ------------------------------------------------------------------
  // Stato
  // ------------------------------------------------------------------
  const state = {
    user: null,
    membri: [],
    categorie: [],
    movimenti: [],
    canoni: [],
    saltati: [],                // [{canone_id, mese}]
    pendingCanone: null,        // scadenza in registrazione tramite il form
    editCanoneId: null,         // canone in modifica (Impostazioni)
    mese: meseCorrente(),       // "YYYY-MM"
    vista: "mese",              // "mese" | "anno"
    tab: "nuova",
    editId: null,
    ultimoCaricamento: 0,
  };

  const $ = (id) => document.getElementById(id);
  let sb = null;

  // ------------------------------------------------------------------
  // Utilità
  // ------------------------------------------------------------------
  function meseCorrente() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  }
  function oggiISO() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function spostaMese(ym, delta) {
    let [y, m] = ym.split("-").map(Number);
    m += delta;
    while (m < 1) { m += 12; y--; }
    while (m > 12) { m -= 12; y++; }
    return y + "-" + String(m).padStart(2, "0");
  }
  function ultimoGiorno(ym) {
    const [y, m] = ym.split("-").map(Number);
    return new Date(y, m, 0).getDate();
  }
  /** Intervallo [da, a] in formato YYYY-MM-DD per la vista attuale. */
  function periodo() {
    const [y] = state.mese.split("-");
    if (state.vista === "anno") return { da: y + "-01-01", a: y + "-12-31" };
    return { da: state.mese + "-01", a: state.mese + "-" + String(ultimoGiorno(state.mese)).padStart(2, "0") };
  }
  function nomePeriodo() {
    const [y, m] = state.mese.split("-").map(Number);
    if (state.vista === "anno") return "Anno " + y;
    return new Date(y, m - 1, 1).toLocaleDateString("it-IT", { month: "long", year: "numeric" });
  }
  function nomeMese(ym) {
    const [y, m] = ym.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString("it-IT", { month: "long", year: "numeric" });
  }
  /** "12,50" / "1.234,56" / "12.5" / "€ 7" -> centesimi interi, oppure NaN. */
  function parseImporto(s) {
    let t = String(s || "").replace(/[€\s]/g, "");
    if (!t) return NaN;
    if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
    else if ((t.match(/\./g) || []).length > 1) t = t.replace(/\./g, "");
    if (!/^\d+(\.\d{0,2})?$/.test(t)) return NaN;
    return Math.round(parseFloat(t) * 100);
  }
  const cents = (n) => Math.round(Number(n) * 100);
  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "style") e.setAttribute("style", v);
      else if (v === true) e.setAttribute(k, "");
      else e.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)));
    return e;
  }
  let toastTimer = null;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 2600);
  }
  function avviso(msg) {
    const a = $("avviso-globale");
    a.textContent = msg || ""; a.hidden = !msg;
  }
  function erroreLeggibile(err) {
    const m = (err && (err.message || err.error_description)) || String(err);
    if (/Invalid login credentials/i.test(m)) return "Email o password non corrette.";
    if (/Email not confirmed/i.test(m)) return "L'email non è ancora confermata. Su Supabase, in Authentication > Users, crea l'utente con «Auto Confirm User».";
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "Nessuna connessione con il server. Controlla la rete e riprova.";
    if (/row-level security|permission denied/i.test(m)) return "Il tuo account non è tra i membri della famiglia (tabella «membri» su Supabase).";
    if (/eseguito_da/i.test(m) && /column|colonna|schema cache/i.test(m)) return "Il database non ha ancora il campo «Eseguito da»: su Supabase esegui aggiornamento-esecutore.sql nel SQL Editor.";
    if (/movimenti_eseguito_da_fkey/i.test(m)) return "La persona scelta non è tra i membri della famiglia.";
    if (/canone_una_volta_al_mese/i.test(m)) return "Questo canone è già stato registrato per quel mese (forse dall'altro membro della famiglia).";
    if (/canone_coerente/i.test(m)) return "Un movimento collegato a un canone non può essere un prelievo.";
    if (/canoni_saltati_pkey/i.test(m)) return "Questo mese era già stato saltato.";
    if (/duplicate key/i.test(m)) return "Esiste già una categoria con questo nome.";
    return m;
  }
  const catById = (id) => state.categorie.find((c) => c.id === id);
  const canoneById = (id) => state.canoni.find((c) => c.id === id);
  function dataLunga(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("it-IT", { day: "numeric", month: "long" });
  }
  /** Email del membro collegato, come scritta nella tabella membri. */
  function mioEmail() {
    const e = String((state.user && state.user.email) || "").toLowerCase();
    const m = state.membri.find((x) => x.email.toLowerCase() === e);
    return m ? m.email : (state.user && state.user.email) || null;
  }
  /** Chi ha eseguito il movimento (per i dati precedenti all'aggiornamento: chi l'ha inserito). */
  const esecutore = (m) => m.eseguito_da || m.creato_da;
  function nomeMembro(email) {
    const m = state.membri.find((x) => x.email.toLowerCase() === String(email || "").toLowerCase());
    return m ? m.nome : (email || "").split("@")[0];
  }

  // ------------------------------------------------------------------
  // Avvio
  // ------------------------------------------------------------------
  async function avvia() {
    const cfg = window.SPESE_CONFIG || {};
    if (!window.supabase || !cfg.SUPABASE_URL || /INSERISCI/.test(cfg.SUPABASE_URL + cfg.SUPABASE_KEY)) {
      $("schermo-config").hidden = false;
      return;
    }
    sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
    collegaEventi();
    const { data } = await sb.auth.getSession();
    if (data && data.session) await entra(data.session.user);
    else mostraLogin();
    sb.auth.onAuthStateChange((evt, session) => {
      if (evt === "SIGNED_OUT") mostraLogin();
      else if (session) state.user = session.user;
    });
  }

  function mostraLogin(msg) {
    $("schermo-app").hidden = true;
    $("schermo-login").hidden = false;
    const e = $("login-errore");
    e.textContent = msg || ""; e.hidden = !msg;
  }

  async function entra(user) {
    state.user = user;
    const { data: ok, error } = await sb.rpc("is_membro");
    if (error || ok !== true) {
      await sb.auth.signOut();
      mostraLogin(error ? erroreLeggibile(error) : "Questo account non è tra i membri della famiglia. Aggiungi l'email nella tabella «membri» su Supabase.");
      return;
    }
    $("schermo-login").hidden = true;
    $("schermo-app").hidden = false;
    $("utente-email").textContent = user.email;
    resetForm();
    renderPeriodo();
    await caricaTutto();
  }

  // ------------------------------------------------------------------
  // Dati
  // ------------------------------------------------------------------
  async function caricaTutto() {
    try {
      const [cat, mem, can, sal] = await Promise.all([
        sb.from("categorie").select("*").order("ordine").order("nome"),
        sb.from("membri").select("email, nome").order("nome"),
        sb.from("canoni").select("*").order("nome"),
        sb.from("canoni_saltati").select("*"),
      ]);
      for (const r of [cat, mem]) if (r.error) throw r.error;
      state.categorie = cat.data;
      state.membri = mem.data;
      // Se il database non ha ancora le tabelle dei canoni, il resto dell'app funziona lo stesso.
      state.canoniDisponibili = !can.error && !sal.error;
      if (can.error || sal.error) console.warn("Canoni non disponibili:", (can.error || sal.error).message);
      state.canoni = state.canoniDisponibili ? can.data.map((c) => ({ ...c, cents: cents(c.importo) })) : [];
      state.saltati = state.canoniDisponibili ? sal.data : [];
      $("canoni-mancanti").hidden = state.canoniDisponibili;
      $("panel-gestione-canoni").hidden = !state.canoniDisponibili;

      const tutti = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await sb.from("movimenti").select("*")
          .order("data", { ascending: false }).order("id", { ascending: false })
          .range(from, from + PAGE - 1);
        if (error) throw error;
        tutti.push(...data);
        if (data.length < PAGE) break;
      }
      state.movimenti = tutti.map((m) => ({ ...m, cents: cents(m.importo) }));
      state.ultimoCaricamento = Date.now();
      avviso(tutti.length && !("eseguito_da" in tutti[0])
        ? "Per registrare chi esegue i movimenti, su Supabase esegui aggiornamento-esecutore.sql nel SQL Editor. Fino ad allora i movimenti sono attribuiti a chi li ha inseriti."
        : "");
    } catch (err) {
      avviso("Non riesco a leggere i dati: " + erroreLeggibile(err));
    }
    renderTutto();
  }

  // ------------------------------------------------------------------
  // Navigazione
  // ------------------------------------------------------------------
  function vaiA(tab) {
    state.tab = tab;
    document.querySelectorAll("section.tab").forEach((s) => (s.hidden = s.dataset.tab !== tab));
    document.querySelectorAll(".tabbar button").forEach((b) => {
      if (b.dataset.goto === tab) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    window.scrollTo(0, 0);
  }

  function renderPeriodo() {
    $("mese").textContent = state.vista === "anno" ? state.mese.slice(0, 4) : nomeMese(state.mese);
    $("mese-prec").setAttribute("aria-label", state.vista === "anno" ? "Anno precedente" : "Mese precedente");
    $("mese-succ").setAttribute("aria-label", state.vista === "anno" ? "Anno successivo" : "Mese successivo");
    $("vista-mese").setAttribute("aria-pressed", String(state.vista === "mese"));
    $("vista-anno").setAttribute("aria-pressed", String(state.vista === "anno"));
  }

  function renderTutto() {
    renderPeriodo();
    renderChips();
    renderFiltroCategorie();
    renderEsecutori();
    renderFiltroPersone();
    renderLista();
    renderRiepilogo();
    renderCategorie();
    renderScadenze();
    renderCanoni();
    $("membri-elenco").textContent = state.membri.map((m) => m.nome).join(", ");
  }

  // ------------------------------------------------------------------
  // Form movimento
  // ------------------------------------------------------------------
  const tipoScelto = () => (document.querySelector('input[name="tipo"]:checked') || {}).value;
  const categoriaScelta = () => {
    const r = document.querySelector('input[name="categoria"]:checked');
    return r ? Number(r.value) : null;
  };

  function aggiornaTipo() {
    const t = tipoScelto();
    $("tipo-nota").textContent = TIPI[t] ? TIPI[t].nota : "";
    $("blocco-categoria").hidden = t === "prelievo";
  }

  function renderChips(selId) {
    const box = $("chips-categorie");
    const corrente = selId !== undefined ? selId : categoriaScelta();
    box.replaceChildren();
    const visibili = state.categorie.filter((c) => c.attiva || c.id === corrente);
    if (!visibili.length) {
      box.append(el("span", { class: "type-note", text: "Nessuna categoria attiva: aggiungine una nella sezione Opzioni." }));
      return;
    }
    for (const c of visibili) {
      box.append(el("label", null,
        el("input", { type: "radio", name: "categoria", value: c.id, checked: c.id === corrente }),
        el("span", { text: c.nome })));
    }
  }

  const esecutoreScelto = () => (document.querySelector('input[name="esecutore"]:checked') || {}).value || null;

  function renderEsecutori(sel) {
    const box = $("chips-esecutori");
    const corrente = sel !== undefined ? sel : (esecutoreScelto() || mioEmail());
    box.replaceChildren();
    const elenco = state.membri.length ? state.membri : (mioEmail() ? [{ email: mioEmail(), nome: nomeMembro(mioEmail()) }] : []);
    for (const m of elenco) {
      box.append(el("label", null,
        el("input", { type: "radio", name: "esecutore", value: m.email, checked: m.email.toLowerCase() === String(corrente || "").toLowerCase() }),
        el("span", { text: m.nome + (m.email.toLowerCase() === String(mioEmail() || "").toLowerCase() ? " (tu)" : "") })));
    }
    if (!esecutoreScelto() && box.querySelector("input")) box.querySelector("input").checked = true;
  }

  function resetForm(mantieni) {
    const tipo = mantieni ? tipoScelto() : "bancomat";
    const data = mantieni ? $("data").value : oggiISO();
    const chi = mantieni ? esecutoreScelto() : mioEmail();
    state.editId = null;
    state.pendingCanone = null;
    $("form-canone").hidden = true;
    $("form-mov").reset();
    document.querySelector(`input[name="tipo"][value="${tipo}"]`).checked = true;
    $("data").value = data || oggiISO();
    $("form-titolo").textContent = "Nuovo movimento";
    $("salva-btn").textContent = "Salva";
    $("annulla-modifica").hidden = true;
    $("elimina-btn").hidden = true;
    $("conferma-elimina").hidden = true;
    $("form-errore").hidden = true;
    renderChips(null);
    renderEsecutori(chi);
    aggiornaTipo();
  }

  function apriModifica(m) {
    state.editId = m.id;
    document.querySelector(`input[name="tipo"][value="${m.tipo}"]`).checked = true;
    $("importo").value = (m.cents / 100).toFixed(2).replace(".", ",");
    $("data").value = m.data;
    $("descrizione").value = m.descrizione || "";
    renderChips(m.categoria_id);
    renderEsecutori(esecutore(m));
    aggiornaTipo();
    $("form-titolo").textContent = "Modifica movimento";
    $("salva-btn").textContent = "Salva modifiche";
    state.pendingCanone = null;
    const can = m.canone_id ? canoneById(m.canone_id) : null;
    $("form-canone").textContent = can ? "Canone «" + can.nome + "» di " + nomeMese(m.canone_mese.slice(0, 7)) : "";
    $("form-canone").hidden = !can;
    $("annulla-modifica").hidden = false;
    $("elimina-btn").hidden = false;
    $("conferma-elimina").hidden = true;
    $("form-errore").hidden = true;
    vaiA("nuova");
  }

  async function salvaMovimento(ev) {
    ev.preventDefault();
    const err = $("form-errore");
    err.hidden = true;
    const tipo = tipoScelto();
    const c = parseImporto($("importo").value);
    const data = $("data").value;
    const categoria_id = tipo === "prelievo" ? null : categoriaScelta();
    let problema = "";
    if (!tipo) problema = "Scegli il tipo di movimento.";
    else if (!(c > 0)) problema = "Scrivi un importo valido, per esempio 12,50.";
    else if (c > 99999999) problema = "L'importo è troppo alto.";
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) problema = "Scegli la data.";
    else if (tipo !== "prelievo" && !categoria_id) problema = "Scegli una categoria.";
    if (problema) { err.textContent = problema; err.hidden = false; return; }

    const riga = {
      tipo, data, categoria_id,
      importo: (c / 100).toFixed(2),
      descrizione: $("descrizione").value.trim() || null,
      eseguito_da: esecutoreScelto() || mioEmail(),
    };
    if (!state.editId && state.pendingCanone) {
      if (tipo === "prelievo") { err.textContent = "Un canone non può essere registrato come prelievo."; err.hidden = false; return; }
      riga.canone_id = state.pendingCanone.canone.id;
      riga.canone_mese = state.pendingCanone.mese + "-01";
    }
    const btn = $("salva-btn");
    btn.disabled = true;
    try {
      let res;
      if (state.editId) res = await sb.from("movimenti").update({ ...riga, modificato_il: new Date().toISOString() }).eq("id", state.editId);
      else res = await sb.from("movimenti").insert(riga);
      if (res.error) throw res.error;
      const eraModifica = !!state.editId;
      const eraCanone = !eraModifica && !!state.pendingCanone;
      toast(eraModifica ? "Modifica salvata" : eraCanone ? "Canone «" + state.pendingCanone.canone.nome + "» registrato" : TIPI[tipo].label + " di " + fmt(c) + " salvato");
      if (eraModifica || eraCanone) resetForm(false); else resetForm(true);
      await caricaTutto();
      if (eraModifica) vaiA("movimenti");
    } catch (e) {
      err.textContent = "Non salvato: " + erroreLeggibile(e);
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  async function eliminaMovimento() {
    if (!state.editId) return;
    const { error } = await sb.from("movimenti").delete().eq("id", state.editId);
    if (error) {
      $("form-errore").textContent = "Non eliminato: " + erroreLeggibile(error);
      $("form-errore").hidden = false;
      return;
    }
    toast("Movimento eliminato");
    resetForm(false);
    await caricaTutto();
    vaiA("movimenti");
  }

  // ------------------------------------------------------------------
  // Elenco movimenti
  // ------------------------------------------------------------------
  function renderFiltroCategorie() {
    const s = $("filtro-categoria");
    const v = s.value;
    s.replaceChildren(el("option", { value: "", text: "Tutte" }));
    for (const c of state.categorie) s.append(el("option", { value: c.id, text: c.nome + (c.attiva ? "" : " (disattivata)") }));
    s.value = v;
  }

  function renderFiltroPersone() {
    const s = $("filtro-persona");
    const v = s.value;
    s.replaceChildren(el("option", { value: "", text: "Tutti" }), ...state.membri.map((m) => el("option", { value: m.email, text: m.nome })));
    s.value = v;
  }

  function movimentiNelPeriodo() {
    const { da, a } = periodo();
    return state.movimenti.filter((m) => m.data >= da && m.data <= a);
  }

  function renderLista() {
    const box = $("lista-movimenti");
    const ft = $("filtro-tipo").value;
    const fp = $("filtro-persona").value;
    const fc = $("filtro-categoria").value;
    const righe = movimentiNelPeriodo().filter((m) =>
      (!ft || m.tipo === ft) && (!fc || String(m.categoria_id) === fc) &&
      (!fp || String(esecutore(m)).toLowerCase() === fp.toLowerCase()));

    let uscite = 0, contanti = 0;
    for (const m of righe) { if (TIPI[m.tipo].uscita) uscite += m.cents; else contanti += m.cents; }
    $("lista-totale").replaceChildren(
      el("span", null, righe.length + (righe.length === 1 ? " movimento" : " movimenti") + " · " + nomePeriodo()),
      el("span", null, "Uscite ", el("b", { class: "num", text: fmt(uscite) }),
        contanti ? el("span", null, " · contanti classificati ", el("b", { class: "num", text: fmt(contanti) })) : null));

    box.replaceChildren();
    if (!righe.length) {
      box.append(el("div", { class: "panel empty" },
        el("div", { text: state.movimenti.length ? "Nessun movimento in questo periodo con i filtri scelti." : "Ancora nessun movimento registrato." }),
        el("button", { class: "btn btn-primary btn-small", type: "button", onclick: () => vaiA("nuova") }, "Registra un movimento")));
      return;
    }
    const perGiorno = new Map();
    for (const m of righe) {
      if (!perGiorno.has(m.data)) perGiorno.set(m.data, []);
      perGiorno.get(m.data).push(m);
    }
    for (const [giorno, lista] of perGiorno) {
      const [y, mo, d] = giorno.split("-").map(Number);
      const etichetta = new Date(y, mo - 1, d).toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" });
      const totG = lista.reduce((s, m) => s + (TIPI[m.tipo].uscita ? m.cents : 0), 0);
      const g = el("div", { class: "day" },
        el("div", { class: "day-head" }, el("span", { text: etichetta }), totG ? el("span", { class: "num", text: fmt(totG) }) : null));
      for (const m of lista) {
        const cat = m.categoria_id ? catById(m.categoria_id) : null;
        const titolo = m.tipo === "prelievo" ? "Prelievo contante" : (cat ? cat.nome : "—");
        const chi = nomeMembro(esecutore(m));
        const inserito = m.creato_da && String(m.creato_da).toLowerCase() !== String(esecutore(m)).toLowerCase()
          ? "inserito da " + nomeMembro(m.creato_da) : "";
        const sotto = [m.descrizione, chi, inserito].filter(Boolean).join(" · ");
        g.append(el("button", { class: "mov", type: "button", onclick: () => apriModifica(m), "aria-label": "Modifica " + titolo + " " + fmt(m.cents) },
          el("span", { class: "pill t-" + m.tipo, text: TIPI[m.tipo].breve }),
          el("span", { class: "mov-main" }, el("b", { text: titolo }),
            el("small", null, m.canone_id ? el("span", { class: "tag-canone", text: "Canone" }) : null, sotto)),
          el("span", { class: "mov-amt num" + (TIPI[m.tipo].uscita ? "" : " is-info"), title: TIPI[m.tipo].uscita ? "" : "Non conta nelle uscite: già contato nel prelievo", text: fmt(m.cents) })));
      }
      box.append(g);
    }
  }

  // ------------------------------------------------------------------
  // Riepilogo
  // ------------------------------------------------------------------
  /** Calcolo puro del riepilogo (esposto per i test). */
  function calcolaRiepilogo(movimenti, da, a) {
    const r = {
      perTipo: { prelievo: 0, carta_credito: 0, bancomat: 0, contanti: 0 },
      uscite: 0, perCategoria: new Map(), nonClassificato: 0, contanteResiduo: 0,
      fisse: 0, variabili: 0,
    };
    for (const m of movimenti) {
      if (m.data <= a) {
        if (m.tipo === "prelievo") r.contanteResiduo += m.cents;
        if (m.tipo === "contanti") r.contanteResiduo -= m.cents;
      }
      if (m.data < da || m.data > a) continue;
      r.perTipo[m.tipo] += m.cents;
      if (m.canone_id) r.fisse += m.cents;
      if (m.tipo !== "prelievo") {
        if (!r.perCategoria.has(m.categoria_id)) r.perCategoria.set(m.categoria_id, { carta_credito: 0, bancomat: 0, contanti: 0, tot: 0 });
        const c = r.perCategoria.get(m.categoria_id);
        c[m.tipo] += m.cents; c.tot += m.cents;
      }
    }
    r.uscite = r.perTipo.prelievo + r.perTipo.carta_credito + r.perTipo.bancomat;
    r.nonClassificato = r.perTipo.prelievo - r.perTipo.contanti; // può essere negativo
    // Base comune al grafico per categoria: spese classificate + contante non classificato.
    const classificate = r.perTipo.carta_credito + r.perTipo.bancomat + r.perTipo.contanti;
    r.variabili = classificate - r.fisse + Math.max(0, r.nonClassificato);
    return r;
  }
  window.__calcolaRiepilogo = calcolaRiepilogo;

  function renderRiepilogo() {
    const { da, a } = periodo();
    const r = calcolaRiepilogo(state.movimenti, da, a);
    $("riep-periodo").textContent = nomePeriodo();
    $("riep-totale").textContent = fmt(r.uscite);

    $("riep-split").replaceChildren(...["prelievo", "carta_credito", "bancomat"].map((t) =>
      el("div", { class: "t-" + t }, el("small", { text: TIPI[t].label }), el("span", { class: "num", text: fmt(r.perTipo[t]) }))));

    renderFisseVariabili(r);
    renderPersone(da, a);

    const fineLabel = state.vista === "anno" ? "a fine " + state.mese.slice(0, 4) : "a fine " + nomeMese(state.mese);
    const rows = [
      ["Prelevato nel periodo", fmt(r.perTipo.prelievo)],
      ["Speso in contanti e classificato", fmt(r.perTipo.contanti)],
    ];
    const cash = $("riep-contante");
    cash.replaceChildren(...rows.map(([k, v]) => el("div", { class: "cash-row" }, el("span", { text: k }), el("span", { class: "num", text: v }))),
      el("div", { class: "cash-row total" }, el("span", { text: "Contante ancora da classificare " + fineLabel }), el("span", { class: "num", text: fmt(r.contanteResiduo) })));
    if (r.contanteResiduo < 0) {
      cash.append(el("div", { class: "msg msg-warn", text: "Risultano più spese in contanti che prelievi. Forse manca un prelievo, oppure è stato usato contante arrivato da altre fonti." }));
    } else if (r.contanteResiduo > 0) {
      cash.append(el("div", { class: "type-note", text: "È il contante prelevato non ancora registrato come spesa: quello che avete in tasca, oppure spese da classificare." }));
    }

    const box = $("riep-categorie");
    box.replaceChildren();
    const voci = [...r.perCategoria.entries()].map(([id, v]) => ({ id, nome: (catById(id) || { nome: "Categoria eliminata" }).nome, ...v }))
      .sort((x, y) => y.tot - x.tot);
    if (r.nonClassificato > 0) voci.push({ id: "nc", nome: "Contante non classificato", nonclass: r.nonClassificato, tot: r.nonClassificato });
    if (!voci.length) {
      box.append(el("div", { class: "empty", text: "Nessuna spesa in questo periodo." }));
      return;
    }
    const max = Math.max(...voci.map((v) => v.tot));
    const somma = voci.reduce((s, v) => s + v.tot, 0);
    for (const v of voci) {
      const track = el("div", { class: "bar-track" });
      const pezzi = v.id === "nc" ? [["nonclass", v.nonclass]] : [["carta_credito", v.carta_credito], ["bancomat", v.bancomat], ["contanti", v.contanti]];
      for (const [k, val] of pezzi) if (val > 0) track.append(el("div", { class: "bar-fill f-" + k, style: "width:" + (val / max * 100).toFixed(2) + "%" }));
      const dett = v.id === "nc"
        ? "Prelevato nel periodo e non ancora registrato come spesa in contanti"
        : pezzi.filter(([, val]) => val > 0).map(([k, val]) => TIPI[k].breve + " " + fmt(val)).join(" · ");
      box.append(el("div", { class: "bar" },
        el("div", { class: "bar-top" }, el("span", { text: v.nome }),
          el("span", { class: "num" }, fmt(v.tot), el("span", { class: "bar-sub", text: "  " + Math.round(v.tot / somma * 100) + "%" }))),
        track,
        el("div", { class: "bar-sub", text: dett })));
    }
    if (r.nonClassificato < 0) {
      box.append(el("div", { class: "type-note", text: "In questo periodo avete classificato anche " + fmt(-r.nonClassificato) + " di contante prelevato in periodi precedenti: per questo il totale per categoria supera le uscite." }));
    }
  }

  // ------------------------------------------------------------------
  // Per persona
  // ------------------------------------------------------------------
  /** Calcolo puro delle uscite e del contante per persona (esposto per i test). */
  function calcolaPerPersona(movimenti, membri, da, a) {
    const chiave = (e) => String(e || "").toLowerCase();
    const per = new Map();
    const voce = (email) => {
      const k = chiave(email);
      if (!per.has(k)) {
        const mem = membri.find((x) => chiave(x.email) === k);
        per.set(k, { email: mem ? mem.email : email, prelievo: 0, carta_credito: 0, bancomat: 0, contanti: 0,
          uscite: 0, residuo: 0, contantiPerCategoria: new Map() });
      }
      return per.get(k);
    };
    for (const m of membri) voce(m.email);
    for (const m of movimenti) {
      const v = voce(esecutore(m));
      if (m.data <= a) {
        if (m.tipo === "prelievo") v.residuo += m.cents;
        if (m.tipo === "contanti") v.residuo -= m.cents;
      }
      if (m.data < da || m.data > a) continue;
      v[m.tipo] += m.cents;
      if (TIPI[m.tipo].uscita) v.uscite += m.cents;
      if (m.tipo === "contanti") v.contantiPerCategoria.set(m.categoria_id, (v.contantiPerCategoria.get(m.categoria_id) || 0) + m.cents);
    }
    return [...per.values()];
  }
  window.__calcolaPerPersona = calcolaPerPersona;

  function renderPersone(da, a) {
    const box = $("riep-persone");
    const persone = calcolaPerPersona(state.movimenti, state.membri, da, a);
    const fine = state.vista === "anno" ? "fine " + state.mese.slice(0, 4) : "fine " + nomeMese(state.mese).split(" ")[0];
    box.replaceChildren(...persone.map((p) => {
      const cats = [...p.contantiPerCategoria.entries()].sort((x, y) => y[1] - x[1])
        .map(([id, c]) => ((catById(id) || {}).nome || "?") + " " + fmt(c)).join(" · ");
      return el("div", { class: "person" },
        el("div", { class: "person-head" }, el("b", { text: nomeMembro(p.email) }),
          el("span", null, el("span", { class: "type-note", text: "uscite " }), el("span", { class: "num", text: fmt(p.uscite) }))),
        el("div", { class: "person-types" }, ...["prelievo", "carta_credito", "bancomat"].map((t) =>
          el("div", { class: "t-" + t }, el("small", { text: TIPI[t].breve }), el("span", { class: "num", text: fmt(p[t]) })))),
        el("div", { class: "person-cash" },
          el("div", { class: "cash-row" }, el("span", { text: "Contante prelevato" }), el("span", { class: "num", text: fmt(p.prelievo) })),
          el("div", { class: "cash-row highlight" }, el("span", { text: "Contante usato" }), el("span", { class: "num", text: fmt(p.contanti) })),
          el("div", { class: "cash-row" }, el("span", { text: "Da classificare a " + fine }), el("span", { class: "num", text: fmt(p.residuo) })),
          cats ? el("div", { class: "person-cats", text: "In contanti: " + cats }) : null));
    }));
    if (persone.some((p) => p.residuo < 0)) {
      box.append(el("div", { class: "type-note", style: "grid-column:1/-1",
        text: "Un residuo negativo vuol dire che quella persona ha speso contante prelevato dall'altra: il contante è passato di mano. Il residuo che conta è quello di famiglia, nel riquadro Contante." }));
    }
  }

  // ------------------------------------------------------------------
  // Canoni mensili
  // ------------------------------------------------------------------
  const MESI_ARRETRATI = 12; // non propone canoni più vecchi di così

  /** Calcolo puro delle scadenze da registrare (esposto per i test). */
  function canoniDaRegistrare(canoni, movimenti, saltati, oggi) {
    const meseOggi = oggi.slice(0, 7);
    const limite = spostaMese(meseOggi, -(MESI_ARRETRATI - 1));
    const fatti = new Set(movimenti.filter((m) => m.canone_id).map((m) => m.canone_id + "|" + m.canone_mese.slice(0, 7)));
    const saltatiSet = new Set(saltati.map((s) => s.canone_id + "|" + s.mese.slice(0, 7)));
    const out = [];
    for (const c of canoni) {
      if (!c.attivo) continue;
      let ym = c.dal_mese.slice(0, 7);
      if (ym < limite) ym = limite;
      for (; ym <= meseOggi; ym = spostaMese(ym, 1)) {
        const k = c.id + "|" + ym;
        if (fatti.has(k) || saltatiSet.has(k)) continue;
        const giorno = Math.min(c.giorno, ultimoGiorno(ym));
        const scadenza = ym + "-" + String(giorno).padStart(2, "0");
        out.push({ canone: c, mese: ym, scadenza, scaduto: scadenza <= oggi });
      }
    }
    return out.sort((a, b) => (a.scadenza < b.scadenza ? -1 : a.scadenza > b.scadenza ? 1 : a.canone.nome.localeCompare(b.canone.nome)));
  }
  window.__canoniDaRegistrare = canoniDaRegistrare;

  function renderScadenze() {
    const oggi = oggiISO();
    const lista = canoniDaRegistrare(state.canoni, state.movimenti, state.saltati, oggi);
    const box = $("lista-scadenze");
    $("panel-canoni").hidden = !lista.length;
    box.replaceChildren();
    const scaduti = lista.filter((p) => p.scaduto).length;
    $("canoni-conteggio").textContent = lista.length + (scaduti ? " · " + scaduti + " scadut" + (scaduti === 1 ? "o" : "i") : "");
    const MAX = 3;
    const visibili = state.scadenzeTutte ? lista : lista.slice(0, MAX);
    for (const p of visibili) {
      const c = p.canone;
      const cat = catById(c.categoria_id);
      const skipBtn = el("button", { class: "btn btn-ghost btn-small", type: "button" }, "Salta");
      skipBtn.addEventListener("click", () => {
        if (skipBtn.dataset.armed) { saltaCanone(p); return; }
        skipBtn.dataset.armed = "1";
        skipBtn.textContent = "Salta " + nomeMese(p.mese).split(" ")[0] + "?";
        skipBtn.classList.add("btn-danger");
      });
      box.append(el("div", { class: "due" + (p.scaduto ? " is-late" : "") },
        el("span", { class: "due-name", text: c.nome }),
        el("span", { class: "num", text: fmt(c.cents) }),
        el("span", { class: "due-meta" },
          el("span", { class: p.scaduto ? "late" : "", text: (p.scaduto ? "Scaduto il " : "Previsto il ") + dataLunga(p.scadenza) }),
          " · " + TIPI[c.tipo].label + " · " + (cat ? cat.nome : "")),
        el("div", { class: "btn-row" },
          el("button", { class: "btn btn-primary btn-small", type: "button", onclick: (e) => registraCanone(p, e.currentTarget) }, "Registra"),
          el("button", { class: "btn btn-small", type: "button", onclick: () => apriCanoneNelForm(p) }, "Altro importo"),
          skipBtn)));
    }
    if (lista.length > MAX) {
      box.append(el("button", { class: "btn btn-ghost btn-small", type: "button", onclick: () => { state.scadenzeTutte = !state.scadenzeTutte; renderScadenze(); } },
        state.scadenzeTutte ? "Mostra meno" : "Mostra tutti (" + lista.length + ")"));
    }
  }

  /** Data del movimento: la scadenza se è passata, altrimenti oggi (pagamento anticipato). */
  const dataRegistrazione = (p) => (p.scadenza <= oggiISO() ? p.scadenza : oggiISO());

  async function registraCanone(p, btn) {
    const c = p.canone;
    if (btn) btn.disabled = true;
    const { error } = await sb.from("movimenti").insert({
      tipo: c.tipo, importo: (c.cents / 100).toFixed(2), categoria_id: c.categoria_id,
      data: dataRegistrazione(p), descrizione: c.nome + (c.descrizione ? " · " + c.descrizione : ""),
      canone_id: c.id, canone_mese: p.mese + "-01", eseguito_da: mioEmail(),
    });
    if (error) { avviso("Canone non registrato: " + erroreLeggibile(error)); if (btn) btn.disabled = false; }
    else toast("«" + c.nome + "» di " + nomeMese(p.mese) + " registrato");
    await caricaTutto();
  }

  async function saltaCanone(p) {
    const { error } = await sb.from("canoni_saltati").insert({ canone_id: p.canone.id, mese: p.mese + "-01" });
    if (error) avviso("Non salvato: " + erroreLeggibile(error));
    else toast("«" + p.canone.nome + "» saltato per " + nomeMese(p.mese));
    await caricaTutto();
  }

  function apriCanoneNelForm(p) {
    resetForm(false);
    const c = p.canone;
    state.pendingCanone = p;
    document.querySelector(`input[name="tipo"][value="${c.tipo}"]`).checked = true;
    $("importo").value = (c.cents / 100).toFixed(2).replace(".", ",");
    $("data").value = dataRegistrazione(p);
    $("descrizione").value = c.nome + (c.descrizione ? " · " + c.descrizione : "");
    renderChips(c.categoria_id);
    renderEsecutori(mioEmail());
    aggiornaTipo();
    $("form-titolo").textContent = "Registra canone";
    $("form-canone").textContent = "Canone «" + c.nome + "» di " + nomeMese(p.mese) + ": correggi l'importo e salva.";
    $("form-canone").hidden = false;
    $("salva-btn").textContent = "Registra canone";
    $("annulla-modifica").hidden = false;
    $("form-mov").scrollIntoView({ block: "start" });
    $("importo").focus();
    $("importo").select();
  }

  function renderFisseVariabili(r) {
    const tot = r.fisse + r.variabili;
    const pf = tot ? (r.fisse / tot * 100) : 0;
    const box = $("riep-fv");
    const righe = [
      el("div", { class: "fv-row" }, el("span", null, el("i", { style: "background:var(--accent)" }), "Fisse (canoni)"),
        el("span", { class: "num", text: fmt(r.fisse) + (tot ? "  " + Math.round(pf) + "%" : "") })),
      el("div", { class: "fv-row" }, el("span", null, el("i", { style: "background:var(--line)" }), "Variabili"),
        el("span", { class: "num", text: fmt(r.variabili) + (tot ? "  " + (100 - Math.round(pf)) + "%" : "") })),
    ];
    const track = el("div", { class: "fv-track" },
      el("div", { class: "fisse", style: "width:" + pf.toFixed(2) + "%" }),
      el("div", { class: "variabili", style: "width:" + (100 - pf).toFixed(2) + "%" }));
    const attivi = state.canoni.filter((c) => c.attivo);
    const impegno = attivi.reduce((s, c) => s + c.cents, 0);
    const extra = [];
    if (attivi.length) {
      extra.push(el("div", { class: "cash-row" }, el("span", { text: "Canoni attivi: " + attivi.length + ", impegno mensile" }), el("span", { class: "num", text: fmt(impegno) })));
      if (state.vista === "mese") {
        const ym = state.mese;
        const dovuti = attivi.filter((c) => c.dal_mese.slice(0, 7) <= ym && !state.saltati.some((s) => s.canone_id === c.id && s.mese.startsWith(ym)));
        const fatti = dovuti.filter((c) => state.movimenti.some((m) => m.canone_id === c.id && m.canone_mese.startsWith(ym)));
        if (dovuti.length) extra.push(el("div", { class: "type-note", text: "Canoni registrati in " + nomeMese(ym) + ": " + fatti.length + " su " + dovuti.length + "." }));
      }
    } else {
      extra.push(el("div", { class: "type-note", text: "Nessun canone impostato. Puoi aggiungerli nella sezione «Canoni»." }));
    }
    box.replaceChildren(track, ...righe, ...extra);
  }

  function opzioniMesi(selezionato) {
    const out = [];
    const base = meseCorrente();
    for (let i = -12; i <= 12; i++) {
      const ym = spostaMese(base, i);
      out.push(el("option", { value: ym, selected: ym === selezionato, text: nomeMese(ym) }));
    }
    if (selezionato && !out.some((o) => o.value === selezionato)) out.unshift(el("option", { value: selezionato, selected: true, text: nomeMese(selezionato) }));
    return out;
  }

  function renderCanoni() {
    const box = $("lista-canoni");
    box.replaceChildren();
    const ordinati = [...state.canoni].sort((a, b) => (b.attivo - a.attivo) || a.nome.localeCompare(b.nome));
    for (const c of ordinati) {
      const cat = catById(c.categoria_id);
      box.append(el("button", { class: "can-item" + (c.attivo ? "" : " off"), type: "button", onclick: () => apriFormCanone(c) },
        el("b", { text: c.nome }),
        el("span", { class: "num", text: fmt(c.cents) }),
        el("small", { text: "Ogni mese il " + c.giorno + " · " + TIPI[c.tipo].label + " · " + (cat ? cat.nome : "") + (c.attivo ? " · da " + nomeMese(c.dal_mese.slice(0, 7)) : " · non attivo") })));
    }
    const attivi = state.canoni.filter((c) => c.attivo);
    $("canoni-totale").replaceChildren(attivi.length
      ? el("span", null, "Totale canoni attivi ", el("b", { class: "num", text: fmt(attivi.reduce((s, c) => s + c.cents, 0)) }), " al mese")
      : el("span", { text: state.canoni.length ? "Nessun canone attivo." : "Nessun canone ancora. Premi «Nuovo canone» per aggiungerne uno." }));
  }

  function apriFormCanone(c) {
    state.editCanoneId = c ? c.id : null;
    const f = $("form-canone-def");
    f.hidden = false;
    $("canone-errore").hidden = true;
    $("canone-form-titolo").textContent = c ? "Modifica canone" : "Nuovo canone";
    $("can-nome").value = c ? c.nome : "";
    $("can-importo").value = c ? (c.cents / 100).toFixed(2).replace(".", ",") : "";
    $("can-tipo").value = c ? c.tipo : "bancomat";
    const sel = $("can-categoria");
    sel.replaceChildren(el("option", { value: "", text: "Scegli…" }),
      ...state.categorie.filter((k) => k.attiva || (c && k.id === c.categoria_id)).map((k) => el("option", { value: k.id, text: k.nome })));
    sel.value = c ? String(c.categoria_id) : "";
    $("can-giorno").value = c ? c.giorno : "";
    $("can-dal").replaceChildren(...opzioniMesi(c ? c.dal_mese.slice(0, 7) : meseCorrente()));
    $("can-descrizione").value = c ? (c.descrizione || "") : "";
    $("can-attivo").checked = c ? c.attivo : true;
    $("can-attivo-wrap").hidden = !c;
    $("can-nome").focus();
  }

  function chiudiFormCanone() {
    state.editCanoneId = null;
    $("form-canone-def").hidden = true;
  }

  async function salvaCanone(ev) {
    ev.preventDefault();
    const err = $("canone-errore");
    err.hidden = true;
    const nome = $("can-nome").value.trim();
    const c = parseImporto($("can-importo").value);
    const giorno = parseInt($("can-giorno").value, 10);
    const categoria_id = Number($("can-categoria").value) || null;
    let problema = "";
    if (!nome) problema = "Dai un nome al canone.";
    else if (!(c > 0)) problema = "Scrivi un importo valido, per esempio 45,90.";
    else if (!categoria_id) problema = "Scegli una categoria.";
    else if (!(giorno >= 1 && giorno <= 31)) problema = "Il giorno del mese va da 1 a 31.";
    if (problema) { err.textContent = problema; err.hidden = false; return; }
    const riga = {
      nome, importo: (c / 100).toFixed(2), tipo: $("can-tipo").value, categoria_id, giorno,
      dal_mese: $("can-dal").value + "-01", descrizione: $("can-descrizione").value.trim() || null,
      attivo: state.editCanoneId ? $("can-attivo").checked : true,
    };
    $("can-salva").disabled = true;
    const res = state.editCanoneId
      ? await sb.from("canoni").update(riga).eq("id", state.editCanoneId)
      : await sb.from("canoni").insert(riga);
    $("can-salva").disabled = false;
    if (res.error) { err.textContent = "Non salvato: " + erroreLeggibile(res.error); err.hidden = false; return; }
    toast(state.editCanoneId ? "Canone aggiornato" : "Canone «" + nome + "» aggiunto");
    chiudiFormCanone();
    await caricaTutto();
  }

  // ------------------------------------------------------------------
  // Categorie
  // ------------------------------------------------------------------
  function renderCategorie() {
    const box = $("lista-categorie");
    box.replaceChildren();
    for (const c of state.categorie) {
      const nome = el("input", { type: "text", value: c.nome, maxlength: "60", "aria-label": "Nome categoria", id: "cat-nome-" + c.id });
      const ordine = el("input", { type: "number", value: c.ordine, min: "0", step: "1", "aria-label": "Ordine", id: "cat-ord-" + c.id });
      const att = el("input", { type: "checkbox", checked: c.attiva, id: "cat-att-" + c.id });
      nome.addEventListener("change", () => {
        const v = nome.value.trim();
        if (!v) { nome.value = c.nome; return; }
        aggiornaCategoria(c.id, { nome: v });
      });
      ordine.addEventListener("change", () => aggiornaCategoria(c.id, { ordine: parseInt(ordine.value, 10) || 0 }));
      att.addEventListener("change", () => aggiornaCategoria(c.id, { attiva: att.checked }));
      box.append(el("div", { class: "cat-item" + (c.attiva ? "" : " off") }, nome, ordine,
        el("label", { class: "switch" }, att, "Attiva")));
    }
  }

  async function aggiornaCategoria(id, campi) {
    const { error } = await sb.from("categorie").update(campi).eq("id", id);
    if (error) { avviso("Categoria non aggiornata: " + erroreLeggibile(error)); }
    else toast("Categoria aggiornata");
    await caricaTutto();
  }

  async function aggiungiCategoria(ev) {
    ev.preventDefault();
    const nome = $("nuova-categoria").value.trim();
    if (!nome) return;
    const ordine = Math.max(0, ...state.categorie.filter((c) => c.ordine < 999).map((c) => c.ordine)) + 10;
    const { error } = await sb.from("categorie").insert({ nome, ordine });
    if (error) { avviso("Categoria non aggiunta: " + erroreLeggibile(error)); return; }
    $("nuova-categoria").value = "";
    toast("Categoria «" + nome + "» aggiunta");
    await caricaTutto();
  }

  // ------------------------------------------------------------------
  // Esportazione CSV (separatore ; e virgola decimale, come vuole Excel in italiano)
  // ------------------------------------------------------------------
  function esportaCSV(righe, nomeFile) {
    const q = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
    const intest = ["Data", "Tipo", "Categoria", "Descrizione", "Importo", "Conta nelle uscite", "Canone", "Eseguito da", "Inserito da"];
    const linee = [intest.map(q).join(";")];
    for (const m of [...righe].sort((x, y) => (x.data < y.data ? -1 : x.data > y.data ? 1 : x.id - y.id))) {
      const [y, mo, d] = m.data.split("-");
      linee.push([
        d + "/" + mo + "/" + y,
        TIPI[m.tipo].label,
        m.categoria_id ? (catById(m.categoria_id) || {}).nome : "",
        m.descrizione || "",
        (m.cents / 100).toFixed(2).replace(".", ","),
        TIPI[m.tipo].uscita ? "Sì" : "No (già nel prelievo)",
        m.canone_id ? ((canoneById(m.canone_id) || { nome: "Canone" }).nome + " (" + m.canone_mese.slice(5, 7) + "/" + m.canone_mese.slice(0, 4) + ")") : "",
        nomeMembro(esecutore(m)),
        nomeMembro(m.creato_da),
      ].map(q).join(";"));
    }
    const blob = new Blob(["﻿" + linee.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: nomeFile });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ------------------------------------------------------------------
  // Eventi
  // ------------------------------------------------------------------
  function collegaEventi() {
    $("form-login").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const btn = $("login-btn");
      btn.disabled = true;
      $("login-errore").hidden = true;
      const { data, error } = await sb.auth.signInWithPassword({
        email: $("login-email").value.trim(), password: $("login-password").value,
      });
      btn.disabled = false;
      if (error) { mostraLogin(erroreLeggibile(error)); return; }
      $("login-password").value = "";
      await entra(data.user);
    });
    $("logout-btn").addEventListener("click", () => sb.auth.signOut());

    document.querySelectorAll(".tabbar button").forEach((b) => b.addEventListener("click", () => vaiA(b.dataset.goto)));
    document.querySelectorAll('input[name="tipo"]').forEach((r) => r.addEventListener("change", aggiornaTipo));
    $("form-mov").addEventListener("submit", salvaMovimento);
    $("annulla-modifica").addEventListener("click", () => {
      const daCanone = !!state.pendingCanone;
      resetForm(false);
      if (!daCanone) vaiA("movimenti");
    });
    $("nuovo-canone-btn").addEventListener("click", () => apriFormCanone(null));
    $("can-annulla").addEventListener("click", chiudiFormCanone);
    $("form-canone-def").addEventListener("submit", salvaCanone);
    $("elimina-btn").addEventListener("click", () => ($("conferma-elimina").hidden = false));
    $("conferma-elimina-no").addEventListener("click", () => ($("conferma-elimina").hidden = true));
    $("conferma-elimina-si").addEventListener("click", eliminaMovimento);

    $("mese-prec").addEventListener("click", () => { state.mese = spostaMese(state.mese, state.vista === "anno" ? -12 : -1); renderTutto(); });
    $("mese-succ").addEventListener("click", () => { state.mese = spostaMese(state.mese, state.vista === "anno" ? 12 : 1); renderTutto(); });
    $("mese").addEventListener("click", () => { state.mese = meseCorrente(); renderTutto(); });
    $("vista-mese").addEventListener("click", () => { state.vista = "mese"; renderTutto(); });
    $("vista-anno").addEventListener("click", () => { state.vista = "anno"; renderTutto(); });

    $("filtro-tipo").addEventListener("change", renderLista);
    $("filtro-categoria").addEventListener("change", renderLista);
    $("filtro-persona").addEventListener("change", renderLista);
    $("form-categoria").addEventListener("submit", aggiungiCategoria);

    $("export-periodo").addEventListener("click", () => {
      const { da, a } = periodo();
      esportaCSV(movimentiNelPeriodo(), "spese_" + da + "_" + a + ".csv");
    });
    $("export-tutto").addEventListener("click", () => esportaCSV(state.movimenti, "spese_tutte_" + oggiISO() + ".csv"));

    // Quando si torna sull'app (es. dal telefono), ricarica i dati inseriti dall'altro.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && state.user && !$("schermo-app").hidden &&
          Date.now() - state.ultimoCaricamento > 15000) caricaTutto();
    });
  }

  document.addEventListener("DOMContentLoaded", avvia);
})();
