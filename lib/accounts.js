// Business-owner logins. The main admin (ADMIN_PASSWORD) sees every business;
// each owner signs in with their own email + password and sees only their business.
// Passwords are never stored: only a salted scrypt hash.
import crypto from 'node:crypto';
import { load, save } from './store.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_PASSWORD = 8;

function hash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const h = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash: h };
}

function verify(password, user) {
  const { hash: h } = hash(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(user.hash, 'hex'));
}

// What the dashboard may see about a login (never the hash).
const publicUser = ({ id, email, name, businessId, createdAt, lastLoginAt }) => ({ id, email, name, businessId, createdAt, lastLoginAt });

function checkPassword(password) {
  const pw = String(password || '');
  if (pw.length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters.`);
  if (pw.length > 200) throw new Error('Password is too long.');
  return pw;
}

export function listLogins(businessId) {
  return load('users', [])
    .filter((u) => u.businessId === businessId)
    .map(publicUser);
}

export function getLogin(id) {
  const u = load('users', []).find((x) => x.id === id);
  return u ? publicUser(u) : null;
}

export function createLogin(businessId, { email, name, password }) {
  const em = String(email || '').trim().toLowerCase().slice(0, 120);
  if (!EMAIL_RE.test(em)) throw new Error('Enter a valid email address.');
  const pw = checkPassword(password);
  const users = load('users', []);
  if (users.some((u) => u.email === em)) throw new Error('That email already has a login.');
  const user = { id: crypto.randomUUID(), email: em, name: String(name || '').trim().slice(0, 80), businessId, role: 'owner', ...hash(pw), createdAt: new Date().toISOString() };
  users.push(user);
  save('users', users);
  return publicUser(user);
}

export function setPassword(id, password) {
  const pw = checkPassword(password);
  const users = load('users', []);
  const u = users.find((x) => x.id === id);
  if (!u) return null;
  Object.assign(u, hash(pw), { updatedAt: new Date().toISOString() });
  delete u.resetHash; // a new password cancels any pending reset link
  delete u.resetExpires;
  save('users', users);
  return publicUser(u);
}

export function deleteLogin(id) {
  const users = load('users', []);
  const i = users.findIndex((x) => x.id === id);
  if (i < 0) return false;
  users.splice(i, 1);
  save('users', users);
  return true;
}

export function deleteLoginsForBusiness(businessId) {
  save('users', load('users', []).filter((u) => u.businessId !== businessId));
}

// Returns the session user for a correct email + password, otherwise null.
// Always runs one scrypt, so a wrong email takes as long as a wrong password.
const DUMMY = hash('not-a-real-password');
export function authenticate(email, password) {
  const em = String(email || '').trim().toLowerCase();
  const users = load('users', []);
  const u = users.find((x) => x.email === em);
  const ok = verify(String(password || ''), u || DUMMY);
  if (!u || !ok) return null;
  u.lastLoginAt = new Date().toISOString();
  save('users', users);
  return { id: u.id, role: 'owner', businessId: u.businessId, email: u.email, name: u.name };
}

// ---------- Sign in with a verified email (Google) ----------
// Only people who already have a login can sign in this way: Google proves the
// email is theirs, and the email must belong to an existing owner login.
export function sessionUserForEmail(email) {
  const em = String(email || '').trim().toLowerCase();
  const users = load('users', []);
  const u = users.find((x) => x.email === em);
  if (!u) return null;
  u.lastLoginAt = new Date().toISOString();
  save('users', users);
  return { id: u.id, role: 'owner', businessId: u.businessId, email: u.email, name: u.name };
}

// ---------- Forgot password ----------
// A random one-time link, valid for 30 minutes. Only a hash of the token is
// stored, so even someone who reads the database can't use a pending link.
const RESET_MS = 30 * 60_000;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// Returns { token, user } to email, or null if no login has this email.
export function createResetToken(email) {
  const em = String(email || '').trim().toLowerCase();
  const users = load('users', []);
  const u = users.find((x) => x.email === em);
  if (!u) return null;
  const token = crypto.randomBytes(32).toString('hex');
  u.resetHash = sha256(token);
  u.resetExpires = Date.now() + RESET_MS;
  save('users', users);
  return { token, user: publicUser(u) };
}

// Sets a new password if the link is valid and unused. Returns the user, or null.
export function resetPasswordWithToken(token, password) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  const users = load('users', []);
  const u = users.find((x) => x.resetHash && x.resetHash === sha256(token));
  if (!u || !(u.resetExpires > Date.now())) return null;
  const pw = checkPassword(password); // throws a friendly error if too short
  Object.assign(u, hash(pw), { updatedAt: new Date().toISOString() });
  delete u.resetHash; // one use only
  delete u.resetExpires;
  save('users', users);
  return publicUser(u);
}

export function checkCurrentPassword(id, password) {
  const u = load('users', []).find((x) => x.id === id);
  return Boolean(u && verify(String(password || ''), u));
}
