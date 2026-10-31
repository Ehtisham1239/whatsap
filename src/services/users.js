// Dashboard accounts: self-serve signup (creates a trial tenant and its owner),
// email + password login, cookie sessions and team management.
import { randomBytes } from "node:crypto";
import * as repo from "../db/repo.js";
import { sha256Hex } from "../lib/crypto.js";
import { AppError, badRequest, forbidden, notFound, unauthorized } from "../lib/errors.js";
import { hashPassword, normalizeEmail, passwordProblem, verifyPassword } from "../lib/password.js";
import { changeBalance } from "./wallet.js";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_REFRESH_MS = 60 * 60 * 1000;
export const ROLES = Object.freeze(["owner", "admin", "agent"]);
const INVALID_LOGIN = "Email or password is incorrect";

const str = (v, max) => typeof v === "string" && v.trim().length > 0 && v.trim().length <= max;

export function createUserService({ db, now = () => new Date(), signupCredits = 0, allowSignup = true, hash = hashPassword, verify = verifyPassword }) {
  // A real hash so unknown emails cost the same time as wrong passwords.
  const dummyHash = hash("not-a-real-password-placeholder");

  async function newSession(userId, userAgent) {
    const token = randomBytes(32).toString("base64url");
    const at = now();
    await repo.insertSession(db, { tokenHash: sha256Hex(token), userId, now: at, expiresAt: new Date(at.getTime() + SESSION_TTL_MS), userAgent: userAgent ? String(userAgent).slice(0, 300) : null });
    return token;
  }

  function validateNewUser({ name, email, password }) {
    const errors = [];
    const e = normalizeEmail(email);
    if (!str(name, 100)) errors.push({ field: "name", message: "is required (max 100 characters)" });
    if (!e) errors.push({ field: "email", message: "must be a valid email address" });
    const pw = passwordProblem(password, { email: e, name });
    if (pw) errors.push({ field: "password", message: pw });
    if (errors.length) throw badRequest("Please correct the highlighted fields", errors);
    return { name: name.trim(), email: e };
  }

  return {
    async signup({ business_name, name, email, password } = {}, { userAgent } = {}) {
      if (!allowSignup) throw forbidden("signup_disabled", "New sign-ups are closed. Contact us to get an account.");
      const errors = [];
      if (!str(business_name, 200)) errors.push({ field: "business_name", message: "is required (max 200 characters)" });
      let user;
      try {
        user = validateNewUser({ name, email, password });
      } catch (err) {
        err.details = [...errors, ...err.details];
        throw err;
      }
      if (errors.length) throw badRequest("Please correct the highlighted fields", errors);
      const passwordHash = await hash(password);
      let created;
      try {
        created = await db.tx(async (q) => {
          const tenant = await repo.createTenant(q, { name: business_name.trim(), status: "trial", now: now() });
          const owner = await repo.insertUser(q, { tenantId: tenant.id, email: user.email, name: user.name, role: "owner", passwordHash, now: now() });
          return { tenant, owner };
        });
      } catch (err) {
        if (err?.code === "23505") throw new AppError(409, "email_taken", "An account with this email already exists. Sign in instead.");
        throw err;
      }
      if (signupCredits > 0) await changeBalance(db, { tenantId: created.tenant.id, kind: "topup", amount: signupCredits, note: "Welcome credits", now: now() });
      return { token: await newSession(created.owner.id, userAgent), user: created.owner, tenant: created.tenant };
    },

    async login({ email, password } = {}, { userAgent } = {}) {
      const e = normalizeEmail(email);
      if (!e || typeof password !== "string" || !password) throw unauthorized(INVALID_LOGIN);
      const user = await repo.findUserByEmail(db, e);
      const ok = await verify(password, user?.password_hash ?? (await dummyHash));
      if (!user || !ok || user.disabled_at) throw unauthorized(INVALID_LOGIN);
      if (user.tenant_status === "cancelled") throw forbidden("tenant_cancelled", "This account is cancelled");
      await repo.updateUser(db, user.tenant_id, user.id, { last_login_at: now() });
      return { token: await newSession(user.id, userAgent), user: await repo.getUser(db, user.tenant_id, user.id) };
    },

    /** Resolves a session cookie to an auth context, sliding its expiry at most hourly. */
    async authenticate(token) {
      if (typeof token !== "string" || !/^[\w-]{43}$/.test(token)) throw unauthorized("Please sign in");
      const hashValue = sha256Hex(token);
      const at = now();
      const s = await repo.findSession(db, hashValue, at);
      if (!s) throw unauthorized("Your session has expired. Please sign in again.");
      if (s.tenant_status === "cancelled") throw forbidden("tenant_cancelled", "This account is cancelled");
      if (at.getTime() - new Date(s.last_seen_at).getTime() > SESSION_REFRESH_MS) await repo.touchSession(db, hashValue, { now: at, expiresAt: new Date(at.getTime() + SESSION_TTL_MS) });
      return { id: null, user_id: s.user_id, role: s.role, tenant_id: s.tenant_id, waba_connection_id: null, tenant_status: s.tenant_status, session_hash: hashValue, user: { id: s.user_id, email: s.email, name: s.name, role: s.role }, tenant: { id: s.tenant_id, name: s.tenant_name, status: s.tenant_status } };
    },

    async logout(token) {
      if (typeof token === "string" && token) await repo.deleteSession(db, sha256Hex(token));
    },

    listTeam: (auth) => repo.listUsers(db, auth.tenant_id),

    /** Owners and admins add teammates with an initial password they share privately. */
    async addTeammate(auth, { name, email, password, role = "agent" } = {}) {
      requireManager(auth);
      if (!ROLES.includes(role)) throw badRequest("role must be owner, admin or agent");
      if (role === "owner" && auth.role !== "owner") throw forbidden("owner_required", "Only an owner can add another owner");
      const u = validateNewUser({ name, email, password });
      try {
        return await repo.insertUser(db, { tenantId: auth.tenant_id, email: u.email, name: u.name, role, passwordHash: await hash(password), now: now() });
      } catch (err) {
        if (err?.code === "23505") throw new AppError(409, "email_taken", "That email already has an account");
        throw err;
      }
    },

    async updateTeammate(auth, userId, { role, disabled } = {}) {
      requireManager(auth);
      const target = await repo.getUser(db, auth.tenant_id, userId);
      if (!target) throw notFound("User not found");
      if (userId === auth.user_id) throw forbidden("cannot_change_self", "You cannot change your own role or access");
      if ((target.role === "owner" || role === "owner") && auth.role !== "owner") throw forbidden("owner_required", "Only an owner can change an owner");
      if (role !== undefined && !ROLES.includes(role)) throw badRequest("role must be owner, admin or agent");
      const fields = {};
      if (role !== undefined) fields.role = role;
      if (disabled !== undefined) fields.disabled_at = disabled ? now() : null;
      const updated = await db.tx(async (q) => {
        const row = await repo.updateUser(q, auth.tenant_id, userId, fields);
        if ((await repo.countActiveOwners(q, auth.tenant_id)) < 1) throw new AppError(409, "last_owner", "An account needs at least one active owner");
        if (disabled) await repo.deleteUserSessions(q, userId);
        return row;
      });
      return updated;
    },

    async changePassword(auth, { current_password, new_password } = {}) {
      if (!auth.user_id) throw forbidden("session_required", "Sign in to the dashboard to change your password");
      const user = await repo.getUserWithHash(db, auth.user_id);
      if (!(await verify(String(current_password ?? ""), user.password_hash))) throw new AppError(400, "invalid_request", "Current password is incorrect", [{ field: "current_password", message: "is incorrect" }]);
      const problem = passwordProblem(new_password, { email: user.email, name: user.name });
      if (problem) throw badRequest(problem, [{ field: "new_password", message: problem }]);
      await repo.updateUser(db, auth.tenant_id, auth.user_id, { password_hash: await hash(new_password) });
      await repo.deleteUserSessions(db, auth.user_id, { exceptHash: auth.session_hash });
      return { changed: true };
    },
  };
}

export function requireManager(auth) {
  if (!auth.user_id || !["owner", "admin"].includes(auth.role)) throw forbidden("manager_required", "Only owners and admins can do this");
}
