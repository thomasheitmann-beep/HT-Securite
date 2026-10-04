import { useState, useEffect, useRef, useMemo } from "react";
import { collection, doc, onSnapshot, setDoc, deleteDoc, getDocs, writeBatch } from "firebase/firestore";
import { db, auth, logout } from "./firebase";

/* ============================================================
   HT-Maintenance — Attestations de consignation & Plans de prévention
   Même principe que les autres apps HT : React + Tailwind, stockage local
   (à brancher ensuite sur Firebase "ht-maintenance" comme devis/factures)
   ============================================================ */

// Firestore (projet partagé "ht-maintenance") : un document par attestation / plan
const COL = "ht-consignation-docs";
const CLI_COL = "ht-consignation-clients"; // ancien stockage propre à l'app (lu une seule fois pour la migration)
const SHARED_COL = "contacts-ht-maintenance"; // base contacts commune à toutes les apps HT

/* ---------------- Base contacts partagée (même logique que HT-Devis-Facture) ---------------- */

// Lit tous les documents de la collection commune : [{ id, societe, contact, adresse, cp, ville, email, telephone, ... }]
async function loadContactsShared() {
  const snap = await getDocs(collection(db, SHARED_COL));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// Compare les deux listes par id et n'écrit que les ajouts/modifications (set) et suppressions (delete), par lots de 450
async function syncContactsToShared(newClients, previousClients) {
  const prev = new Map(previousClients.map((c) => [c.id, c]));
  const next = new Map(newClients.map((c) => [c.id, c]));
  const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
  const ops = [];
  for (const [id, c] of next) {
    const { id: _id, ...fields } = c;
    const old = prev.get(id);
    if (!old) ops.push({ type: "set", id, fields });
    else { const { id: _o, ...oldFields } = old; if (!same(fields, oldFields)) ops.push({ type: "set", id, fields }); }
  }
  for (const id of prev.keys()) if (!next.has(id)) ops.push({ type: "delete", id });
  for (let i = 0; i < ops.length; i += 450) {
    const batch = writeBatch(db);
    ops.slice(i, i + 450).forEach((op) => {
      const ref = doc(db, SHARED_COL, op.id);
      op.type === "set" ? batch.set(ref, op.fields) : batch.delete(ref);
    });
    await batch.commit();
  }
  return ops.length;
}

// Dans cette app, un client peut avoir plusieurs contacts : on les regroupe par société.
// Dans la base commune, chaque contact reste un document à plat (même format que Devis/Factures).
const normKey = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
// Téléphones : liste typée [{ type: "Fixe" | "Mobile", numero }]
const TEL_TYPES = ["Mobile", "Fixe"];
const guessTelType = (n) => (/^(\+33\s?|0033\s?|0)[67]/.test(String(n).replace(/[\s.\-]/g, "")) ? "Mobile" : "Fixe");
const readTels = (r) => {
  if (Array.isArray(r.telephones)) return r.telephones.map((t) => ({ type: TEL_TYPES.includes(t?.type) ? t.type : guessTelType(t?.numero || ""), numero: String(t?.numero || "") }));
  if (r.telephone || r.tel) return [{ type: guessTelType(r.telephone || r.tel), numero: String(r.telephone || r.tel) }]; // ancien champ texte
  return [];
};
const cleanTels = (tels) => (tels || []).map((t) => ({ type: t.type, numero: t.numero.trim() })).filter((t) => t.numero);
const telsText = (tels) => cleanTels(tels).map((t) => `${t.type} ${t.numero}`).join(" · ");
const hasContent = (x) => !!((x.nom || "").trim() || (x.email || "").trim() || cleanTels(x.tels).length);

// Champs connus : tout autre champ présent sur un document (ex. "code") est conservé tel quel
const KNOWN = ["id", "societe", "contact", "adresse", "cp", "ville", "pays", "email", "telephones", "telephone", "tel", "fonction", "notes"];
const extrasOf = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => !KNOWN.includes(k)));

function groupShared(records) {
  const groups = new Map();
  for (const r of records) {
    const k = normKey(r.societe) || "#" + r.id;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.values()].map((g) => {
    g.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const f = g[0];
    const contacts = g.map((r) => ({ id: r.id, nom: r.contact || "", email: r.email || "", tels: readTels(r), _extra: extrasOf(r) }));
    const real = contacts.filter(hasContent);
    return {
      id: f.id, nom: f.societe || "", adresse: f.adresse || "", cp: f.cp || "", ville: f.ville || "", pays: f.pays || "",
      contacts: real.length ? real : contacts.slice(0, 1),
    };
  });
}

function flattenClients(clients) {
  return clients.flatMap((c) => {
    const base = { societe: c.nom || "", adresse: c.adresse || "", cp: c.cp || "", ville: c.ville || "", pays: c.pays || "" };
    const cts = c.contacts.filter(hasContent);
    if (!cts.length) return [{ ...(c.contacts[0]?._extra || {}), id: c.id, ...base, contact: "", email: "", telephones: [] }];
    return cts.map((x) => ({ ...(x._extra || {}), id: x.id, ...base, contact: x.nom || "", email: x.email || "", telephones: cleanTels(x.tels) }));
  });
}

const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
const today = () => new Date().toISOString().slice(0, 10);
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString("fr-FR") : "");
const fmtDT = (s) => (s ? new Date(s).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "");
const getIn = (o, p) => p.reduce((a, k) => (a == null ? a : a[k]), o);
const setIn = (o, [k, ...rest], v) => {
  const c = Array.isArray(o) ? [...o] : { ...(o || {}) };
  c[k] = rest.length ? setIn(o?.[k] ?? (typeof rest[0] === "number" ? [] : {}), rest, v) : v;
  return c;
};

const C = { ink: "#17212b", steel: "#33475b", bg: "#eceff2", yellow: "#f5c400", red: "#c8102e", green: "#1f7a3a", blue: "#1d4ed8" };

/* ---------------- Données de référence ---------------- */

const RISQUES_EU = ["Gaz", "Fluide (pression ou T°)", "Produits inflammables", "Travail isolé", "Vapeur", "Trafic (route, rail, engin)", "Contraintes climatiques", "Travail de nuit", "Explosifs", "Produits dangereux", "Électrique", "Bruits", "Travail en hauteur"];
const RISQUES_EE = ["Produits inflammables", "Appareil non accessible", "Travail en hauteur", "Manutention", "Travaux par point chaud", "Travail de fouille", "Produits dangereux", "Groupe électrogène", "Électrique", "Bruits", "Levage"];

const ANALYSE = [
  { k: "atmo", r: "Ambiance atmosphérique", c: ["Présence de poussières", "Vapeur", "Aérosol", "Fumée"], m: ["Port des EPI (masque, lunettes, gants…)"] },
  { k: "lum", r: "Ambiance lumineuse", c: ["Manque de lumière dans le poste"], m: ["Utilisation d'un éclairage adapté"] },
  { k: "clim", r: "Conditions climatiques", c: ["Forte chaleur en été", "Pluies", "Vents", "Foudre", "Température hivernale"], m: ["Organisation du travail", "Droit de retrait", "Hydratation et pauses régulières", "Port de vêtements adaptés"] },
  { k: "son", r: "Ambiance sonore", c: ["Environnement de travail bruyant", "Process client", "Outillage électroportatif"], m: ["Utilisation du casque antibruit", "Bouchons d'oreilles"] },
  { k: "chim", r: "Chimique", c: ["Utilisation de solvant", "Projection d'huile de transformateur", "Présence de fûts", "Présence PCB – SF6"], m: ["Respect des procédures", "Port des EPI (masque de fuite, gants…)", "Connaissance des FDS", "Ventilation du local"] },
  { k: "plain", r: "Chute de plain-pied", c: ["Présence de câbles, d'obstacles au sol", "Sol glissant, irrégulier", "Présence de tranchée, caniveau", "Faux plancher"], m: ["Organisation du chantier", "Utilisation des voies piétonnes", "Rangement, balisage", "Éclairage adapté", "Port des EPI"] },
  { k: "haut", r: "Chute de hauteur", c: ["Travail en hauteur"], m: ["Utilisation de harnais et longe (conforme)", "Escabeau sécurisé", "EPI (chaussures de sécurité hautes…)"] },
  { k: "objet", r: "Chute d'objet", c: ["Chute de matériaux en cours d'installation", "Chute de matériel"], m: ["Organisation du chantier", "EPI (casque…)", "Balisage de la zone de travail"] },
  { k: "route", r: "Risques routiers", c: ["Comportement au volant", "Stationnement", "Engins de chantier", "Obstacles : tranchée, piétons…"], m: ["Respect du code de la route, du plan de circulation et des règles du site (stationnement prêt à partir)"] },
  { k: "elec", r: "Électrique", c: ["Voisinage tension", "Consignation", "Matériel défectueux", "Absence de plan (ou pas à jour)", "Retour de courant", "Coactivité"], m: ["Habilitation", "Balisage", "Identifier les zones sous tension", "VAT, MALT", "EPI", "Organisation du chantier, coffret 30 mA"] },
  { k: "amiante", r: "Amiante", c: ["Bâtiments déclarés", "Matériel et équipements avec présence"], m: ["Port des EPI adaptés (kit amiante)"] },
  { k: "tms", r: "Musculo-squelettique", c: ["Manutention manuelle de matériel lourd", "Difficulté d'accès de certains équipements", "Port de charge"], m: ["Organisation du travail", "Utilisation d'aide à la manutention", "Port des EPI (gants, chaussures…)"] },
  { k: "coup", r: "Coupure – blessure", c: ["Tôle tranchante", "Ressort", "Outillage électroportatif"], m: ["Gants anti-coupure et protections adaptées aux outillages", "Rester vigilant face aux mécanismes", "Respecter les modes opératoires et poser les condamnations adaptées"] },
  { k: "feu", r: "Incendie", c: ["Défaut d'installation", "Matériel défectueux", "Source de chaleur, solvant, étincelles"], m: ["Extincteur vérifié", "Respect des consignes de stockage et d'utilisation des solvants", "Détenir un permis de feu"] },
  { k: "coact", r: "Co-activité", c: ["Intervention à proximité du public", "Intervention d'entreprises extérieures", "Intervention d'autres services de l'EU"], m: ["Échanger sur les risques liés aux différentes activités", "Assurer la coordination des travaux", "Communiquer sur les tâches (dates, délais, contraintes, avancement)", "Limiter l'accès à la zone (balisage et information)"] },
  { k: "outil", r: "Machine, outillage électroportatif", c: ["Électrisation", "Blessure corporelle"], m: ["Vérifier le matériel utilisé, pas d'emprunt", "Porter les EPI adaptés", "Utiliser le boîtier 30 mA", "Respecter les instructions de l'outillage"] },
  { k: "isole", r: "Travail isolé", c: ["Isolement géographique, hors de vue, hors de portée de voix", "Dû au bruit, aux horaires"], m: ["Respecter l'instruction sur le travail isolé", "Formaliser dans le PdP le mode de surveillance", "Définir les moyens de communication"] },
  { k: "fluide", r: "Fluide", c: ["Pression et température dans les canalisations", "Éclatement ou rupture de canalisation"], m: ["Repérage et identification des canalisations", "Faire consigner les réseaux de fluides"] },
  { k: "manu", r: "Manutention mécanisée", c: ["Travail sous ou à proximité d'une charge en manutention", "Grue, pont roulant, chariot, transpalette…"], m: ["Gérer la co-activité", "Vérifier le balisage des zones de manutention", "Maîtriser la sous-traitance de manutention", "Vérifier les moyens de manutention"] },
  { k: "env", r: "Environnementaux", c: ["Produits dangereux pour l'environnement (huiles, graisses, lessiviels…)", "DIB et DID"], m: ["Bacs de rétention et protection des sols", "Avoir les FDS", "Tri sélectif des déchets pour traitement en filière", "Dépôt sur site client avec accord, sinon retour agence"] },
  { k: "autre", r: "Autres", c: [], m: [] },
];

/* ---------------- Modèles de documents ---------------- */

const person = (nom = "") => ({ nom, obs: "", dt: "", sig: "" });
const cut = (label) => ({ label, cadenas: "", malt: "" });

