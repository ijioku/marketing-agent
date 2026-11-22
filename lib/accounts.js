// Business-owner logins. The main admin (ADMIN_PASSWORD) sees every business;
// each owner signs in with their own email + password and sees only their business.
// Passwords are never stored: only a salted scrypt hash.
// crypto: random values, scrypt password hashing, constant-time comparison.
import crypto from 'node:crypto';
// load/save: read and write the stored list of logins.
import { load, save } from './store.js';

// A simple email shape check: something@something.something.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Shortest password allowed.
export const MIN_PASSWORD = 8;

// Hash a password with a salt (a fresh random salt unless one is given).
function hash(password, salt = crypto.randomBytes(16).toString('hex')) {
  // scrypt is deliberately slow, so guessing passwords takes attackers far longer.
  const h = crypto.scryptSync(String(password), salt, 64).toString('hex');
  // Store the salt and the hash, never the password.
  return { salt, hash: h };
}

// Check a password against a stored login.
function verify(password, user) {
  // Hash the typed password with the same salt.
  const { hash: h } = hash(password, user.salt);
  // Compare in constant time so timing can't leak anything.
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(user.hash, 'hex'));
}

// What the dashboard may see about a login (never the hash).
// Copy only the safe fields of a login.
const publicUser = ({ id, email, name, businessId, createdAt, lastLoginAt }) => ({ id, email, name, businessId, createdAt, lastLoginAt });

