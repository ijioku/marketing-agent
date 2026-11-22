// Security helpers: login lockout, sessions, rate limits and safe HTTP headers.
// Everything is in memory, which is fine for a single server. Restarting the
// server signs everyone out and clears lockouts.
// crypto: random tokens, hashes and constant-time comparison.
import crypto from 'node:crypto';

// One minute in milliseconds, to make the numbers below easier to read.
const MINUTE = 60_000;

// ---------- Password check ----------

// Compares in constant time so attackers can't guess the password
// character by character by measuring how long the check takes.
// True if two texts are equal.
export function safeEqual(a, b) {
  // Fingerprint both texts first so they're always the same length...
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  // ...then compare in constant time.
  return crypto.timingSafeEqual(ha, hb);
}

// True if a password is too short or a well-known guess.
export function isWeakPassword(pw) {
  // Empty, under 10 characters, or on the list of common passwords.
  return !pw || pw.length < 10 || ['changeme', 'password', 'admin', '123456', 'password123'].includes(pw.toLowerCase());
}

// ---------- Login lockout ----------
// 5 wrong passwords from the same address → locked for 15 minutes.
// Each new lockout doubles the wait (15 → 30 → 60 min, capped at 1 hour).
// The real admin is never locked out forever: just wait, or restart the server.

// Wrong tries allowed before a lockout.
const MAX_ATTEMPTS = 5;
// First lockout: 15 minutes.
const BASE_LOCK_MS = 15 * MINUTE;
// Longest lockout: 60 minutes.
const MAX_LOCK_MS = 60 * MINUTE;
// Failures per IP address.
const loginFailures = new Map(); // ip -> { count, lockedUntil, lockouts, lastAt }

// Global safety net against guesses spread over many IPs (botnets): more than
// 50 wrong passwords in 15 minutes from anywhere pauses ALL logins for 15 minutes.
// The real owner just waits; nobody can guess at scale.
// Wrong passwords allowed from everyone together...
const GLOBAL_MAX = 50;
// ...within 15 minutes.
const GLOBAL_WINDOW_MS = 15 * MINUTE;
// The times of recent failures from anywhere.
let globalFails = [];
// When the global pause ends (0 = no pause).
let globalLockedUntil = 0;

// Is this IP (or everyone) locked out right now?
export function loginLockStatus(ip) {
  // Global pause active: locked, with seconds left.
  if (globalLockedUntil > Date.now()) return { locked: true, retryAfterSec: Math.ceil((globalLockedUntil - Date.now()) / 1000) };
  // This IP's failure record.
  const f = loginFailures.get(ip);
  // No record or no lock: not locked.
  if (!f || !f.lockedUntil) return { locked: false };
  // Time left on the lock.
  const remaining = f.lockedUntil - Date.now();
  // The lock has run out:
  if (remaining <= 0) {
    // clear it...
    f.lockedUntil = 0;
    // ...and reset the count.
    f.count = 0;
    // Not locked any more.
    return { locked: false };
  }
  // Still locked: say how many seconds are left.
  return { locked: true, retryAfterSec: Math.ceil(remaining / 1000) };
}

// Count a wrong password.
export function recordLoginFailure(ip) {
  // The time now.
  const t = Date.now();
  // Forget global failures older than 15 minutes.
  globalFails = globalFails.filter((x) => t - x < GLOBAL_WINDOW_MS);
  // Add this one.
  globalFails.push(t);
  // Too many from everyone:
  if (globalFails.length > GLOBAL_MAX) {
    // pause all logins for 15 minutes...
    globalLockedUntil = t + GLOBAL_WINDOW_MS;
    // ...start counting again...
    globalFails = [];
    // ...and log a warning.
    console.warn('[security] too many failed logins overall: logins paused for 15 minutes');
  }
  // This IP's record (or a fresh one).
  const f = loginFailures.get(ip) || { count: 0, lockedUntil: 0, lockouts: 0 };
  // One more failure.
  f.count++;
  // When it happened.
  f.lastAt = Date.now();
  // Reached the limit:
  if (f.count >= MAX_ATTEMPTS) {
    // lock it: 15 min, doubled for each earlier lockout, never more than 60 min.
    f.lockedUntil = Date.now() + Math.min(BASE_LOCK_MS * 2 ** f.lockouts, MAX_LOCK_MS);
    // Count the lockout.
    f.lockouts++;
    // Reset the try counter.
    f.count = 0;
  }
  // Save the record.
  loginFailures.set(ip, f);
  // Report tries left and the lock status.
  return { attemptsLeft: f.lockedUntil ? 0 : MAX_ATTEMPTS - f.count, ...loginLockStatus(ip) };
}

// A correct password clears this IP's failures.
export function recordLoginSuccess(ip) {
  loginFailures.delete(ip);
}

// ---------- Sessions ----------
// After login the browser gets a random session token in an HttpOnly cookie:
// JavaScript (and therefore injected scripts) can't read it, and the password
// itself is never stored in the browser.

// A session lasts 12 hours.
const SESSION_MS = 12 * 60 * MINUTE;
// All active sessions.
const sessions = new Map(); // token -> { expiresAt, user: { id, role, businessId, email, name } }
// The cookie's name.
export const SESSION_COOKIE = 'ma_session';

// role: "admin" (sees every business), "owner" (one business) or "demo" (the sample business).
// Start a session for a user (the admin by default).
export function createSession(user = { id: 'admin', role: 'admin' }) {
  // A random 64-character token: impossible to guess.
  const token = crypto.randomBytes(32).toString('hex');
  // Remember the session and when it expires.
  sessions.set(token, { expiresAt: Date.now() + SESSION_MS, user });
  // Hand back the token and how long the cookie should last (seconds).
  return { token, maxAgeSec: SESSION_MS / 1000 };
}

