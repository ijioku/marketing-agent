// "Continue with Google": checks the sign-in token Google gives the browser.
// We verify Google's signature ourselves (with Google's published keys) and that the
// token was made for THIS app, hasn't expired, and the email is verified.
// Turned on by setting GOOGLE_CLIENT_ID (free: Google Cloud console → Credentials).
import crypto from 'node:crypto';

export const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
let keys = { list: [], until: 0 };

async function googleKeys(force = false) {
  if (!force && keys.list.length && Date.now() < keys.until) return keys.list;
  const res = await fetch(CERTS_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error('Could not reach Google');
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') || '')?.[1]) || 3600;
  keys = { list: (await res.json()).keys || [], until: Date.now() + maxAge * 1000 };
  return keys.list;
}

const b64json = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

// Returns { email, name } for a genuine, verified Google sign-in, otherwise throws.
export async function verifyGoogleCredential(credential) {
  if (!GOOGLE_CLIENT_ID) throw new Error('Google sign-in is not set up.');
  if (typeof credential !== 'string' || credential.length > 4096) throw new Error('Bad sign-in token.');
  const parts = credential.split('.');
  if (parts.length !== 3) throw new Error('Bad sign-in token.');
  let header, payload;
  try {
    header = b64json(parts[0]);
    payload = b64json(parts[1]);
  } catch {
    throw new Error('Bad sign-in token.');
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Bad sign-in token.');

  let jwk = (await googleKeys()).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await googleKeys(true)).find((k) => k.kid === header.kid); // Google rotated its keys
  if (!jwk) throw new Error('Bad sign-in token.');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new Error('Bad sign-in token.');

  const now = Math.floor(Date.now() / 1000);
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) throw new Error('Bad sign-in token.');
  if (payload.aud !== GOOGLE_CLIENT_ID) throw new Error('This sign-in was not made for this app.');
  if (!(payload.exp > now - 30)) throw new Error('Sign-in expired. Please try again.');
  if (payload.email_verified !== true || typeof payload.email !== 'string') throw new Error('Your Google email is not verified.');
  return { email: payload.email.toLowerCase(), name: String(payload.name || '') };
}
