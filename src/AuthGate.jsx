import { useEffect, useState } from "react";
import { onAuthStateChanged, signInWithEmailAndPassword } from "firebase/auth";
import { auth } from "./firebase";

const MSG = {
  "auth/invalid-credential": "E-mail ou mot de passe incorrect.",
  "auth/wrong-password": "E-mail ou mot de passe incorrect.",
  "auth/user-not-found": "Aucun compte avec cet e-mail.",
  "auth/too-many-requests": "Trop de tentatives. Réessayez dans quelques minutes.",
  "auth/network-request-failed": "Pas de connexion réseau.",
};

export default function AuthGate({ children }) {
  const [user, setUser] = useState(undefined);
  const [email, setEmail] = useState("");
  const [pwd, setPwd] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => onAuthStateChanged(auth, (u) => setUser(u || null)), []);

  if (user === undefined) return <div style={{ padding: 32, fontFamily: "system-ui" }}>Chargement…</div>;
  if (user) return children;

  const submit = async (e) => {
    e.preventDefault();
    setErr(""); setBusy(true);
    try { await signInWithEmailAndPassword(auth, email.trim(), pwd); }
    catch (e) { setErr(MSG[e.code] || e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4" style={{ background: "#17212b", fontFamily: "Barlow, system-ui, sans-serif" }}>
      <form onSubmit={submit} className="w-full max-w-sm rounded-lg bg-white p-6">
        <div className="-mx-6 -mt-6 mb-5 h-2 rounded-t-lg" style={{ background: "repeating-linear-gradient(-45deg,#f5c400 0 12px,#17212b 12px 24px)" }} />
        <h1 className="text-2xl font-bold text-slate-900">HT Sécurité</h1>
        <p className="mb-5 text-sm text-slate-600">HT-Maintenance — consignations et plans de prévention</p>
        <label className="mb-3 block">
          <span className="mb-1 block text-sm font-medium text-slate-600">E-mail</span>
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2" />
        </label>
        <label className="mb-4 block">
          <span className="mb-1 block text-sm font-medium text-slate-600">Mot de passe</span>
          <input type="password" autoComplete="current-password" required value={pwd} onChange={(e) => setPwd(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2" />
        </label>
        {err && <p className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-800">{err}</p>}
        <button disabled={busy} className="w-full rounded-md bg-slate-900 py-2.5 font-semibold text-white disabled:opacity-60">{busy ? "Connexion…" : "Se connecter"}</button>
      </form>
    </div>
  );
}
