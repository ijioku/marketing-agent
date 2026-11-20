// Security helpers: login lockout, sessions, rate limits and safe HTTP headers.
// Everything is in memory, which is fine for a single server. Restarting the
// server signs everyone out and clears lockouts.
import crypto from 'node:crypto';

const MINUTE = 60_000;

// ---------- Password check ----------

// Compares in constant time so attackers can't guess the password
// character by character by measuring how long the check takes.
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function isWeakPassword(pw) {
  return !pw || pw.length < 10 || ['changeme', 'password', 'admin', '123456', 'password123'].includes(pw.toLowerCase());
}

// ---------- Login lockout ----------
// 5 wrong passwords from the same address → locked for 15 minutes.
// Each new lockout doubles the wait (15 → 30 → 60 min, capped at 1 hour).
// The real admin is never locked out forever: just wait, or restart the server.

const MAX_ATTEMPTS = 5;
const BASE_LOCK_MS = 15 * MINUTE;
const MAX_LOCK_MS = 60 * MINUTE;
const loginFailures = new Map(); // ip -> { count, lockedUntil, lockouts, lastAt }

export function loginLockStatus(ip) {
  const f = loginFailures.get(ip);
  if (!f || !f.lockedUntil) return { locked: false };
  const remaining = f.lockedUntil - Date.now();
  if (remaining <= 0) {
    f.lockedUntil = 0;
    f.count = 0;
    return { locked: false };
  }
  return { locked: true, retryAfterSec: Math.ceil(remaining / 1000) };
}

export function recordLoginFailure(ip) {
  const f = loginFailures.get(ip) || { count: 0, lockedUntil: 0, lockouts: 0 };
  f.count++;
  f.lastAt = Date.now();
  if (f.count >= MAX_ATTEMPTS) {
    f.lockedUntil = Date.now() + Math.min(BASE_LOCK_MS * 2 ** f.lockouts, MAX_LOCK_MS);
    f.lockouts++;
    f.count = 0;
  }
  loginFailures.set(ip, f);
  return { attemptsLeft: f.lockedUntil ? 0 : MAX_ATTEMPTS - f.count, ...loginLockStatus(ip) };
}

export function recordLoginSuccess(ip) {
  loginFailures.delete(ip);
}

// ---------- Sessions ----------
// After login the browser gets a random session token in an HttpOnly cookie:
// JavaScript (and therefore injected scripts) can't read it, and the password
// itself is never stored in the browser.

const SESSION_MS = 12 * 60 * MINUTE;
const sessions = new Map(); // token -> expiresAt
export const SESSION_COOKIE = 'ma_session';

export function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_MS);
  return { token, maxAgeSec: SESSION_MS / 1000 };
}

export function isValidSession(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (exp < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function destroySession(token) {
  sessions.delete(token);
}

export function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
}

export function sessionCookie(token, maxAgeSec, secure) {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly', // not readable from JavaScript
    'SameSite=Strict', // not sent by other websites (blocks CSRF)
    secure ? 'Secure' : '', // HTTPS only once deployed
    `Max-Age=${maxAgeSec}`,
  ]
    .filter(Boolean)
    .join('; ');
}

// ---------- Rate limiting ----------

export function rateLimiter({ windowMs, max }) {
  const hits = new Map(); // key -> { count, resetAt }
  return function check(key) {
    const now = Date.now();
    let e = hits.get(key);
    if (!e || now > e.resetAt) {
      e = { count: 0, resetAt: now + windowMs };
      hits.set(key, e);
    }
    e.count++;
    return { allowed: e.count <= max, retryAfterSec: Math.ceil((e.resetAt - now) / 1000) };
  };
}

// Clean up expired entries now and then so memory doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
  for (const [ip, f] of loginFailures) if (!f.lockedUntil && now - (f.lastAt || 0) > 60 * MINUTE) loginFailures.delete(ip);
}, 10 * MINUTE).unref();

// ---------- HTTP security headers ----------

export function securityHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff'); // browsers must trust our file types
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  // The dashboard must never be shown inside another site's frame (clickjacking),
  // and may only load code from this server.
  if (!req.path.startsWith('/widget.js') && !req.path.startsWith('/api/public')) {
    res.set('X-Frame-Options', 'DENY');
    res.set(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "object-src 'none'",
      ].join('; ')
    );
  }
  next();
}