const newAC = (numero, s) => ({
  numero, date: today(), entreprise: "", adresse: "", autorisation: "", nature: "",
  eng: { delegue: false, schemas: false, defaut: false },
  schema: "", coupures: [cut("Amont"), cut("Aval"), cut("")],
  installation: "", certif: false,
  val: { eu: person(), cc: person(s.chargeConsignation), rt: person(), rt2: person() },
  fin: { rt: person(), cc: person(s.chargeConsignation), eu: person(), rt2: person() },
});

const ent = (role, nom = "") => ({ role, nom, rep: "", fonction: "", nature: "", effectif: "", sig: "" });
const newPDP = (numero, s) => ({
  numero, inspection: today(), zones: "", phases: ["", "", ""],
  entreprises: [ent("EU"), ent("EE1", [s.societe, s.adresse].filter(Boolean).join(", ")), ent("EE2"), ent("EE3")],
  op: { lieu: "", description: "", debut: "", fin: "", nb: "" },
  zone: { secteurs: "", circulation: "", restauration: "", sanitaires: "", vestiaires: "", reseau: "", stockage: "", balisageEE: "", balisageGen: "" },
  secours: { s1: "", t1: "", s2: "", t2: "", alerte: "", urgence: "", infirmerie: "" },
  rEU: {}, rEUAutres: "", rEE: {}, rEEAutres: "", analyse: {},
  salaries: Array.from({ length: 8 }, () => ({ nom: "", sig: "" })),
});

const statutOf = (doc) => {
  const d = doc.data;
  if (doc.type === "AC") {
    if (d.fin?.rt?.sig && d.fin?.cc?.sig) return { t: "Terminée", c: C.green };
    if (d.val?.cc?.sig) return { t: "Consignée", c: C.red };
    return { t: "Brouillon", c: "#6b7280" };
  }
  const eu = d.entreprises?.[0]?.sig, ee = d.entreprises?.slice(1).some((e) => e.sig);
  if (eu && ee) return { t: "Signé", c: C.green };
  return { t: "Brouillon", c: "#6b7280" };
};

const nextNumero = (docs, type) => {
  const y = new Date().getFullYear();
  const pre = `${type === "AC" ? "AC" : "PDP"}-${y}-`;
  const n = docs.filter((d) => d.data.numero?.startsWith(pre)).map((d) => parseInt(d.data.numero.slice(pre.length)) || 0);
  return pre + String((n.length ? Math.max(...n) : 0) + 1).padStart(3, "0");
};

/* ---------------- UI de base ---------------- */