// Returns the signed-in user, or null.
// Who is signed in with this token?
export function getSessionUser(token) {
  // Not a proper 64-character hex token: nobody.
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  // Look the session up.
  const s = sessions.get(token);
  // Unknown: nobody.
  if (!s) return null;
  // Expired:
  if (s.expiresAt < Date.now()) {
    // forget it...
    sessions.delete(token);
    // ...nobody.
    return null;
  }
  // Valid: hand back the user.
  return s.user;
}

// True if the token belongs to a valid session.
export const isValidSession = (token) => Boolean(getSessionUser(token));

// Sign out one session.
export function destroySession(token) {
  sessions.delete(token);
}

// Sign a user out everywhere (their login was deleted or its password was reset).
// Sign out every session whose user passes the test.
export function destroySessionsWhere(test) {
  // Delete each matching session.
  for (const [t, s] of sessions) if (test(s.user)) sessions.delete(t);
}

// Read one cookie from the request.
export function readCookie(req, name) {
  // All cookies as one text, "a=1; b=2".
  const header = req.headers.cookie || '';
  // Go through each "name=value" part.
  for (const part of header.split(';')) {
    // Split into name and value (the value may itself contain "=").
    const [k, ...v] = part.trim().split('=');
    // Found it: hand back the decoded value.
    if (k === name) return decodeURIComponent(v.join('='));
  }
  // Not found: empty.
  return '';
}

// Build the Set-Cookie header for the session.
export function sessionCookie(token, maxAgeSec, secure) {
  return [
    // The name and token.
    `${SESSION_COOKIE}=${token}`,
    // Sent for every page on the site.
    'Path=/',
    'HttpOnly', // not readable from JavaScript
    'SameSite=Strict', // not sent by other websites (blocks CSRF)
    secure ? 'Secure' : '', // HTTPS only once deployed
    // How long the browser keeps it.
    `Max-Age=${maxAgeSec}`,
  ]
    // Drop the empty "Secure" when not on HTTPS...
    .filter(Boolean)
    // ...and join with semicolons.
    .join('; ');
}

// ---------- Rate limiting ----------

// Every limiter, so the cleanup below can tidy them all.
const allLimiters = [];
// Make a limiter: at most `max` hits per `windowMs` for each key (IP, session...).
export function rateLimiter({ windowMs, max }) {
  // Hits per key.
  const hits = new Map(); // key -> { count, resetAt }
  // Register it for cleanup.
  allLimiters.push(hits);
  // The check function routes call for each request.
  return function check(key) {
    // The time now.
    const now = Date.now();
    // This key's record.
    let e = hits.get(key);
    // No record, or its window has ended:
    if (!e || now > e.resetAt) {
      // start a new window...
      e = { count: 0, resetAt: now + windowMs };
      // ...and save it.
      hits.set(key, e);
    }
    // Count this hit.
    e.count++;
    // Allowed while within the limit; also say when the window resets.
    return { allowed: e.count <= max, retryAfterSec: Math.ceil((e.resetAt - now) / 1000) };
  };
}

// Clean up expired entries now and then so memory doesn't grow forever.
// Every 10 minutes:
setInterval(() => {
  // the time now,
  const now = Date.now();
  // delete expired sessions,
  for (const [t, s] of sessions) if (s.expiresAt < now) sessions.delete(t);
  // delete old failure records that aren't locked,
  for (const [ip, f] of loginFailures) if (!f.lockedUntil && now - (f.lastAt || 0) > 60 * MINUTE) loginFailures.delete(ip);
  // Forget expired rate-limit entries so memory doesn't grow forever.
  for (const hits of allLimiters) for (const [k, e] of hits) if (now > e.resetAt) hits.delete(k);
// unref() lets the program exit even though this timer exists.
}, 10 * MINUTE).unref();

// ---------- HTTP security headers ----------

// Add safety headers to every response.
export function securityHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff'); // browsers must trust our file types
  // Other sites only see our domain, not full page addresses, when a link is followed.
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups'); // lets the Google sign-in popup report back
  // We never use the camera, microphone or location.
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // On HTTPS: tell browsers to always use HTTPS for a year.
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  // The dashboard must never be shown inside another site's frame (clickjacking),
  // and may only load code from this server.
  // Every page except the chat widget script and its public API (which run inside clients' sites):
  if (!req.path.startsWith('/widget.js') && !req.path.startsWith('/api/public')) {
    // never show this page inside a frame.
    res.set('X-Frame-Options', 'DENY');
    // Content-Security-Policy: the list of places the page may load things from.
    res.set(
      'Content-Security-Policy',
      [
        // By default only from our own server.
        "default-src 'self'",
        // Scripts: ours (including inline ones) and Google's sign-in script.
        "script-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/client",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com/gsi/style", // web font + Google button
        // Fonts: ours and Google Fonts.
        "font-src 'self' https://fonts.gstatic.com",
        // Images: ours and built-in data: images.
        "img-src 'self' data:",
        // The page may only talk to our server and Google sign-in.
        "connect-src 'self' https://accounts.google.com/gsi/",
        "frame-src https://accounts.google.com/gsi/", // the "Continue with Google" button
        // No site may put our pages in a frame.
        "frame-ancestors 'none'",
        // Stops injected <base> tags from redirecting links.
        "base-uri 'none'",
        // Forms may only post to our server.
        "form-action 'self'",
        // No plugins (Flash etc.).
        "object-src 'none'",
      // Join the rules with semicolons.
      ].join('; ')
    );
  }
  // Carry on to the route.
  next();
}