// Check a new password's length.
function checkPassword(password) {
  // Turn it into text.
  const pw = String(password || '');
  // Too short: refuse.
  if (pw.length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters.`);
  // Too long: refuse.
  if (pw.length > 200) throw new Error('Password is too long.');
  // Fine: hand it back.
  return pw;
}

// All logins for one business, without hashes.
export function listLogins(businessId) {
  return load('users', [])
    .filter((u) => u.businessId === businessId)
    .map(publicUser);
}

// One login by id, without its hash (null if unknown).
export function getLogin(id) {
  // Find it.
  const u = load('users', []).find((x) => x.id === id);
  // Hand back the safe copy.
  return u ? publicUser(u) : null;
}

// Create an owner login for a business.
export function createLogin(businessId, { email, name, password }) {
  // Tidy the email: trim, lower case, max 120 characters.
  const em = String(email || '').trim().toLowerCase().slice(0, 120);
  // Must look like an email.
  if (!EMAIL_RE.test(em)) throw new Error('Enter a valid email address.');
  // Check the password length.
  const pw = checkPassword(password);
  // Load existing logins.
  const users = load('users', []);
  // One login per email.
  if (users.some((u) => u.email === em)) throw new Error('That email already has a login.');
  // The new login: random id, email, name, business, role, salted hash, creation time.
  const user = { id: crypto.randomUUID(), email: em, name: String(name || '').trim().slice(0, 80), businessId, role: 'owner', ...hash(pw), createdAt: new Date().toISOString() };
  // Add it to the list...
  users.push(user);
  // ...and save.
  save('users', users);
  // Hand back the safe copy.
  return publicUser(user);
}

// Set a new password for a login.
export function setPassword(id, password) {
  // Check the length.
  const pw = checkPassword(password);
  // Load logins.
  const users = load('users', []);
  // Find this one.
  const u = users.find((x) => x.id === id);
  // Unknown: null.
  if (!u) return null;
  // Replace the salt and hash and note when it changed.
  Object.assign(u, hash(pw), { updatedAt: new Date().toISOString() });
  delete u.resetHash; // a new password cancels any pending reset link
  delete u.resetExpires;
  // Save.
  save('users', users);
  // Hand back the safe copy.
  return publicUser(u);
}

// Delete a login by id.
export function deleteLogin(id) {
  // Load logins.
  const users = load('users', []);
  // Find its position.
  const i = users.findIndex((x) => x.id === id);
  // Not found: false.
  if (i < 0) return false;
  // Remove it...
  users.splice(i, 1);
  // ...save...
  save('users', users);
  // ...and report success.
  return true;
}

// Delete all logins of a business (used when the business is deleted).
export function deleteLoginsForBusiness(businessId) {
  // Keep every login that belongs to another business.
  save('users', load('users', []).filter((u) => u.businessId !== businessId));
}

// Returns the session user for a correct email + password, otherwise null.
// Always runs one scrypt, so a wrong email takes as long as a wrong password.
// A ready-made fake hash, used when the email doesn't exist.
const DUMMY = hash('not-a-real-password');
// Check an email and password.
export function authenticate(email, password) {
  // Tidy the email.
  const em = String(email || '').trim().toLowerCase();
  // Load logins.
  const users = load('users', []);
  // Find the login with this email.
  const u = users.find((x) => x.email === em);
  // Check the password (against the fake hash if there's no such login).
  const ok = verify(String(password || ''), u || DUMMY);
  // Either wrong: null.
  if (!u || !ok) return null;
  // Note the sign-in time...
  u.lastLoginAt = new Date().toISOString();
  // ...and save it.
  save('users', users);
  // Hand back what the session needs to know.
  return { id: u.id, role: 'owner', businessId: u.businessId, email: u.email, name: u.name };
}

// ---------- Sign in with a verified email (Google) ----------
// Only people who already have a login can sign in this way: Google proves the
// email is theirs, and the email must belong to an existing owner login.
// Google already proved this email belongs to the person.
export function sessionUserForEmail(email) {
  // Tidy the email.
  const em = String(email || '').trim().toLowerCase();
  // Load logins.
  const users = load('users', []);
  // Find the login with this email.
  const u = users.find((x) => x.email === em);
  // None: they can't sign in.
  if (!u) return null;
  // Note the sign-in time and save it.
  u.lastLoginAt = new Date().toISOString();
  save('users', users);
  // Hand back what the session needs to know.
  return { id: u.id, role: 'owner', businessId: u.businessId, email: u.email, name: u.name };
}

// ---------- Forgot password ----------
// A random one-time link, valid for 30 minutes. Only a hash of the token is
// stored, so even someone who reads the database can't use a pending link.
// How long a reset link works: 30 minutes.
const RESET_MS = 30 * 60_000;
// A one-way fingerprint (SHA-256) of a text.
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// Returns { token, user } to email, or null if no login has this email.
// Make a reset token for an email.
export function createResetToken(email) {
  // Tidy the email.
  const em = String(email || '').trim().toLowerCase();
  // Load logins.
  const users = load('users', []);
  // Find the login.
  const u = users.find((x) => x.email === em);
  // None: null (the caller still shows the same message).
  if (!u) return null;
  // 64 random hex characters: impossible to guess.
  const token = crypto.randomBytes(32).toString('hex');
  // Store only its fingerprint...
  u.resetHash = sha256(token);
  // ...and when it expires.
  u.resetExpires = Date.now() + RESET_MS;
  // Save.
  save('users', users);
  // Hand back the token (for the email) and the safe login.
  return { token, user: publicUser(u) };
}

// Sets a new password if the link is valid and unused. Returns the user, or null.
// Use a reset token to set a new password.
export function resetPasswordWithToken(token, password) {
  // The token must be exactly 64 hex characters.
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  // Load logins.
  const users = load('users', []);
  // Find the login with this token's fingerprint.
  const u = users.find((x) => x.resetHash && x.resetHash === sha256(token));
  // None, or expired: null.
  if (!u || !(u.resetExpires > Date.now())) return null;
  const pw = checkPassword(password); // throws a friendly error if too short
  // Replace the salt and hash.
  Object.assign(u, hash(pw), { updatedAt: new Date().toISOString() });
  delete u.resetHash; // one use only
  delete u.resetExpires;
  // Save.
  save('users', users);
  // Hand back the safe login.
  return publicUser(u);
}

// Check an owner's current password (before they change it).
export function checkCurrentPassword(id, password) {
  // Find the login.
  const u = load('users', []).find((x) => x.id === id);
  // True only if it exists and the password matches.
  return Boolean(u && verify(String(password || ''), u));
}