function Field({ label, value, onChange, type = "text", area, placeholder, className = "" }) {
  const cls = "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-[15px] text-slate-900 focus:border-slate-700 focus:outline-none focus:ring-2 focus:ring-yellow-400/60";
  return (
    <label className={`block ${className}`}>
      {label && <span className="mb-1 block text-[13px] font-medium text-slate-600">{label}</span>}
      {area ? (
        <textarea rows={3} className={cls} value={value ?? ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input type={type} className={cls} value={value ?? ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}

function Check({ checked, onChange, children }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-md px-1 py-1.5 hover:bg-slate-50">
      <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-slate-800" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="text-[15px] leading-snug text-slate-800">{children}</span>
    </label>
  );
}

function Section({ title, hint, children }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 sm:p-5">
      <h2 className="text-lg font-semibold text-slate-900" style={{ fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: ".01em" }}>{title}</h2>
      {hint && <p className="mt-0.5 text-sm text-slate-500">{hint}</p>}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function Btn({ children, onClick, kind = "ghost", className = "", ...p }) {
  const k = {
    primary: "bg-slate-900 text-white hover:bg-slate-800",
    yellow: "bg-[#f5c400] text-slate-900 hover:bg-[#e3b500]",
    ghost: "bg-white text-slate-800 border border-slate-300 hover:bg-slate-50",
    danger: "bg-white text-red-700 border border-red-300 hover:bg-red-50",
  }[kind];
  return (
    <button onClick={onClick} className={`inline-flex items-center justify-center gap-2 rounded-md px-3.5 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 ${k} ${className}`} {...p}>
      {children}
    </button>
  );
}

/* ---------------- Zone de dessin (schéma + signatures) ---------------- */

function DrawCanvas({ value, onChange, w, h, tools, allowImport, onReady }) {
  const ref = useRef(null);
  const drawing = useRef(false);
  const last = useRef(null);
  const [tool, setTool] = useState(tools ? tools[0] : { c: "#111", lw: 3 });
  const fmt = allowImport ? ["image/jpeg", 0.85] : ["image/png"];

  const blank = (ctx) => { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); };
  useEffect(() => {
    const ctx = ref.current.getContext("2d");
    blank(ctx);
    if (value) { const img = new Image(); img.onload = () => ctx.drawImage(img, 0, 0, w, h); img.src = value; }
    onReady && onReady({ clear });
    // eslint-disable-next-line
  }, []);

  const pos = (e) => { const r = ref.current.getBoundingClientRect(); return { x: ((e.clientX - r.left) * w) / r.width, y: ((e.clientY - r.top) * h) / r.height }; };
  const down = (e) => { e.preventDefault(); ref.current.setPointerCapture(e.pointerId); drawing.current = true; last.current = pos(e); move(e); };
  const move = (e) => {
    if (!drawing.current) return;
    const ctx = ref.current.getContext("2d"), p = pos(e);
    ctx.strokeStyle = tool.c; ctx.lineWidth = tool.lw; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(last.current.x, last.current.y); ctx.lineTo(p.x + 0.01, p.y); ctx.stroke();
    last.current = p;
  };
  const up = () => { if (!drawing.current) return; drawing.current = false; onChange(ref.current.toDataURL(...fmt)); };
  const clear = () => { blank(ref.current.getContext("2d")); onChange(""); };
  const importImg = (file) => {
    if (!file) return;
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const ctx = ref.current.getContext("2d"); blank(ctx);
        const s = Math.min(w / img.width, h / img.height), iw = img.width * s, ih = img.height * s;
        ctx.drawImage(img, (w - iw) / 2, (h - ih) / 2, iw, ih);
        onChange(ref.current.toDataURL(...fmt));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  };

  return (
    <div>
      {tools && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {tools.map((t) => (
            <button key={t.n} onClick={() => setTool(t)} className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-semibold ${tool.n === t.n ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-700"}`}>
              <span className="h-3 w-3 rounded-full border border-slate-400" style={{ background: t.c }} />{t.n}
            </button>
          ))}
          <span className="flex-1" />
          {allowImport && (
            <label className="cursor-pointer rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
              Importer une photo/plan
              <input type="file" accept="image/*" className="hidden" onChange={(e) => importImg(e.target.files[0])} />
            </label>
          )}
          <button onClick={clear} className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">Effacer</button>
        </div>
      )}
      <canvas ref={ref} width={w} height={h} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
        className="block w-full rounded-md border border-slate-300 bg-white" style={{ touchAction: "none", aspectRatio: `${w}/${h}` }} />
    </div>
  );
}

function SignatureField({ label, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [tmp, setTmp] = useState(value);
  const api = useRef(null);
  return (
    <div>
      {label && <span className="mb-1 block text-[13px] font-medium text-slate-600">{label}</span>}
      {value ? (
        <div className="flex items-center gap-2">
          <img src={value} alt="Signature" className="h-14 rounded border border-slate-300 bg-white" />
          <button className="text-xs font-semibold text-slate-600 underline" onClick={() => { setTmp(value); setOpen(true); }}>Refaire</button>
          <button className="text-xs font-semibold text-red-700 underline" onClick={() => onChange("")}>Retirer</button>
        </div>
      ) : (
        <button onClick={() => { setTmp(""); setOpen(true); }} className="h-14 w-full max-w-xs rounded-md border-2 border-dashed border-slate-300 text-sm font-semibold text-slate-500 hover:border-slate-500 hover:text-slate-700">
          Signer
        </button>
      )}
      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/60 p-3 sm:items-center" onClick={() => setOpen(false)}>
          <div className="w-full max-w-lg rounded-lg bg-white p-4" onClick={(e) => e.stopPropagation()}>
            <p className="mb-2 font-semibold text-slate-900">{label || "Signature"}</p>
            <DrawCanvas value={tmp} onChange={setTmp} w={600} h={220} onReady={(a) => (api.current = a)} />
            <div className="mt-3 flex justify-between gap-2">
              <Btn onClick={() => api.current?.clear()}>Effacer</Btn>
              <div className="flex gap-2">
                <Btn onClick={() => setOpen(false)}>Annuler</Btn>
                <Btn kind="primary" onClick={() => { onChange(tmp); setOpen(false); }}>Valider la signature</Btn>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PersonBlock({ title, text, bind, path, noObs }) {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50/60 p-3">
      <p className="font-semibold text-slate-900">{title}</p>
      {text && <p className="mt-1 text-[13px] leading-snug text-slate-600">{text}</p>}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Nom" {...bind([...path, "nom"])} />
        <Field label="Date et heure" type="datetime-local" {...bind([...path, "dt"])} />
        {!noObs && <Field label="Observations" className="sm:col-span-2" {...bind([...path, "obs"])} />}
        <div className="sm:col-span-2"><SignatureField label="Signature" {...bind([...path, "sig"])} /></div>
      </div>
      <button className="mt-2 text-xs font-semibold text-slate-600 underline" onClick={() => bind([...path, "dt"]).onChange(new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16))}>
        Maintenant
      </button>
    </div>
  );
}

/* ---------------- Éditeur : Attestation de consignation ---------------- */

const TXT = {
  delegue: "Le représentant de l'entreprise utilisatrice demande au chargé de consignation HT-Maintenance d'assurer la fonction de chargé d'exploitation délégué, dans le cadre des opérations de manœuvres nécessaires à la consignation, sous sa responsabilité.",
  schemas: "Schémas ou plans de l'installation non fournis.",
  defaut: "Attestation de consignation réalisée par défaut de chargé de consignation.",
  certif: "Après avoir communiqué l'ensemble des données techniques à jour, nécessaires aux travaux (schémas – source autonome – asservissements), le chef d'établissement ou son représentant :",
  certifItems: [
    "Demande au chargé de consignation d'assurer la prévention des risques électriques liés à la réalisation des opérations citées.",
    "Certifie qu'aucune entreprise autre que la société HT-Maintenance n'intervient sur les équipements concernés par les opérations citées.",
    "Reste responsable des accès aux installations et aux équipements non délégués.",
  ],
  certifFin: "Assure qu'en cas d'incident consécutif à un vice caché de ses appareils ou à la vétusté de l'installation, la responsabilité de la société HT-Maintenance ne sera pas recherchée.",
  cc: "Par l'apposition de sa signature, le chargé de consignation atteste de la réalisation des actions telles que définies ci-dessus. Il livre au responsable une attestation de consignation.",
  rt: "Le responsable de travaux doit considérer comme étant en exploitation toute installation autre que celle certifiée par la présente. Par l'apposition de sa signature, il s'engage à respecter et à faire respecter les prescriptions de sécurité correspondantes à la présente prestation. Il pourra travailler après avoir pris les mesures de sécurité qui lui incombent.",
  rt2: "Comme indiqué sur l'autorisation de travail de rattachement, le responsable de travaux désigné ci-contre est remplacé. Par l'apposition de sa signature, le nouveau responsable de travaux atteste qu'il a pris les dispositions de sécurité qui lui incombent.",
  fin: "Par l'apposition de sa signature, le responsable de travaux indique que les travaux désignés sont terminés. Il atteste qu'il a pris les dispositions de sécurité qui lui incombent avant de quitter les lieux. Après s'être assuré qu'aucun intervenant n'accède aux installations électriques, il demande au chargé de consignation d'assurer le rôle de personnel de manœuvre pour fermer le/les organes afin de remettre sous tension les installations.",
  erdf: "Dans le cas d'une séparation de réseau Enedis (ERDF), il est formellement interdit de travailler sur le compartiment câbles des cellules d'arrivée.",
};

const SKETCH_TOOLS = [
  { n: "Trait", c: "#111111", lw: 3 },
  { n: "Sous tension", c: C.red, lw: 5 },
  { n: "Hors tension", c: C.green, lw: 5 },
  { n: "MALT", c: C.blue, lw: 5 },
  { n: "Gomme", c: "#ffffff", lw: 26 },
];

function EditAC({ data, bind, setData, clients, onManage, onAddClient, onAddContact }) {
  return (
    <div className="space-y-4">
      <ClientPicker clients={clients} data={data} setData={setData} type="AC" onManage={onManage} onAddClient={onAddClient} onAddContact={onAddContact} />
      <Section title="Identification">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Numéro d'attestation" {...bind(["numero"])} />
          <Field label="Date" type="date" {...bind(["date"])} />
          <Field label="Entreprise chargée des travaux" {...bind(["entreprise"])} />
          <Field label="Autorisation de travail attachée" {...bind(["autorisation"])} />
          <Field label="Adresse du chantier" className="sm:col-span-2" {...bind(["adresse"])} />
          <Field label="Nature des travaux" area className="sm:col-span-2" {...bind(["nature"])} />
        </div>
      </Section>

      <Section title="Engagement">
        <Check checked={data.eng.delegue} onChange={(v) => bind(["eng", "delegue"]).onChange(v)}>{TXT.delegue}</Check>
        <Check checked={data.eng.schemas} onChange={(v) => bind(["eng", "schemas"]).onChange(v)}>{TXT.schemas}</Check>
        <Check checked={data.eng.defaut} onChange={(v) => bind(["eng", "defaut"]).onChange(v)}>{TXT.defaut}</Check>
      </Section>

      <Section title="Schéma de l'installation" hint="Zones hors tension / sous tension et mises à la terre. Dessinez au doigt ou importez une photo du schéma, puis annotez.">
        <DrawCanvas value={data.schema} onChange={(v) => bind(["schema"]).onChange(v)} w={1200} h={700} tools={SKETCH_TOOLS} allowImport />
      </Section>

      <Section title="Cadenas et séparations">
        {data.coupures.map((c, i) => (
          <div key={i} className="grid items-end gap-3 rounded-md border border-slate-200 p-3 sm:grid-cols-[1fr_1fr_auto]">
            <Field label="Point de coupure" placeholder="Amont, aval…" {...bind(["coupures", i, "label"])} />
            <Field label="Cadenas n°" {...bind(["coupures", i, "cadenas"])} />
            <div className="flex gap-1.5">
              {[["sans", "Séparé sans MALT"], ["avec", "Séparé avec MALT"]].map(([v, l]) => (
                <button key={v} onClick={() => bind(["coupures", i, "malt"]).onChange(c.malt === v ? "" : v)}
                  className={`rounded-md border px-3 py-2 text-xs font-semibold ${c.malt === v ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-700"}`}>{l}</button>
              ))}
            </div>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <Btn onClick={() => setData((d) => ({ ...d, coupures: [...d.coupures, cut("")] }))}>Ajouter un point de coupure</Btn>
          {data.coupures.length > 1 && <Btn kind="danger" onClick={() => setData((d) => ({ ...d, coupures: d.coupures.slice(0, -1) }))}>Retirer le dernier</Btn>}
        </div>
        <p className="rounded-md border-l-4 border-red-600 bg-red-50 px-3 py-2 text-sm text-red-900">{TXT.erdf}</p>
      </Section>

      <Section title="Installation et/ou équipements compris entre">
        <Field area {...bind(["installation"])} placeholder="Ex. : cellule arrivée C1 et TGBT, disjoncteur général ouvert et condamné…" />
        <Check checked={data.certif} onChange={(v) => bind(["certif"]).onChange(v)}>
          <span>{TXT.certif}</span>
          <ul className="mt-1 list-disc pl-5 text-[14px] text-slate-700">{TXT.certifItems.map((t) => <li key={t}>{t}</li>)}</ul>
          <span className="mt-1 block text-[14px] text-slate-700">{TXT.certifFin}</span>
        </Check>
      </Section>

      <Section title="Validation">
        <PersonBlock title="Représentant de l'entreprise utilisatrice" bind={bind} path={["val", "eu"]} />
        <PersonBlock title="Chargé de consignation" text={TXT.cc} bind={bind} path={["val", "cc"]} />
        <PersonBlock title="Responsable de travaux" text={TXT.rt} bind={bind} path={["val", "rt"]} />
        <PersonBlock title="Changement de responsable de travaux" text={TXT.rt2} bind={bind} path={["val", "rt2"]} />
      </Section>

      <Section title="Fin de travaux">
        <PersonBlock title="Responsable de travaux — fin de travaux" text={TXT.fin} bind={bind} path={["fin", "rt"]} noObs />
        <PersonBlock title="Chargé de consignation — remise sous tension" bind={bind} path={["fin", "cc"]} />
        <PersonBlock title="Représentant de l'entreprise utilisatrice" bind={bind} path={["fin", "eu"]} />
        <PersonBlock title="Nouveau responsable de travaux (si changement)" bind={bind} path={["fin", "rt2"]} />
      </Section>
    </div>
  );
}

/* ---------------- Éditeur : Plan de prévention ---------------- */

function EditPDP({ data, bind, setData, clients, onManage, onAddClient, onAddContact }) {
  const toggleOff = (k, id) => setData((d) => {
    const a = d.analyse[k] || { on: false, off: [], note: "" };
    const off = a.off.includes(id) ? a.off.filter((x) => x !== id) : [...a.off, id];
    return setIn(d, ["analyse", k], { ...a, off });
  });
  return (
    <div className="space-y-4">
      <ClientPicker clients={clients} data={data} setData={setData} type="PDP" onManage={onManage} onAddClient={onAddClient} onAddContact={onAddContact} />
      <Section title="Réalisation d'une affaire">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Numéro de dossier" {...bind(["numero"])} />
          <Field label="Inspection commune préalable des lieux du" type="date" {...bind(["inspection"])} />
          <Field label="Zone(s) concernée(s)" className="sm:col-span-2" {...bind(["zones"])} />
        </div>
      </Section>

      <Section title="Phases de travaux successives">
        {data.phases.map((p, i) => (
          <Field key={i} label={`Phase ${i + 1}`} {...bind(["phases", i])} />
        ))}
        <div className="flex gap-2">
          <Btn onClick={() => setData((d) => ({ ...d, phases: [...d.phases, ""] }))}>Ajouter une phase</Btn>
          {data.phases.length > 1 && <Btn kind="danger" onClick={() => setData((d) => ({ ...d, phases: d.phases.slice(0, -1) }))}>Retirer la dernière</Btn>}
        </div>
      </Section>

      <Section title="Entreprises" hint="Il a été convenu entre l'entreprise utilisatrice (EU) et les entreprises extérieures (EE) ci-dessous.">
        {data.entreprises.map((e, i) => (
          <div key={i} className="rounded-md border border-slate-200 p-3">
            <p className="mb-2 inline-block rounded bg-slate-900 px-2 py-0.5 text-xs font-bold text-white">{e.role}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Entreprise (nom, adresse)" className="sm:col-span-2" {...bind(["entreprises", i, "nom"])} />
              <Field label="Représentée par (nom, prénom)" {...bind(["entreprises", i, "rep"])} />
              <Field label="Fonction" {...bind(["entreprises", i, "fonction"])} />
              <Field label="Nature des travaux" {...bind(["entreprises", i, "nature"])} />
              <Field label="Effectif" type="number" {...bind(["entreprises", i, "effectif"])} />
              <div className="sm:col-span-2"><SignatureField label="Signature" {...bind(["entreprises", i, "sig"])} /></div>
            </div>
          </div>
        ))}
        <Btn onClick={() => setData((d) => ({ ...d, entreprises: [...d.entreprises, ent(`EE${d.entreprises.length}`)] }))}>Ajouter une entreprise extérieure</Btn>
      </Section>

      <Section title="Opération globale">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Lieu" className="sm:col-span-2" {...bind(["op", "lieu"])} />
          <Field label="Description de l'opération" area className="sm:col-span-2" {...bind(["op", "description"])} />
          <Field label="Début prévisible" type="datetime-local" {...bind(["op", "debut"])} />
          <Field label="Fin prévisible" type="datetime-local" {...bind(["op", "fin"])} />
          <Field label="Nombre de salariés prévisibles" type="number" {...bind(["op", "nb"])} />
        </div>
      </Section>

      <Section title="Zone d'intervention">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Secteur(s) d'intervention" area className="sm:col-span-2" {...bind(["zone", "secteurs"])} />
          <Field label="Contraintes de circulation" area className="sm:col-span-2" {...bind(["zone", "circulation"])} />
        </div>
        <p className="text-sm font-semibold text-slate-700">Installations et matériels mis à disposition par l'entreprise utilisatrice</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Lieu de restauration" {...bind(["zone", "restauration"])} />
          <Field label="Sanitaires" {...bind(["zone", "sanitaires"])} />
          <Field label="Vestiaires" {...bind(["zone", "vestiaires"])} />
          <Field label="Accès au réseau électrique" {...bind(["zone", "reseau"])} />
          <Field label="Aire de stockage matériel" className="sm:col-span-2" {...bind(["zone", "stockage"])} />
          <Field label="Balisage — EE entreprise" {...bind(["zone", "balisageEE"])} />
          <Field label="Ou balisage général à charge de M." {...bind(["zone", "balisageGen"])} />
        </div>
      </Section>

      <Section title="Organisation des secours">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Secouriste 1 — M." {...bind(["secours", "s1"])} />
          <Field label="Tél." type="tel" {...bind(["secours", "t1"])} />
          <Field label="Secouriste 2 — M." {...bind(["secours", "s2"])} />
          <Field label="Tél." type="tel" {...bind(["secours", "t2"])} />
          <Field label="Moyens d'alerte" className="sm:col-span-2" {...bind(["secours", "alerte"])} />
          <Field label="Numéro d'urgence" type="tel" {...bind(["secours", "urgence"])} />
          <Field label="Infirmerie — tél." type="tel" {...bind(["secours", "infirmerie"])} />
        </div>
      </Section>

      <Section title="Risques propres à l'entreprise utilisatrice" hint="Pouvant affecter l'entreprise extérieure et les sous-traitants.">
        <div className="grid gap-x-4 sm:grid-cols-2">
          {RISQUES_EU.map((r) => <Check key={r} checked={data.rEU[r]} onChange={(v) => bind(["rEU", r]).onChange(v)}>{r}</Check>)}
        </div>
        <Field label="Autres" {...bind(["rEUAutres"])} />
      </Section>

      <Section title="Risques propres à l'entreprise extérieure" hint="Pouvant affecter l'entreprise utilisatrice et les sous-traitants.">
        <div className="grid gap-x-4 sm:grid-cols-2">
          {RISQUES_EE.map((r) => <Check key={r} checked={data.rEE[r]} onChange={(v) => bind(["rEE", r]).onChange(v)}>{r}</Check>)}
        </div>
        <Field label="Autres" {...bind(["rEEAutres"])} />
      </Section>

      <Section title="Évaluation des risques liés à l'intervention" hint="Cochez le risque, puis touchez une cause ou une mesure pour la rayer si elle ne s'applique pas.">
        {ANALYSE.map((a) => {
          const st = data.analyse[a.k] || { on: false, off: [], note: "" };
          return (
            <div key={a.k} className={`rounded-md border p-3 ${st.on ? "border-slate-800 bg-yellow-50/60" : "border-slate-200"}`}>
              <Check checked={st.on} onChange={(v) => setData((d) => setIn(d, ["analyse", a.k], { ...st, on: v }))}><b>{a.r}</b></Check>
              {st.on && (
                <div className="mt-2 grid gap-3 pl-8 sm:grid-cols-2">
                  {[["c", "Causes potentielles", a.c], ["m", "Mesures de prévention", a.m]].map(([p, t, items]) => items.length > 0 && (
                    <div key={p}>
                      <p className="mb-1 text-xs font-semibold text-slate-500">{t}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {items.map((it, i) => {
                          const off = st.off.includes(p + i);
                          return (
                            <button key={i} onClick={() => toggleOff(a.k, p + i)}
                              className={`rounded border px-2 py-1 text-left text-[13px] ${off ? "border-slate-200 text-slate-400 line-through" : "border-slate-400 bg-white text-slate-800"}`}>{it}</button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                  <Field label="Complément" className="sm:col-span-2" value={st.note} onChange={(v) => setData((d) => setIn(d, ["analyse", a.k], { ...st, note: v }))} />
                </div>
              )}
            </div>
          );
        })}
      </Section>

      <Section title="Prise en compte du plan de prévention">
        <div className="grid gap-3 sm:grid-cols-2">
          {data.salaries.map((s, i) => (
            <div key={i} className="rounded-md border border-slate-200 p-3">
              <Field label={`Salarié ${i + 1}`} {...bind(["salaries", i, "nom"])} />
              <div className="mt-2"><SignatureField {...bind(["salaries", i, "sig"])} label="" /></div>
            </div>
          ))}
        </div>
        <Btn onClick={() => setData((d) => ({ ...d, salaries: [...d.salaries, { nom: "", sig: "" }] }))}>Ajouter un salarié</Btn>
      </Section>
    </div>
  );
}

/* ---------------- Mise en page imprimable (A4) ---------------- */

const box = "border border-black";
const cell = "border border-black px-1.5 py-1 align-top";
const Tick = ({ on }) => <span className="inline-block w-4 font-bold">{on ? "☑" : "☐"}</span>;

function SheetHeader({ title, sub, numero, settings }) {
  return (
    <table className="mb-2 w-full border-collapse">
      <tbody>
        <tr>
          <td className={`${cell} w-[28%] align-middle`}>
            {settings.logo
              ? <img src={settings.logo} alt={settings.societe || "HT-Maintenance"} className="mb-0.5 max-h-12 max-w-full object-contain" />
              : <div className="text-[15px] font-bold" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>{settings.societe || "HT-Maintenance"}</div>}
            <div className="text-[9px] leading-tight">{settings.adresse}</div>
            <div className="text-[9px]">{settings.tel}</div>
          </td>
          <td className={`${cell} text-center align-middle`}>
            <div className="text-[17px] font-bold uppercase" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>{title}</div>
            {sub && <div className="text-[10px]">{sub}</div>}
          </td>
          <td className={`${cell} w-[20%] text-center align-middle`}>
            <div className="text-[9px]">N°</div><div className="text-[12px] font-bold">{numero}</div>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

const Sig = ({ p, withObs = true }) => (
  <div className="mt-1 space-y-0.5 text-[9.5px]">
    <div><u>Nom :</u> {p.nom}</div>
    {withObs && <div><u>Observations :</u> {p.obs}</div>}
    <div><u>Date et heure :</u> {fmtDT(p.dt)}</div>
    <div><u>Signature :</u></div>
    <div className="h-12">{p.sig && <img src={p.sig} alt="" className="h-12" />}</div>
  </div>
);

function PrintAC({ d, settings }) {
  return (
    <div className="sheet">
      <SheetHeader title="Attestation de consignation" sub="Conformément à la NF C18-510" numero={d.numero} settings={settings} />
      <table className="w-full border-collapse text-[10px]">
        <tbody>
          <tr><td className={`${cell} w-[22%] font-bold`}>Numéro d'attestation</td><td className={cell}>{d.numero} — {fmtDate(d.date)}</td><td className={`${cell} w-[22%] font-bold`}>Entreprise chargée des travaux</td><td className={cell}>{d.entreprise}</td></tr>
          <tr><td className={`${cell} font-bold`}>Adresse du chantier</td><td className={cell}>{d.adresse}</td><td className={`${cell} font-bold`}>Autorisation de travail attachée</td><td className={cell}>{d.autorisation}</td></tr>
          <tr><td className={`${cell} font-bold`}>Nature des travaux</td><td className={cell} colSpan={3}>{d.nature}</td></tr>
        </tbody>
      </table>

      <div className="mt-2 text-[10px]">
        <p className="font-bold underline">Engagement :</p>
        <p><Tick on={d.eng.delegue} /> {TXT.delegue}</p>
        <p><Tick on={d.eng.schemas} /> {TXT.schemas}</p>
        <p><Tick on={d.eng.defaut} /> {TXT.defaut}</p>
      </div>

      <table className="mt-2 w-full border-collapse text-[10px]">
        <tbody>
          <tr><td className={`${cell} font-bold`}>Schéma de l'installation indiquant les zones hors tension / sous tension et les MALT</td><td className={`${cell} w-[26%] font-bold`}>Cadenas</td></tr>
          <tr>
            <td className={`${cell} h-[240px] p-1 text-center align-middle`}>{d.schema && <img src={d.schema} alt="" className="mx-auto max-h-[235px] max-w-full" />}</td>
            <td className={cell}>
              {d.coupures.map((c, i) => (
                <div key={i} className="mb-2">
                  <div className="font-semibold">{c.label ? `${c.label} / ` : ""}Cadenas n° {c.cadenas}</div>
                  <div><Tick on={c.malt === "sans"} /> Séparé sans MALT</div>
                  <div><Tick on={c.malt === "avec"} /> Séparé avec MALT</div>
                </div>
              ))}
              <p className="mt-2 text-[8.5px] italic">{TXT.erdf}</p>
            </td>
          </tr>
          <tr><td className={`${cell} font-bold`} colSpan={2}>Installation et/ou équipements compris entre :</td></tr>
          <tr><td className={`${cell} h-8`} colSpan={2}>{d.installation}</td></tr>
          <tr>
            <td className={cell} colSpan={2}>
              <p><Tick on={d.certif} /> {TXT.certif}</p>
              <ul className="list-disc pl-6">{TXT.certifItems.map((t) => <li key={t}>{t}</li>)}</ul>
              <p>{TXT.certifFin}</p>
            </td>
          </tr>
        </tbody>
      </table>

      <table className="mt-2 w-full table-fixed border-collapse text-[9.5px]">
        <tbody>
          <tr><td className={`${cell} text-center font-bold`} colSpan={4}>VALIDATION</td></tr>
          <tr>
            <td className={cell}><b><u>Représentant de l'entreprise utilisatrice</u></b><Sig p={d.val.eu} /></td>
            <td className={cell}><b><u>Chargé de consignation</u></b><p className="text-[8.5px]">{TXT.cc}</p><Sig p={d.val.cc} /></td>
            <td className={cell}><b><u>Responsable de travaux</u></b><p className="text-[8.5px]">{TXT.rt}</p><Sig p={d.val.rt} /></td>
            <td className={cell}><b><u>Changement de responsable de travaux</u></b><p className="text-[8.5px]">{TXT.rt2}</p><Sig p={d.val.rt2} /></td>
          </tr>
          <tr><td className={`${cell} text-center font-bold`} colSpan={4}>FIN DE TRAVAUX</td></tr>
          <tr>
            <td className={cell}><p className="text-[8.5px]">{TXT.fin}</p><Sig p={d.fin.rt} withObs={false} /></td>
            <td className={cell}><b>Chargé de consignation</b><Sig p={d.fin.cc} /></td>
            <td className={cell}><b>Représentant EU</b><Sig p={d.fin.eu} /></td>
            <td className={cell}><b>Nouveau responsable de travaux</b><Sig p={d.fin.rt2} /></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function PrintPDP({ d, settings }) {
  const H = ({ children }) => <p className="mt-3 mb-1 text-[11px] font-bold">{children}</p>;
  const L = ({ l, v }) => <div><span className="font-semibold">{l} :</span> {v}</div>;
  return (
    <>
    <div className="sheet">
      <SheetHeader title="Plan de prévention" sub="Document établi à l'initiative de l'entreprise utilisatrice — Réalisation d'une affaire" numero={d.numero} settings={settings} />
      <div className="text-[10px]">
        <L l="Numéro de dossier" v={d.numero} />
        <L l="Inspection commune préalable des lieux du" v={fmtDate(d.inspection)} />
        <L l="Zone(s) concernée(s)" v={d.zones} />
        <H>Description des phases de travaux successives de l'intervention</H>
        {d.phases.map((p, i) => <L key={i} l={`Phase ${i + 1}`} v={p} />)}

        <H>Il a été convenu entre l'entreprise utilisatrice (EU) et les entreprises extérieures (EE) ci-dessous :</H>
        <table className="w-full border-collapse">
          <thead><tr className="bg-slate-100">{["", "Entreprise (nom, adresse)", "Représentée par", "Fonction", "Nature des travaux", "Effectif", "Signature"].map((h) => <th key={h} className={`${cell} text-left`}>{h}</th>)}</tr></thead>
          <tbody>
            {d.entreprises.map((e, i) => (
              <tr key={i}><td className={`${cell} font-bold`}>{e.role}</td><td className={cell}>{e.nom}</td><td className={cell}>{e.rep}</td><td className={cell}>{e.fonction}</td><td className={cell}>{e.nature}</td><td className={cell}>{e.effectif}</td><td className={`${cell} w-[90px]`}>{e.sig && <img src={e.sig} alt="" className="h-8" />}</td></tr>
            ))}
          </tbody>
        </table>

        <H>Opération globale</H>
        <div className={`${box} space-y-0.5 p-1.5`}>
          <L l="Lieu" v={d.op.lieu} /><L l="Description de l'opération" v={d.op.description} />
          <L l="Début prévisible" v={fmtDT(d.op.debut)} /><L l="Fin prévisible" v={fmtDT(d.op.fin)} /><L l="Nombre de salariés prévisibles" v={d.op.nb} />
        </div>

        <H>Zone d'intervention</H>
        <div className={`${box} space-y-0.5 p-1.5`}>
          <L l="Secteur(s) d'intervention" v={d.zone.secteurs} /><L l="Contraintes de circulation" v={d.zone.circulation} />
          <p className="font-semibold underline">Installations et matériels mis à disposition par l'entreprise utilisatrice :</p>
          <L l="Lieu de restauration" v={d.zone.restauration} /><L l="Sanitaires" v={d.zone.sanitaires} /><L l="Vestiaires" v={d.zone.vestiaires} />
          <L l="Accès au réseau électrique" v={d.zone.reseau} /><L l="Aire de stockage matériel" v={d.zone.stockage} />
          <L l="Balisage EE entreprise" v={d.zone.balisageEE} /><L l="Ou balisage général à charge de M." v={d.zone.balisageGen} />
        </div>

        <H>Organisation des secours</H>
        <div className={`${box} space-y-0.5 p-1.5`}>
          <L l="Secouristes : M." v={`${d.secours.s1}${d.secours.t1 ? " — Tél : " + d.secours.t1 : ""}`} />
          <L l="M." v={`${d.secours.s2}${d.secours.t2 ? " — Tél : " + d.secours.t2 : ""}`} />
          <L l="Moyens d'alerte" v={d.secours.alerte} /><L l="Numéro d'urgence" v={d.secours.urgence} /><L l="Infirmerie tél" v={d.secours.infirmerie} />
        </div>

        <H>Risques propres à l'entreprise utilisatrice pouvant affecter l'entreprise extérieure et sous-traitants</H>
        <div className={`${box} grid grid-cols-3 gap-x-2 p-1.5`}>
          {RISQUES_EU.map((r) => <div key={r}><Tick on={d.rEU[r]} /> {r}</div>)}
          <div className="col-span-3"><Tick on={!!d.rEUAutres} /> Autres : {d.rEUAutres}</div>
        </div>
        <H>Risques propres à l'entreprise extérieure pouvant affecter l'entreprise utilisatrice et sous-traitants</H>
        <div className={`${box} grid grid-cols-3 gap-x-2 p-1.5`}>
          {RISQUES_EE.map((r) => <div key={r}><Tick on={d.rEE[r]} /> {r}</div>)}
          <div className="col-span-3"><Tick on={!!d.rEEAutres} /> Autres : {d.rEEAutres}</div>
        </div>

      </div>
    </div>
    <div className="sheet mt-4" style={{ breakBefore: "page" }}>
      <div className="text-[10px]">
        <H>Évaluation des risques liés à l'intervention</H>
        <p className="mb-1 italic">Risques cochés ; les mentions inutiles sont rayées dans les colonnes causes potentielles et mesures de prévention.</p>
        <table className="w-full border-collapse text-[9px]">
          <thead><tr className="bg-slate-100"><th className={`${cell} w-5`} /><th className={`${cell} w-[22%] text-left`}>Risques</th><th className={`${cell} text-left`}>Causes potentielles</th><th className={`${cell} text-left`}>Mesures de prévention</th></tr></thead>
          <tbody>
            {ANALYSE.map((a) => {
              const st = d.analyse[a.k] || { on: false, off: [], note: "" };
              const list = (p, items) => items.map((it, i) => <span key={i} className={st.on && st.off.includes(p + i) ? "line-through" : ""}>{it}{i < items.length - 1 ? ", " : ""}</span>);
              return (
                <tr key={a.k} style={{ breakInside: "avoid" }}>
                  <td className={`${cell} text-center`}><Tick on={st.on} /></td>
                  <td className={`${cell} font-bold`}>{a.r}</td>
                  <td className={cell}>{list("c", a.c)}</td>
                  <td className={cell}>{list("m", a.m)}{st.note && <div className="mt-0.5 italic">{st.note}</div>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <H>Prise en compte du plan de prévention</H>
        <table className="w-full table-fixed border-collapse">
          <tbody>
            {Array.from({ length: Math.ceil(d.salaries.length / 2) }, (_, r) => (
              <tr key={r} style={{ breakInside: "avoid" }}>
                {[r, r + Math.ceil(d.salaries.length / 2)].map((i) => { const s = d.salaries[i]; return s ? (
                  <td key={i} className={`${cell} h-14`}><div className="font-semibold">Salarié {i + 1} : {s.nom}</div>{s.sig && <img src={s.sig} alt="" className="h-9" />}</td>
                ) : <td key={i} className={cell} />; })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
    </>
  );
}

/* ---------------- Clients ---------------- */

const newContact = () => ({ id: uid(), nom: "", email: "", tels: [{ type: "Mobile", numero: "" }] });
const newClient = () => { const id = uid(); return { id, nom: "", adresse: "", cp: "", ville: "", pays: "", contacts: [{ ...newContact(), id }] }; };
const contactFor = (clientId) => ({ ...newContact(), id: `${clientId}-${uid()}` });
const clientAddr = (c) => [c.adresse, [c.cp, c.ville].filter(Boolean).join(" "), c.pays].filter(Boolean).join(", ");
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || "");

const selCls = "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-[15px] text-slate-900 focus:border-slate-700 focus:outline-none focus:ring-2 focus:ring-yellow-400/60";

const norm = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const matches = (q, ...fields) => { const words = norm(q).split(/\s+/).filter(Boolean); const hay = norm(fields.join(" ")); return words.every((w) => hay.includes(w)); };

// Champ de saisie avec recherche : on tape librement, les suggestions de la base s'affichent en dessous
function Combobox({ label, value, onInput, options, onPick, placeholder, empty }) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const list = options.filter((o) => !value || matches(value, o.label, o.sub, o.extra)).slice(0, 30);
  const pick = (o) => { onPick(o); setOpen(false); };
  const onKey = (e) => {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) { setOpen(true); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, list.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter" && open && list[hi]) { e.preventDefault(); pick(list[hi]); }
    else if (e.key === "Escape") setOpen(false);
  };
  return (
    <div className="relative">
      <span className="mb-1 block text-[13px] font-medium text-slate-600">{label}</span>
      <div className="relative">
        <input className={`${selCls} pr-9`} value={value || ""} placeholder={placeholder} autoComplete="off"
          onChange={(e) => { onInput(e.target.value); setOpen(true); setHi(0); }}
          onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} onKeyDown={onKey} />
        {value && (
          <button type="button" aria-label="Effacer" className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1.5 text-lg leading-none text-slate-400 hover:text-slate-700"
            onMouseDown={(e) => e.preventDefault()} onClick={() => { onInput(""); setOpen(true); }}>×</button>
        )}
      </div>
      {open && (list.length > 0 || empty) && (
        <ul className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-slate-300 bg-white shadow-lg">
          {list.length === 0 && <li className="px-3 py-2 text-sm text-slate-500">{empty}</li>}
          {list.map((o, i) => (
            <li key={o.id}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o)} onMouseEnter={() => setHi(i)}
                className={`block w-full px-3 py-2 text-left ${i === hi ? "bg-yellow-50" : ""}`}>
                <span className="block text-[15px] font-medium text-slate-900">{o.label}</span>
                {o.sub && <span className="block text-xs text-slate-500">{o.sub}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const findClient = (clients, d) =>
  (d.contactId && clients.find((c) => c.contacts.some((x) => x.id === d.contactId))) ||
  clients.find((c) => c.id === d.clientId) ||
  (d.clientNom ? clients.find((c) => normKey(c.nom) === normKey(d.clientNom)) : null) || null;

function ClientPicker({ clients, data, setData, type, onManage, onAddClient, onAddContact }) {
  const client = findClient(clients, data);
  const contact = client?.contacts.find((x) => x.id === data.contactId);
  const clientText = data.clientNom ?? client?.nom ?? "";
  const contactText = data.contactNom ?? contact?.nom ?? "";

  const clientOptions = [...clients]
    .sort((a, b) => (a.nom || "").localeCompare(b.nom || "", "fr"))
    .map((c) => ({ id: c.id, label: c.nom || "(sans nom)", sub: clientAddr(c), extra: c.contacts.map((x) => x.nom).join(" ") }));
  // Sans client choisi, on cherche le contact dans toute la base (il amène son client avec lui)
  const contactOptions = client
    ? client.contacts.filter(hasContent).map((x) => ({ id: x.id, clientId: client.id, label: x.nom || x.email || "(sans nom)", sub: [x.email, telsText(x.tels)].filter(Boolean).join(" · ") }))
    : clients.flatMap((c) => c.contacts.filter(hasContent).map((x) => ({ id: x.id, clientId: c.id, label: x.nom || x.email || "(sans nom)", sub: [c.nom, x.email].filter(Boolean).join(" · "), extra: cleanTels(x.tels).map((t) => t.numero).join(" ") })));

  const fillClient = (n, c) => {
    if (type === "AC") { if (!n.adresse) n.adresse = clientAddr(c); return n; }
    n = setIn(n, ["entreprises", 0, "nom"], [c.nom, clientAddr(c)].filter(Boolean).join(", "));
    if (!n.op.lieu) n = setIn(n, ["op", "lieu"], clientAddr(c));
    return n;
  };
  const fillContact = (n, nom, fonction) => {
    if (type === "AC") return setIn(n, ["val", "eu", "nom"], nom);
    n = setIn(n, ["entreprises", 0, "rep"], nom);
    if (fonction !== undefined) n = setIn(n, ["entreprises", 0, "fonction"], fonction);
    return n;
  };

  const pickClient = (o) => {
    const c = clients.find((x) => x.id === o.id);
    setData((d) => fillClient({ ...d, clientId: c.id, clientNom: c.nom, contactId: "", contactNom: "", contactEmail: "" }, c));
  };
  const typeClient = (t) => setData((d) => {
    let n = { ...d, clientNom: t, clientId: "", contactId: "" };
    if (type === "PDP") n = setIn(n, ["entreprises", 0, "nom"], t);
    return n;
  });
  const pickContact = (o) => {
    const c = clients.find((x) => x.id === o.clientId);
    const ct = c?.contacts.find((x) => x.id === o.id);
    if (!ct) return;
    setData((d) => {
      let n = { ...d, contactId: ct.id, contactNom: ct.nom, contactEmail: "" };
      if (findClient(clients, d)?.id !== c.id) n = fillClient({ ...n, clientId: c.id, clientNom: c.nom }, c);
      return fillContact(n, ct.nom);
    });
  };
  const typeContact = (t) => setData((d) => fillContact({ ...d, contactNom: t, contactId: "" }, t));

  const manualClient = clientText.trim() && !client;
  const manualContact = contactText.trim() && !contact;

  return (
    <Section title="Client" hint="Tapez pour rechercher dans la base, ou saisissez librement un client et un contact qui n'y sont pas.">
      <div className="grid gap-3 sm:grid-cols-2">
        <Combobox label="Client" value={clientText} onInput={typeClient} onPick={pickClient} options={clientOptions}
          placeholder="Nom, ville, contact…" empty={clients.length ? "Aucun client trouvé : la saisie libre sera conservée." : "Base clients vide : saisie libre."} />
        <Combobox label="Contact" value={contactText} onInput={typeContact} onPick={pickContact} options={contactOptions}
          placeholder={client ? `Contacts de ${client.nom}` : "Nom, e-mail…"} empty="Aucun contact trouvé : la saisie libre sera conservée." />

        {contact && (
          <div className="text-sm text-slate-600 sm:col-span-2">
            {contact.email && <div>{contact.email}</div>}
            {cleanTels(contact.tels).map((t, i) => <div key={i}><span className="font-semibold">{t.type}</span> {t.numero}</div>)}
            {!contact.email && !cleanTels(contact.tels).length && "Aucun e-mail ni téléphone pour ce contact."}
          </div>
        )}
        {manualContact && (
          <Field label="E-mail du contact (pour l'envoi)" type="email" className="sm:col-span-2" value={data.contactEmail || ""}
            onChange={(v) => setData((d) => ({ ...d, contactEmail: v }))} />
        )}
        {data.contactEmail && manualContact && !isEmail(data.contactEmail) && <p className="text-sm text-red-700 sm:col-span-2">Adresse e-mail invalide.</p>}

        <div className="flex flex-wrap gap-x-4 gap-y-1 sm:col-span-2">
          {manualClient && (
            <button className="text-sm font-semibold text-slate-800 underline" onClick={() => {
              const c = newClient();
              c.nom = clientText.trim();
              c.adresse = type === "AC" ? data.adresse || "" : data.op?.lieu || "";
              c.contacts = manualContact ? [{ ...c.contacts[0], nom: contactText.trim(), email: data.contactEmail || "" }] : [];
              onAddClient(c);
              setData((d) => ({ ...d, clientId: c.id, clientNom: c.nom, contactId: c.contacts[0]?.id || "", contactNom: c.contacts[0]?.nom ?? d.contactNom, contactEmail: c.contacts[0] ? "" : d.contactEmail }));
            }}>Enregistrer « {clientText.trim()} » dans la base clients</button>
          )}
          {client && manualContact && (
            <button className="text-sm font-semibold text-slate-800 underline" onClick={() => {
              const ct = { ...contactFor(client.id), nom: contactText.trim(), email: data.contactEmail || "" };
              onAddContact(client.id, ct);
              setData((d) => ({ ...d, contactId: ct.id, contactNom: ct.nom, contactEmail: "" }));
            }}>Ajouter « {contactText.trim()} » aux contacts de {client.nom}</button>
          )}
          <button className="text-sm font-semibold text-slate-600 underline" onClick={onManage}>Gérer les clients</button>
        </div>
      </div>
    </Section>
  );
}

function ClientsPanel({ clients, docs, onOpen, onNew }) {
  const [q, setQ] = useState("");
  const s = q.trim().toLowerCase();
  const list = [...clients]
    .filter((c) => !s || JSON.stringify([c.nom, c.ville, c.cp, c.contacts.map((x) => [x.nom, x.email])]).toLowerCase().includes(s))
    .sort((a, b) => (a.nom || "").localeCompare(b.nom || "", "fr"));
  const count = (id) => docs.filter((d) => findClient(clients, d.data)?.id === id).length;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Btn kind="primary" onClick={onNew}>Nouveau client</Btn>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher un client, une ville, un contact…" className="min-w-[200px] flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400/60" />
      </div>
      {list.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-400 bg-white/60 p-8 text-center text-slate-600">
          {clients.length ? "Aucun client ne correspond à la recherche." : "Aucun client pour l'instant. La base est commune à toutes vos apps HT : les clients créés ici apparaissent aussi dans Devis/Factures."}
        </div>
      ) : (
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white">
          {list.map((c) => (
            <li key={c.id}>
              <button className="w-full p-3 text-left hover:bg-slate-50" onClick={() => onOpen(c.id)}>
                <p className="font-bold text-slate-900">{c.nom || "(sans nom)"}</p>
                <p className="truncate text-sm text-slate-600">{clientAddr(c) || "Adresse non renseignée"}</p>
                <p className="text-xs text-slate-400">
                  {c.contacts.length} contact{c.contacts.length > 1 ? "s" : ""} · {count(c.id)} document{count(c.id) > 1 ? "s" : ""}
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Liste de numéros typés (Fixe / Mobile), ajout et retrait libres
function PhonesEditor({ tels, onChange }) {
  const set = (i, k, v) => onChange(tels.map((t, j) => (j === i ? { ...t, [k]: v } : t)));
  return (
    <div className="mt-3">
      <span className="mb-1 block text-[13px] font-medium text-slate-600">Téléphones</span>
      <div className="space-y-2">
        {tels.map((t, i) => (
          <div key={i} className="flex gap-2">
            <div className="flex shrink-0 overflow-hidden rounded-md border border-slate-300">
              {TEL_TYPES.map((ty) => (
                <button key={ty} type="button" onClick={() => set(i, "type", ty)}
                  className={`px-3 py-2 text-sm font-semibold ${t.type === ty ? "bg-slate-900 text-white" : "bg-white text-slate-700"}`}>{ty}</button>
              ))}
            </div>
            <input type="tel" className={selCls} value={t.numero} placeholder="06 12 34 56 78" onChange={(e) => set(i, "numero", e.target.value)} />
            <button type="button" aria-label="Retirer ce numéro" onClick={() => onChange(tels.filter((_, j) => j !== i))}
              className="shrink-0 rounded-md border border-slate-300 bg-white px-3 text-lg leading-none text-slate-500 hover:text-red-700">×</button>
          </div>
        ))}
      </div>
      <button type="button" className="mt-2 text-sm font-semibold text-slate-800 underline"
        onClick={() => onChange([...tels, { type: tels.some((t) => t.type === "Mobile") ? "Fixe" : "Mobile", numero: "" }])}>
        Ajouter un numéro
      </button>
    </div>
  );
}

function ClientForm({ client, update, onDelete, used }) {
  const [confirm, setConfirm] = useState(false);
  const f = (k) => ({ value: client[k], onChange: (v) => update((c) => ({ ...c, [k]: v })) });
  const cf = (i, k) => ({ value: client.contacts[i][k], onChange: (v) => update((c) => setIn(c, ["contacts", i, k], v)) });
  return (
    <div className="space-y-4">
      <Section title="Société">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Raison sociale" className="sm:col-span-2" {...f("nom")} />
          <Field label="Adresse" className="sm:col-span-2" {...f("adresse")} />
          <Field label="Code postal" {...f("cp")} />
          <Field label="Ville" {...f("ville")} />
          <Field label="Pays (laisser vide pour la France)" className="sm:col-span-2" {...f("pays")} />
        </div>
      </Section>
      <Section title="Contacts" hint="Les contacts avec un e-mail apparaissent comme destinataires à l'envoi des documents.">
        {client.contacts.map((ct, i) => (
          <div key={ct.id} className="rounded-md border border-slate-200 p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Nom, prénom" {...cf(i, "nom")} />
              <Field label="E-mail" type="email" {...cf(i, "email")} />
            </div>
            <PhonesEditor tels={ct.tels || []} onChange={(tels) => update((c) => setIn(c, ["contacts", i, "tels"], tels))} />
            {ct.email && !isEmail(ct.email) && <p className="mt-1 text-sm text-red-700">Adresse e-mail invalide.</p>}
            <button className="mt-2 text-xs font-semibold text-red-700 underline" onClick={() => update((c) => {
              const rest = c.contacts.filter((x) => x.id !== ct.id);
              if (!rest.length) return { ...c, contacts: [{ ...newContact(), id: c.id }] };
              if (ct.id === c.id) rest[0] = { ...rest[0], id: c.id };
              return { ...c, contacts: rest };
            })}>Retirer ce contact</button>
          </div>
        ))}
        <Btn onClick={() => update((c) => ({ ...c, contacts: [...c.contacts, contactFor(c.id)] }))}>Ajouter un contact</Btn>
      </Section>
      <div className="flex gap-2">
        {confirm ? (
          <>
            <Btn kind="danger" onClick={onDelete}>Confirmer la suppression</Btn>
            <Btn onClick={() => setConfirm(false)}>Annuler</Btn>
          </>
        ) : (
          <Btn kind="danger" onClick={() => setConfirm(true)}>Supprimer ce client</Btn>
        )}
      </div>
      {confirm && used > 0 && <p className="text-sm text-slate-600">{used} document{used > 1 ? "s restent" : " reste"} intact{used > 1 ? "s" : ""} : seules les informations déjà recopiées dedans sont conservées.</p>}
    </div>
  );
}

/* ---------------- PDF et envoi par mail ---------------- */

const pdfName = (d) => `${d.data.numero} - ${d.type === "AC" ? "Attestation de consignation" : "Plan de prevention"}.pdf`;

// Transforme chaque feuille .sheet de l'aperçu en page(s) A4
async function buildPdf(container) {
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import("html2canvas-pro"), import("jspdf")]);
  const sheets = [...container.querySelectorAll(".sheet")];
  const pdf = new jsPDF({ unit: "mm", format: "a4", compress: true });
  const PW = 210, M = 8, W = PW - 2 * M, H = 297 - 2 * M;
  let first = true;
  const add = (canvas, x, w, h) => {
    if (!first) pdf.addPage();
    first = false;
    pdf.addImage(canvas.toDataURL("image/jpeg", 0.85), "JPEG", x, M, w, h);
  };
  for (const el of sheets) {
    const prev = el.style.cssText;
    el.style.cssText += ";width:794px;max-width:794px;padding:0;box-shadow:none;margin:0";
    let canvas;
    try { canvas = await html2canvas(el, { scale: 2, backgroundColor: "#ffffff", windowWidth: 1024 }); }
    finally { el.style.cssText = prev; }
    const ratio = canvas.height / canvas.width, imgH = W * ratio;
    if (imgH <= H * 1.25) {
      const h = Math.min(imgH, H), w = h / ratio;
      add(canvas, (PW - w) / 2, w, h);
    } else {
      const slice = Math.floor((canvas.width * H) / W);
      for (let y = 0; y < canvas.height; y += slice) {
        const hp = Math.min(slice, canvas.height - y);
        const c = document.createElement("canvas");
        c.width = canvas.width; c.height = hp;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, hp);
        ctx.drawImage(canvas, 0, y, canvas.width, hp, 0, 0, canvas.width, hp);
        add(c, M, W, (hp * W) / canvas.width);
      }
    }
  }
  return pdf.output("blob");
}

const blobToBase64 = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(",")[1]);
  r.onerror = () => rej(new Error("Lecture du PDF impossible"));
  r.readAsDataURL(blob);
});

const downloadBlob = (blob, name) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
};

function MailDialog({ current, client, settings, getPdf, onClose, onSent }) {
  const d = current.data;
  const isAC = current.type === "AC";
  const site = isAC ? d.adresse : d.op?.lieu;
  const withMail = (client?.contacts || []).filter((c) => isEmail(c.email));
  const manualMail = !d.contactId && isEmail(d.contactEmail) ? d.contactEmail : "";
  const [sel, setSel] = useState(() => new Set([
    ...withMail.filter((c) => c.id === d.contactId || (withMail.length === 1 && !manualMail)).map((c) => c.email),
    ...(manualMail ? [manualMail] : []),
  ]));
  const [extra, setExtra] = useState("");
  const [copie, setCopie] = useState(isEmail(settings.emailCopie));
  const [subject, setSubject] = useState(`${isAC ? "Attestation de consignation" : "Plan de prévention"} ${d.numero}${site ? " — " + site : ""}`);
  const contactNom = client?.contacts.find((c) => c.id === d.contactId)?.nom || d.contactNom;
  const [text, setText] = useState(
    `Bonjour${contactNom ? " " + contactNom : ""},\n\nVeuillez trouver ci-joint ${isAC ? "l'attestation de consignation" : "le plan de prévention"} ${d.numero}${site ? ", relatif à l'intervention sur le site " + site : ""}.\n\nCordialement,\n\n${settings.signature || [settings.chargeConsignation, settings.societe, settings.tel].filter(Boolean).join("\n")}`
  );
  const [state, setState] = useState({ s: "idle", msg: "" });

  const extras = extra.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
  const badExtra = extras.filter((x) => !isEmail(x));
  const to = [...new Set([...sel, ...extras.filter(isEmail)])];
  const cc = copie && isEmail(settings.emailCopie) && !to.includes(settings.emailCopie) ? [settings.emailCopie] : [];
  const canSend = to.length > 0 && badExtra.length === 0 && state.s !== "busy";

  const send = async () => {
    setState({ s: "busy", msg: "Création du PDF…" });
    try {
      const blob = await getPdf();
      setState({ s: "busy", msg: "Envoi en cours…" });
      const token = await auth.currentUser.getIdToken();
      const r = await fetch("/api/send-mail", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ to, cc, subject, text, filename: pdfName(current), content: await blobToBase64(blob) }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Erreur serveur (${r.status})`);
      onSent({ date: Date.now(), to, cc, by: auth.currentUser?.email || "" });
      setState({ s: "ok", msg: `Envoyé à ${to.join(", ")}.` });
    } catch (e) {
      setState({ s: "err", msg: e.message || String(e) });
    }
  };

  // Solution sans serveur : feuille de partage (iPhone/iPad/Mac) ou PDF + messagerie
  const openInMail = async () => {
    setState({ s: "busy", msg: "Création du PDF…" });
    try {
      const blob = await getPdf();
      const file = new File([blob], pdfName(current), { type: "application/pdf" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: subject, text });
        setState({ s: "ok", msg: "PDF transmis à l'app de partage. Choisissez Mail, puis ajoutez les destinataires." });
      } else {
        downloadBlob(blob, pdfName(current));
        window.location.href = `mailto:${to.join(",")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}${cc.length ? "&cc=" + cc.join(",") : ""}`;
        setState({ s: "ok", msg: "PDF téléchargé et messagerie ouverte : joignez le fichier au mail avant de l'envoyer." });
      }
    } catch (e) {
      if (e?.name === "AbortError") return setState({ s: "idle", msg: "" });
      setState({ s: "err", msg: e.message || String(e) });
    }
  };

  const toggle = (email) => setSel((s) => { const n = new Set(s); n.has(email) ? n.delete(email) : n.add(email); return n; });

  return (
    <div className="no-print fixed inset-0 z-50 flex items-end justify-center bg-slate-900/60 p-3 sm:items-center" onClick={onClose}>
      <div className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-lg bg-white p-5" onClick={(e) => e.stopPropagation()}>
        <p className="text-xl font-bold text-slate-900" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>Envoyer {d.numero} par mail</p>
        <p className="mb-4 text-sm text-slate-500">Pièce jointe : {pdfName(current)}</p>

        <p className="mb-1 text-[13px] font-medium text-slate-600">Destinataires</p>
        {manualMail && (
          <Check checked={sel.has(manualMail)} onChange={() => toggle(manualMail)}>
            {d.contactNom || manualMail} <span className="text-slate-500">({manualMail})</span>
          </Check>
        )}
        {withMail.length === 0 ? (manualMail ? null :
          <p className="mb-2 text-sm text-slate-600">{client ? "Aucun contact de ce client n'a d'e-mail." : "Aucun client choisi dans le document."} Saisissez les adresses ci-dessous.</p>
        ) : (
          <div className="mb-2 space-y-0.5">
            {withMail.map((c) => (
              <Check key={c.id} checked={sel.has(c.email)} onChange={() => toggle(c.email)}>
                {c.nom || c.email} <span className="text-slate-500">({c.email})</span>
              </Check>
            ))}
          </div>
        )}
        <Field label="Autres adresses (séparées par des virgules)" value={extra} onChange={setExtra} placeholder="prenom.nom@client.fr" />
        {badExtra.length > 0 && <p className="mt-1 text-sm text-red-700">Adresse invalide : {badExtra.join(", ")}</p>}
        {isEmail(settings.emailCopie) && (
          <div className="mt-2"><Check checked={copie} onChange={setCopie}>M'envoyer une copie ({settings.emailCopie})</Check></div>
        )}
        <div className="mt-3 space-y-3">
          <Field label="Objet" value={subject} onChange={setSubject} />
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-slate-600">Message</span>
            <textarea rows={8} className={selCls} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
        </div>

        {state.msg && (
          <p className={`mt-3 rounded-md px-3 py-2 text-sm ${state.s === "err" ? "bg-red-50 text-red-800" : state.s === "ok" ? "bg-green-50 text-green-800" : "bg-slate-100 text-slate-700"}`}>{state.msg}</p>
        )}

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Btn onClick={onClose}>{state.s === "ok" ? "Fermer" : "Annuler"}</Btn>
          <Btn onClick={openInMail} disabled={state.s === "busy"}>Ouvrir dans Mail</Btn>
          <Btn kind="yellow" onClick={send} disabled={!canSend}>Envoyer</Btn>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Logo ---------------- */

function LogoField({ value, onChange }) {
  const [err, setErr] = useState("");
  const load = (file) => {
    setErr("");
    if (!file) return;
    if (!file.type.startsWith("image/")) return setErr("Choisissez une image (PNG, JPG ou SVG).");
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, 800 / img.width, 300 / img.height);
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        const url = c.toDataURL("image/png");
        if (url.length > 400000) return setErr("Logo trop lourd : utilisez une image plus simple ou plus petite.");
        onChange(url);
      };
      img.onerror = () => setErr("Image illisible.");
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  };
  return (
    <div>
      <span className="mb-1 block text-[13px] font-medium text-slate-600">Logo (en-tête des documents et des PDF)</span>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex h-20 w-48 items-center justify-center rounded-md border border-slate-300 bg-white p-2">
          {value ? <img src={value} alt="Logo" className="max-h-full max-w-full object-contain" /> : <span className="text-sm text-slate-400">Aucun logo</span>}
        </div>
        <label className="cursor-pointer rounded-md border border-slate-300 bg-white px-3.5 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50">
          {value ? "Changer le logo" : "Importer le logo"}
          <input type="file" accept="image/*" className="hidden" onChange={(e) => { load(e.target.files[0]); e.target.value = ""; }} />
        </label>
        {value && <button className="text-sm font-semibold text-red-700 underline" onClick={() => onChange("")}>Retirer</button>}
      </div>
      {err && <p className="mt-1 text-sm text-red-700">{err}</p>}
      <p className="mt-1 text-xs text-slate-500">Prenez la version foncée du logo, sur fond blanc ou transparent.</p>
    </div>
  );
}

/* ---------------- Application ---------------- */

const DEFAULT_SETTINGS = { societe: "HT-Maintenance", adresse: "", tel: "", chargeConsignation: "", emailCopie: "", signature: "", logo: "" };

export default function App() {
  const [docs, setDocs] = useState([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState({ v: "list" });
  const [filter, setFilter] = useState("ALL");
  const [q, setQ] = useState("");
  const [confirmDel, setConfirmDel] = useState(null);
  const [sync, setSync] = useState("ok"); // ok | saving | error
  const [syncMsg, setSyncMsg] = useState("");
  const [clients, setClients] = useState([]);
  const [clientsLoaded, setClientsLoaded] = useState(false);
  const lastSynced = useRef([]); // état de la base commune tel que connu (à plat)
  const clientsTimer = useRef(null);
  const [mailOpen, setMailOpen] = useState(false);
  const [pdfBusy, setPdfBusy] = useState("");
  const printRef = useRef(null);
  const clientsRef = useRef(clients);
  clientsRef.current = clients;
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const dirty = useRef(new Set()); // ids modifiés localement, pas encore confirmés
  const ver = useRef({});
  const timers = useRef({});

  const fail = (e) => { setSync("error"); setSyncMsg(e?.message || String(e)); };
  const done = () => { if (dirty.current.size === 0) setSync("ok"); };

  // Sauvegarde différée d'un document (évite les pertes de frappe)
  const scheduleSave = (id) => {
    const v = (ver.current[id] || 0) + 1;
    ver.current[id] = v;
    dirty.current.add(id);
    setSync("saving");
    clearTimeout(timers.current[id]);
    timers.current[id] = setTimeout(async () => {
      try {
        if (id === "__settings") {
          await setDoc(SETTINGS_REF(), settingsRef.current);
        } else {
          const isDoc = id.startsWith("d:"), realId = id.slice(2);
          const d = (isDoc ? docsRef.current : clientsRef.current).find((x) => x.id === realId);
          if (!d) { dirty.current.delete(id); return done(); }
          const { id: _omit, ...payload } = d;
          const size = new Blob([JSON.stringify(payload)]).size;
          if (size > MAX_BYTES) throw new Error(`${isDoc ? d.data.numero : d.nom} dépasse la taille maximale (${Math.round(size / 1024)} Ko) — allégez le schéma ou refaites une signature.`);
          await setDoc(doc(db, isDoc ? COL : CLI_COL, realId), payload);
        }
        if (ver.current[id] === v) dirty.current.delete(id);
        done();
      } catch (e) { fail(e); }
    }, 800);
  };

  useEffect(() => {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&family=Barlow+Condensed:wght@600;700&display=swap";
    document.head.appendChild(l);
    const unDocs = onSnapshot(collection(db, COL), (snap) => {
      const remote = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setDocs((prev) => {
        const keepLocal = prev.filter((d) => dirty.current.has("d:" + d.id));
        const merged = remote.map((r) => keepLocal.find((l) => l.id === r.id) || r);
        keepLocal.forEach((l) => { if (!merged.some((m) => m.id === l.id)) merged.push(l); });
        return merged;
      });
      setLoaded(true);
    }, (e) => { fail(e); setLoaded(true); });
    const unSettings = onSnapshot(SETTINGS_REF(), (snap) => {
      if (snap.exists() && !dirty.current.has("__settings")) setSettings({ ...DEFAULT_SETTINGS, ...snap.data() });
    }, fail);
    loadClients(true);
    // Rechargement quand on revient sur l'app (modifs faites depuis Devis/Factures ou un autre appareil)
    const onVisible = () => { if (document.visibilityState === "visible" && !dirty.current.has("__contacts")) loadClients(false); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { unDocs(); unSettings(); document.removeEventListener("visibilitychange", onVisible); };
  }, []);

  async function loadClients(withMigration) {
    try {
      let shared = await loadContactsShared();
      if (withMigration && shared.length === 0) {
        // Migration unique : anciens clients de cette app → base commune (même id = même résultat si rejouée)
        const own = await getDocs(collection(db, CLI_COL));
        const old = own.docs.map((d) => {
          const v = d.data();
          return { id: d.id, nom: v.nom || "", adresse: v.adresse || "", cp: v.cp || "", ville: v.ville || "", pays: "",
            contacts: (v.contacts || []).map((x) => ({ id: x.id, nom: x.nom || "", email: x.email || "", tels: readTels(x) })) };
        });
        if (old.length) {
          const flat = flattenClients(old);
          await syncContactsToShared(flat, []);
          shared = flat;
        }
      }
      if (dirty.current.has("__contacts")) return; // une modif locale est en cours : on ne l'écrase pas
      const grouped = groupShared(shared);
      lastSynced.current = flattenClients(grouped);
      setClients(grouped);
      setClientsLoaded(true);
    } catch (e) { fail(e); }
  }

  // Toute modification des clients est répercutée dans la base commune (différentiel, après 800 ms)
  useEffect(() => {
    if (!clientsLoaded) return;
    const next = flattenClients(clients);
    if (JSON.stringify(next) === JSON.stringify(lastSynced.current)) return;
    dirty.current.add("__contacts");
    setSync("saving");
    clearTimeout(clientsTimer.current);
    clientsTimer.current = setTimeout(async () => {
      try {
        const target = flattenClients(clientsRef.current);
        await syncContactsToShared(target, lastSynced.current);
        lastSynced.current = target;
        dirty.current.delete("__contacts");
        done();
      } catch (e) { fail(e); }
    }, 800);
  }, [clients, clientsLoaded]);

  const current = docs.find((d) => d.id === view.id);
  useEffect(() => { setMailOpen(false); setPdfBusy(""); }, [view]);
  const setData = (fn) => {
    const id = view.id;
    setDocs((ds) => ds.map((d) => (d.id === id ? { ...d, data: fn(d.data), updatedAt: Date.now() } : d)));
    scheduleSave("d:" + id);
  };
  const recordSend = (id, envoi) => {
    setDocs((ds) => ds.map((d) => (d.id === id ? { ...d, envois: [...(d.envois || []), envoi] } : d)));
    scheduleSave("d:" + id);
  };
  const updateClient = (id, fn) => setClients((cs) => cs.map((c) => (c.id === id ? fn(c) : c)));
  const createClient = () => {
    const c = newClient();
    setClients((cs) => [...cs, c]);
    setView({ v: "client", id: c.id, back: view });
  };
  const addClientQuiet = (c) => setClients((cs) => [...cs, c]);
  const addContactQuiet = (clientId, ct) => updateClient(clientId, (c) => ({ ...c, contacts: [...c.contacts.filter(hasContent), ct] }));
  const removeClient = (id) => {
    setClients((cs) => cs.filter((x) => x.id !== id));
    setView({ v: "clients" });
  };
  const getPdf = async () => {
    if (!printRef.current) throw new Error("Aperçu introuvable.");
    return buildPdf(printRef.current);
  };
  const downloadPdf = async () => {
    setPdfBusy("Création du PDF…");
    try { downloadBlob(await getPdf(), pdfName(current)); setPdfBusy(""); }
    catch (e) { setPdfBusy(`PDF impossible : ${e.message || e}`); }
  };
  const updateSettings = (fn) => { setSettings(fn); scheduleSave("__settings"); };
  const removeDoc = async (id) => {
    clearTimeout(timers.current["d:" + id]);
    dirty.current.delete("d:" + id);
    setDocs((ds) => ds.filter((x) => x.id !== id));
    try { await deleteDoc(doc(db, COL, id)); done(); } catch (e) { fail(e); }
  };
  const bind = (path) => ({ value: getIn(current?.data, path) ?? "", onChange: (v) => setData((d) => setIn(d, path, v)) });

  const create = (type) => {
    const numero = nextNumero(docs, type);
    const doc = { id: uid(), type, createdAt: Date.now(), updatedAt: Date.now(), data: type === "AC" ? newAC(numero, settings) : newPDP(numero, settings) };
    setDocs((ds) => [doc, ...ds]);
    scheduleSave("d:" + doc.id);
    setView({ v: "edit", id: doc.id });
  };
  const duplicate = (doc) => {
    const numero = nextNumero(docs, doc.type);
    const base = JSON.parse(JSON.stringify(doc.data));
    // on garde le contenu, on retire signatures et horodatages
    const strip = (o) => { if (o && typeof o === "object") { for (const k in o) { if (k === "sig" || k === "dt") o[k] = ""; else strip(o[k]); } } };
    strip(base);
    const nd = { ...doc, id: uid(), createdAt: Date.now(), updatedAt: Date.now(), envois: [], data: { ...base, numero } };
    setDocs((ds) => [nd, ...ds]);
    scheduleSave("d:" + nd.id);
  };

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return docs
      .filter((d) => filter === "ALL" || d.type === filter)
      .filter((d) => !s || JSON.stringify([findClient(clients, d.data)?.nom, d.data.clientNom, d.data.contactNom, d.data.numero, d.data.entreprise, d.data.adresse, d.data.op?.lieu, d.data.entreprises?.[0]?.nom, d.data.zones]).toLowerCase().includes(s))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [docs, filter, q, clients]);

  const subtitle = (d) => d.type === "AC"
    ? [findClient(clients, d.data)?.nom || d.data.clientNom, d.data.adresse].filter(Boolean).join(" — ") || "Chantier non renseigné"
    : [d.data.entreprises?.[0]?.nom, d.data.op?.lieu].filter(Boolean).join(" — ") || "Entreprise utilisatrice non renseignée";

  const printCss = `
    .sheet{background:#fff;color:#000;width:100%;max-width:210mm;margin:0 auto;padding:10mm;font-family:Barlow,Arial,sans-serif;box-shadow:0 1px 3px rgba(0,0,0,.15)}
    @media print{ @page{size:A4;margin:8mm} body{background:#fff!important} .no-print{display:none!important} .sheet{box-shadow:none;padding:0;max-width:none} .print-wrap{padding:0!important;background:#fff!important} *{-webkit-print-color-adjust:exact;print-color-adjust:exact} }
  `;

  const TopBar = ({ children, title }) => (
    <header className="no-print sticky top-0 z-40" style={{ background: C.ink, paddingTop: "env(safe-area-inset-top,0px)" }}>
      <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-3 text-white">
        {children}
        <div className="min-w-0 flex-1">
          <p className="truncate text-xl font-bold leading-tight" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>{title}</p>
          <p className="text-xs" style={{ color: sync === "error" ? "#fca5a5" : "#cbd5e1" }}>{sync === "ok" ? "Synchronisé" : sync === "saving" ? "Enregistrement…" : "Échec de la sauvegarde"}</p>
        </div>
      </div>
      {sync === "error" && <div className="bg-red-700 px-4 py-2 text-center text-sm text-white">Sauvegarde impossible : {syncMsg}</div>}
      <div className="h-1.5" style={{ background: `repeating-linear-gradient(-45deg, ${C.yellow} 0 12px, ${C.ink} 12px 24px)` }} />
    </header>
  );

  if (!loaded) return <div className="p-8 text-slate-600">Chargement…</div>;

  /* --- Aperçu / impression --- */
  if (view.v === "print" && current) {
    return (
      <div className="min-h-screen" style={{ background: C.bg, fontFamily: "Barlow, sans-serif" }}>
        <style>{printCss}</style>
        <TopBar title={`Aperçu ${current.data.numero}`}>
          <Btn onClick={() => setView({ v: "edit", id: current.id })}>Modifier</Btn>
          <Btn onClick={() => setView({ v: "list" })}>Liste</Btn>
        </TopBar>
        <div className="no-print mx-auto flex max-w-4xl flex-wrap items-center justify-end gap-2 px-4 pt-4">
          {current.envois?.length > 0 && (
            <span className="mr-auto text-sm text-slate-600">Dernier envoi le {fmtDT(current.envois[current.envois.length - 1].date)} à {current.envois[current.envois.length - 1].to.join(", ")}</span>
          )}
          <Btn onClick={() => window.print()}>Imprimer</Btn>
          <Btn onClick={downloadPdf} disabled={pdfBusy === "Création du PDF…"}>Télécharger le PDF</Btn>
          <Btn kind="yellow" onClick={() => setMailOpen(true)}>Envoyer par mail</Btn>
        </div>
        {pdfBusy && <p className="no-print mx-auto mt-2 max-w-4xl px-4 text-right text-sm text-slate-600">{pdfBusy}</p>}
        <div ref={printRef} className="print-wrap overflow-x-auto p-4">
          {current.type === "AC" ? <PrintAC d={current.data} settings={settings} /> : <PrintPDP d={current.data} settings={settings} />}
        </div>
        {mailOpen && (
          <MailDialog current={current} client={findClient(clients, current.data)} settings={settings}
            getPdf={getPdf} onClose={() => setMailOpen(false)} onSent={(e) => recordSend(current.id, e)} />
        )}
      </div>
    );
  }

  /* --- Édition --- */
  if (view.v === "edit" && current) {
    return (
      <div className="min-h-screen" style={{ background: C.bg, fontFamily: "Barlow, sans-serif" }}>
        <TopBar title={`${current.type === "AC" ? "Attestation" : "Plan de prévention"} ${current.data.numero}`}>
          <Btn onClick={() => setView({ v: "list" })}>Liste</Btn>
        </TopBar>
        <main key={current.id} className="mx-auto max-w-4xl space-y-4 px-4 py-5 pb-28">
          {current.type === "AC"
            ? <EditAC data={current.data} bind={bind} setData={setData} clients={clients} onManage={() => setView({ v: "clients", back: view })} onAddClient={addClientQuiet} onAddContact={addContactQuiet} />
            : <EditPDP data={current.data} bind={bind} setData={setData} clients={clients} onManage={() => setView({ v: "clients", back: view })} onAddClient={addClientQuiet} onAddContact={addContactQuiet} />}
        </main>
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-300 bg-white/95 px-4 py-3 backdrop-blur" style={{ paddingBottom: "calc(12px + env(safe-area-inset-bottom,0px))" }}>
          <div className="mx-auto flex max-w-4xl items-center justify-between gap-2">
            <span className="text-sm font-semibold" style={{ color: statutOf(current).c }}>{statutOf(current).t}</span>
            <Btn kind="yellow" onClick={() => setView({ v: "print", id: current.id })}>Aperçu, PDF et envoi</Btn>
          </div>
        </div>
      </div>
    );
  }

  /* --- Clients --- */
  if (view.v === "clients") {
    const back = view.back || { v: "list" };
    return (
      <div className="min-h-screen" style={{ background: C.bg, fontFamily: "Barlow, sans-serif" }}>
        <TopBar title={`Clients (${clients.length})`}>
          <Btn onClick={() => setView(back)}>{back.v === "edit" ? "Retour au document" : "Liste"}</Btn>
        </TopBar>
        <main className="mx-auto max-w-4xl px-4 py-5">
          <ClientsPanel clients={clients} docs={docs}
            onOpen={(id) => setView({ v: "client", id, back: view })} onNew={createClient} />
        </main>
      </div>
    );
  }
  const currentClient = view.v === "client" ? clients.find((c) => c.id === view.id) : null;
  if (currentClient) {
    return (
      <div className="min-h-screen" style={{ background: C.bg, fontFamily: "Barlow, sans-serif" }}>
        <TopBar title={currentClient.nom || "Nouveau client"}>
          <Btn onClick={() => setView(view.back || { v: "clients" })}>Retour</Btn>
        </TopBar>
        <main key={currentClient.id} className="mx-auto max-w-4xl px-4 py-5">
          <ClientForm client={currentClient} update={(fn) => updateClient(currentClient.id, fn)} onDelete={() => removeClient(currentClient.id)}
            used={docs.filter((d) => findClient(clients, d.data)?.id === currentClient.id).length} />
        </main>
      </div>
    );
  }

  /* --- Paramètres --- */
  if (view.v === "settings") {
    const sb = (k) => ({ value: settings[k], onChange: (v) => updateSettings((s) => ({ ...s, [k]: v })) });
    return (
      <div className="min-h-screen" style={{ background: C.bg, fontFamily: "Barlow, sans-serif" }}>
        <TopBar title="Paramètres"><Btn onClick={() => setView({ v: "list" })}>Liste</Btn></TopBar>
        <main className="mx-auto max-w-4xl px-4 py-5">
          <Section title="Société" hint="Repris en en-tête des documents et pré-remplis à chaque création.">
            <LogoField {...sb("logo")} />
            <Field label="Nom" {...sb("societe")} />
            <Field label="Adresse" {...sb("adresse")} />
            <Field label="Téléphone" type="tel" {...sb("tel")} />
            <Field label="Chargé de consignation par défaut" {...sb("chargeConsignation")} />
          </Section>
          <div className="h-4" />
          <Section title="Envoi par mail" hint="La signature est ajoutée à la fin du message proposé. L'adresse de copie reçoit chaque document envoyé.">
            <Field label="M'envoyer une copie à" type="email" {...sb("emailCopie")} />
            <Field label="Signature des mails" area {...sb("signature")} placeholder={"Thomas Heitmann\nHT-Maintenance\n06 …"} />
          </Section>
        </main>
      </div>
    );
  }

  /* --- Liste --- */
  const counts = { AC: docs.filter((d) => d.type === "AC").length, PDP: docs.filter((d) => d.type === "PDP").length };
  const enCours = docs.filter((d) => d.type === "AC" && statutOf(d).t === "Consignée");
  return (
    <div className="min-h-screen" style={{ background: C.bg, fontFamily: "Barlow, sans-serif" }}>
      <TopBar title="HT Sécurité">
        <span className="hidden text-sm font-semibold sm:inline" style={{ color: C.yellow }}>Consignations · Plans de prévention</span>
      </TopBar>
      <main className="mx-auto max-w-4xl space-y-5 px-4 py-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <button onClick={() => create("AC")} className="rounded-lg border-2 border-slate-900 bg-white p-4 text-left hover:bg-yellow-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400">
            <p className="text-xl font-bold text-slate-900" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>Nouvelle attestation de consignation</p>
            <p className="text-sm text-slate-600">NF C18-510 — schéma, cadenas, validation et fin de travaux</p>
          </button>
          <button onClick={() => create("PDP")} className="rounded-lg border-2 border-slate-900 bg-white p-4 text-left hover:bg-yellow-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400">
            <p className="text-xl font-bold text-slate-900" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>Nouveau plan de prévention</p>
            <p className="text-sm text-slate-600">Entreprises, zone, secours, évaluation des risques, émargement</p>
          </button>
        </div>

        {enCours.length > 0 && (
          <div className="rounded-lg border-l-4 bg-white p-3" style={{ borderColor: C.red }}>
            <p className="font-semibold text-slate-900">{enCours.length} installation{enCours.length > 1 ? "s" : ""} actuellement consignée{enCours.length > 1 ? "s" : ""}</p>
            <p className="text-sm text-slate-600">{enCours.map((d) => d.data.numero).join(", ")} — fin de travaux non signée.</p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {[["ALL", `Tous (${docs.length})`], ["AC", `Attestations (${counts.AC})`], ["PDP", `Plans (${counts.PDP})`]].map(([k, l]) => (
            <button key={k} onClick={() => setFilter(k)} className={`rounded-full px-3 py-1.5 text-sm font-semibold ${filter === k ? "bg-slate-900 text-white" : "bg-white text-slate-700 border border-slate-300"}`}>{l}</button>
          ))}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher un numéro, un client, un site…" className="min-w-[200px] flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400/60" />
          <Btn onClick={() => setView({ v: "clients" })}>Clients</Btn>
          <Btn onClick={() => setView({ v: "settings" })}>Paramètres</Btn>
          <Btn onClick={logout} title={auth.currentUser?.email || ""}>Déconnexion</Btn>
        </div>

        {list.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-400 bg-white/60 p-8 text-center text-slate-600">
            {docs.length ? "Aucun document ne correspond à la recherche." : "Aucun document pour l'instant. Créez une attestation ou un plan de prévention avec les boutons ci-dessus."}
          </div>
        ) : (
          <ul className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white">
            {list.map((d) => {
              const st = statutOf(d);
              return (
                <li key={d.id} className="flex flex-wrap items-center gap-3 p-3 sm:flex-nowrap">
                  <button className="min-w-0 flex-1 text-left" onClick={() => setView({ v: "edit", id: d.id })}>
                    <div className="flex items-center gap-2">
                      <span className="rounded px-1.5 py-0.5 text-[11px] font-bold" style={{ background: d.type === "AC" ? C.yellow : C.steel, color: d.type === "AC" ? C.ink : "#fff" }}>{d.type === "AC" ? "Consignation" : "Prévention"}</span>
                      <span className="font-bold text-slate-900">{d.data.numero}</span>
                      <span className="text-xs font-semibold" style={{ color: st.c }}>● {st.t}</span>
                    </div>
                    <p className="truncate text-sm text-slate-600">{subtitle(d)}</p>
                    <p className="text-xs text-slate-400">Modifié le {fmtDT(d.updatedAt)}{d.envois?.length ? ` · envoyé le ${fmtDate(d.envois[d.envois.length - 1].date)}` : ""}</p>
                  </button>
                  {confirmDel === d.id ? (
                    <div className="flex gap-2">
                      <Btn kind="danger" onClick={() => { removeDoc(d.id); setConfirmDel(null); }}>Confirmer la suppression</Btn>
                      <Btn onClick={() => setConfirmDel(null)}>Annuler</Btn>
                    </div>
                  ) : (
                    <div className="flex gap-1.5">
                      <Btn onClick={() => setView({ v: "print", id: d.id })}>Aperçu et envoi</Btn>
                      <Btn onClick={() => duplicate(d)}>Dupliquer</Btn>
                      <Btn kind="danger" onClick={() => setConfirmDel(d.id)}>Supprimer</Btn>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}
