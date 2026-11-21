// App lock: Face ID / Touch ID on the iPhone and Mac, Windows Hello on a PC, through WebAuthn (a passkey
// of this device, created and checked only here: no server, no account). It is a screen lock: it keeps
// people who pick up the unlocked phone or computer out of the app. The data itself is not encrypted.
const KEY = 'gruzzolo:lock';
const AFTER_KEY = 'gruzzolo:lock-after'; // minutes away from the app before it asks again
const SEEN_KEY = 'gruzzolo:lock-seen'; // last moment the app was unlocked and in use
export const LOCK_AFTER = [0, 1, 5, 15, 60];
const DEFAULT_AFTER = 5;
const UV = 0x04; // authenticatorData flag: the user was verified (face, finger, PIN or device code)

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function unb64(s) {
  const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const random = (n) => crypto.getRandomValues(new Uint8Array(n));

export function lockCred() {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) || 'null');
    return c && typeof c.id === 'string' ? c : null;
  } catch {
    return null;
  }
}
export const lockOn = () => Boolean(lockCred());

export function lockAfter() {
  try {
    const v = Number(localStorage.getItem(AFTER_KEY));
    return localStorage.getItem(AFTER_KEY) !== null && LOCK_AFTER.includes(v) ? v : DEFAULT_AFTER;
  } catch {
    return DEFAULT_AFTER;
  }
}
export function setLockAfter(min) {
  try {
    localStorage.setItem(AFTER_KEY, String(LOCK_AFTER.includes(+min) ? +min : DEFAULT_AFTER));
  } catch { /* storage unavailable */ }
}
const span = (m) => (m === 60 ? '1 ora' : `${m} ${m === 1 ? 'minuto' : 'minuti'}`);
// 'ogni volta che lo riapri' / 'se torni dopo più di 5 minuti'
export const lockAfterText = (m) => (m === 0 ? 'ogni volta che lo riapri' : `se torni dopo più di ${span(m)}`);
export const lockAfterShort = (m) => (m === 0 ? 'subito' : m === 60 ? '1 ora' : `${m} min`);
function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, String(Date.now()));
  } catch { /* storage unavailable */ }
}
// Away longer than the chosen time (or never unlocked here): ask again
function expired() {
  let seen = 0;
  try {
    seen = Number(localStorage.getItem(SEEN_KEY)) || 0;
  } catch { /* storage unavailable */ }
  return !seen || Date.now() - seen > lockAfter() * 60e3 || Date.now() < seen;
}

// Name of the unlock on this device, for buttons and settings
export function lockName() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  const touchMac = /Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1;
  if (/iPhone|iPod/.test(ua) || touchMac || /iPad/.test(ua)) return 'Face ID';
  if (/Macintosh/.test(ua)) return 'Touch ID';
  if (/Windows/.test(ua)) return 'Windows Hello';
  return 'lo sblocco del dispositivo';
}

// True when this device can verify its owner (Face ID, Touch ID, Windows Hello, Android…)
export async function lockAvailable() {
  try {
    return Boolean(typeof window !== 'undefined' && window.isSecureContext && window.PublicKeyCredential
      && await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch {
    return false;
  }
}

// Creates the passkey (the system asks for Face ID / Windows Hello) and turns the lock on
export async function enableLock() {
  const cred = await navigator.credentials.create({
    publicKey: {
      rp: { name: 'Gruzzolo' },
      user: { id: random(16), name: 'Gruzzolo', displayName: 'Gruzzolo' },
      challenge: random(32),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
      timeout: 60000,
      attestation: 'none',
    },
  });
  if (!cred || !cred.rawId) throw new Error('Nessuna chiave creata');
  localStorage.setItem(KEY, JSON.stringify({ id: b64(cred.rawId), at: Date.now() }));
  markSeen();
}

// Asks for Face ID / Windows Hello; resolves true only when the owner was verified
export async function verifyLock() {
  const c = lockCred();
  if (!c) return true;
  const res = await navigator.credentials.get({
    publicKey: {
      challenge: random(32),
      allowCredentials: [{ type: 'public-key', id: unb64(c.id) }],
      userVerification: 'required',
      timeout: 60000,
    },
  });
  if (!res || b64(res.rawId) !== c.id) return false;
  const auth = new Uint8Array(res.response.authenticatorData || []);
  return auth.length > 32 && (auth[32] & UV) !== 0;
}

export function disableLock() {
  try {
    localStorage.removeItem(KEY);
  } catch { /* storage unavailable */ }
}

/* ---------- Lock screen ---------- */
const locked = () => document.documentElement.classList.contains('app-locked');
function setLocked(on) {
  document.documentElement.classList.toggle('app-locked', on);
  const el = document.getElementById('lock-screen');
  if (el) el.hidden = !on;
  if (on && document.activeElement && document.activeElement.blur) document.activeElement.blur();
}

// Last resort when the passkey is gone (e.g. deleted from the keychain): erase Gruzzolo on this
// device, then the user imports a backup. Nobody gets in without the device owner's unlock.
async function eraseAll() {
  try {
    const dbs = indexedDB.databases ? await indexedDB.databases() : [];
    await Promise.all(dbs.map((d) => new Promise((ok) => {
      const r = indexedDB.deleteDatabase(d.name);
      r.onsuccess = r.onerror = r.onblocked = () => ok();
    })));
  } catch { /* nothing to delete */ }
  try {
    localStorage.clear();
  } catch { /* storage unavailable */ }
  location.reload();
}

export function initLock() {
  const el = document.getElementById('lock-screen');
  if (!el) return;
  const msg = el.querySelector('.lock-msg');
  const btn = el.querySelector('[data-lock="unlock"]');
  btn.textContent = `Sblocca con ${lockName()}`;
  let busy = false;
  const unlock = async () => {
    if (busy) return;
    busy = true;
    msg.textContent = '';
    try {
      if (await verifyLock()) {
        markSeen();
        setLocked(false);
      }
      else msg.textContent = 'Non riconosciuto: riprova.';
    } catch (e) {
      msg.textContent = e && e.name === 'NotAllowedError' ? 'Sblocco annullato: tocca il pulsante per riprovare.' : 'Sblocco non riuscito: riprova.';
    } finally {
      busy = false;
    }
  };
  btn.addEventListener('click', unlock);
  el.querySelector('[data-lock="lost"]').addEventListener('click', () => {
    // eslint-disable-next-line no-alert
    if (window.confirm(`Se ${lockName()} non sblocca più Gruzzolo, l'unica via è cancellare i dati dell'app su questo dispositivo e poi importare un backup (Altro → Importa backup).\n\nCancello i dati di Gruzzolo?`)) eraseAll();
  });
  setLocked(lockOn() && expired());
  // The clock starts when the app goes to the background (or closes): back after the chosen time, locked
  const away = () => {
    if (lockOn() && !locked()) markSeen();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') away();
    else if (lockOn() && !locked() && expired()) setLocked(true);
  });
  window.addEventListener('pagehide', away);
  // in use: keep the clock fresh (a crash or a killed app must not count as hours away)
  setInterval(() => {
    if (document.visibilityState === 'visible') away();
  }, 30e3);
}
