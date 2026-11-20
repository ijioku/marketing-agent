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

export function checkCurrentPassword(id, password) {
  const u = load('users', []).find((x) => x.id === id);
  return Boolean(u && verify(String(password || ''), u));
}
