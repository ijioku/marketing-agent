// "Continue with Google": checks the sign-in token Google gives the browser.
// We verify Google's signature ourselves (with Google's published keys) and that the
// token was made for THIS app, hasn't expired, and the email is verified.
// Turned on by setting GOOGLE_CLIENT_ID (free: Google Cloud console → Credentials).
// crypto = Node's built-in security toolkit (checks digital signatures).
import crypto from 'node:crypto';

// The app's Google client id from the settings (empty means Google sign-in is off).
export const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
// Where Google publishes the public keys used to check its signatures.
const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
// A cache of Google's keys, and the time until which they are still fresh.
let keys = { list: [], until: 0 };

// Get Google's public keys, re-using the cached copy while it is fresh (force = always download).
async function googleKeys(force = false) {
  // Cached keys still fresh: use them.
  if (!force && keys.list.length && Date.now() < keys.until) return keys.list;
  // Download the keys, giving up after 10 seconds.
  const res = await fetch(CERTS_URL, { signal: AbortSignal.timeout(10_000) });
  // Download failed: stop with an error.
  if (!res.ok) throw new Error('Could not reach Google');
  // Google says how long to keep the keys (max-age in seconds); default to one hour.
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') || '')?.[1]) || 3600;
  // Save the keys and when they go stale.
  keys = { list: (await res.json()).keys || [], until: Date.now() + maxAge * 1000 };
  // Hand back the list of keys.
  return keys.list;
}

// Decode one part of the token (base64url text) into a JavaScript object.
const b64json = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

// Returns { email, name } for a genuine, verified Google sign-in, otherwise throws.
export async function verifyGoogleCredential(credential) {
  // Google sign-in not set up: refuse.
  if (!GOOGLE_CLIENT_ID) throw new Error('Google sign-in is not set up.');
  // The token must be text and not absurdly long.
  if (typeof credential !== 'string' || credential.length > 4096) throw new Error('Bad sign-in token.');
  // A Google token has three parts separated by dots: header.payload.signature.
  const parts = credential.split('.');
  // Anything else is fake.
  if (parts.length !== 3) throw new Error('Bad sign-in token.');
  let header, payload;
  // Decode the header (which key and method) and the payload (who, for which app, expiry).
  try {
    header = b64json(parts[0]);
    payload = b64json(parts[1]);
  // Not decodable: fake.
  } catch {
    throw new Error('Bad sign-in token.');
  }
  // Google signs with RS256 and names the key it used (kid); anything else is rejected.
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Bad sign-in token.');

  // Find the key Google used...
  let jwk = (await googleKeys()).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await googleKeys(true)).find((k) => k.kid === header.kid); // Google rotated its keys
  // Still no key: fake.
  if (!jwk) throw new Error('Bad sign-in token.');
  // Check the signature over "header.payload" with Google's public key.
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  // Signature doesn't match: fake or tampered.
  if (!ok) throw new Error('Bad sign-in token.');

  // The current time in seconds.
  const now = Math.floor(Date.now() / 1000);
  // It must have been issued by Google.
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) throw new Error('Bad sign-in token.');
  // It must have been made for this app (our client id).
  if (payload.aud !== GOOGLE_CLIENT_ID) throw new Error('This sign-in was not made for this app.');
  // It must not have expired (30 seconds of leeway for clock differences).
  if (!(payload.exp > now - 30)) throw new Error('Sign-in expired. Please try again.');
  // Google must have verified the email address.
  if (payload.email_verified !== true || typeof payload.email !== 'string') throw new Error('Your Google email is not verified.');
  // All good: hand back the email (lower case) and name.
  return { email: payload.email.toLowerCase(), name: String(payload.name || '') };
}
