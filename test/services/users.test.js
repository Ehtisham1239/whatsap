import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword } from "../../src/lib/password.js";
import { createUserService, SESSION_TTL_MS } from "../../src/services/users.js";
import { createTestDb } from "../helpers/db.js";
import { balanceOf, ledgerOf, makeClock, seedTenant } from "../helpers/fixtures.js";

const fastHash = (pw) => hashPassword(pw, { N: 1024, r: 8, p: 1 });
const PW = "tulip-orbit-cedar-42";
let t;
before(async () => (t = await createTestDb()));
after(() => t.close());

let clock, svc;
beforeEach(async () => {
  await t.reset();
  clock = makeClock();
  svc = createUserService({ db: t.db, now: clock, hash: fastHash });
});

const signup = (over = {}) => svc.signup({ business_name: "Acme Traders", name: "Sara Ahmed", email: "Sara@Acme.pk", password: PW, ...over }, { userAgent: "test" });

describe("signup", () => {
  test("creates a trial tenant, an owner and a session", async () => {
    const r = await signup();
    assert.equal(r.tenant.status, "trial");
    assert.equal(r.user.role, "owner");
    assert.equal(r.user.email, "sara@acme.pk");
    assert.equal(r.user.password_hash, undefined);
    assert.match(r.token, /^[\w-]{43}$/);
    const auth = await svc.authenticate(r.token);
    assert.equal(auth.tenant_id, r.tenant.id);
    assert.equal(auth.role, "owner");
    const stored = (await t.db.query("select token_hash from user_sessions")).rows[0].token_hash;
    assert.notEqual(stored, r.token, "only a hash of the token is stored");
  });

  test("validates every field and reports them together", async () => {
    await assert.rejects(svc.signup({ business_name: "", name: "", email: "bad", password: "short" }), (e) => e.status === 400 && ["business_name", "name", "email", "password"].every((f) => e.details.some((d) => d.field === f)));
  });

  test("duplicate emails are refused, case-insensitively", async () => {
    await signup();
    await assert.rejects(signup({ email: "SARA@acme.pk", business_name: "Other" }), { status: 409, code: "email_taken" });
    assert.equal(Number((await t.db.query("select count(*) from tenants")).rows[0].count), 1, "no orphan tenant");
  });

  test("welcome credits are ledgered when configured", async () => {
    const withCredits = createUserService({ db: t.db, now: clock, hash: fastHash, signupCredits: 50 });
    const r = await withCredits.signup({ business_name: "B", name: "Bilal Raza", email: "b@b.pk", password: PW });
    assert.equal(await balanceOf(t.db, r.tenant.id), 50);
    assert.equal((await ledgerOf(t.db, r.tenant.id))[0].note, "Welcome credits");
  });

  test("signup can be disabled", async () => {
    const closed = createUserService({ db: t.db, hash: fastHash, allowSignup: false });
    await assert.rejects(closed.signup({}), { status: 403, code: "signup_disabled" });
  });
});

describe("login and sessions", () => {
  test("login works with any email case and records the time", async () => {
    await signup();
    clock.advance(1000);
    const r = await svc.login({ email: " SARA@acme.pk ", password: PW });
    assert.ok(r.token);
    assert.deepEqual(r.user.last_login_at, clock());
  });

  test("wrong password and unknown email give the same error", async () => {
    await signup();
    const a = await svc.login({ email: "sara@acme.pk", password: "wrong-password-1" }).catch((e) => e);
    const b = await svc.login({ email: "nobody@acme.pk", password: PW }).catch((e) => e);
    assert.equal(a.status, 401);
    assert.equal(a.message, b.message);
    await assert.rejects(svc.login({}), { status: 401 });
  });

  test("disabled users and cancelled tenants cannot sign in", async () => {
    const r = await signup();
    await t.db.query("update tenants set status = 'cancelled' where id = $1", [r.tenant.id]);
    await assert.rejects(svc.login({ email: "sara@acme.pk", password: PW }), { status: 403 });
    await assert.rejects(svc.authenticate(r.token), { status: 403 });
    await t.db.query("update tenants set status = 'active'");
    await t.db.query("update users set disabled_at = now()");
    await assert.rejects(svc.login({ email: "sara@acme.pk", password: PW }), { status: 401 });
    await assert.rejects(svc.authenticate(r.token), { status: 401 });
  });

  test("sessions expire after 7 idle days and slide when used", async () => {
    const r = await signup();
    clock.advance(SESSION_TTL_MS - 1000);
    await svc.authenticate(r.token);
    clock.advance(SESSION_TTL_MS - 1000);
    assert.ok(await svc.authenticate(r.token), "extended by use");
    clock.advance(SESSION_TTL_MS + 1);
    await assert.rejects(svc.authenticate(r.token), { status: 401 });
  });

  test("logout ends the session; malformed tokens are rejected", async () => {
    const r = await signup();
    await svc.logout(r.token);
    await assert.rejects(svc.authenticate(r.token), { status: 401 });
    await svc.logout(undefined);
    await assert.rejects(svc.authenticate("short"), { status: 401 });
  });
});

describe("team", () => {
  async function owner() {
    const r = await signup();
    return svc.authenticate(r.token);
  }

  test("owners add teammates who can then sign in", async () => {
    const auth = await owner();
    const u = await svc.addTeammate(auth, { name: "Agent Ali", email: "ali@acme.pk", password: "river-stone-77x", role: "agent" });
    assert.equal(u.role, "agent");
    const r = await svc.login({ email: "ali@acme.pk", password: "river-stone-77x" });
    const agent = await svc.authenticate(r.token);
    assert.equal(agent.tenant_id, auth.tenant_id);
    assert.equal((await svc.listTeam(auth)).length, 2);
    await assert.rejects(svc.addTeammate(agent, { name: "X Y", email: "x@acme.pk", password: "river-stone-77y" }), { status: 403, code: "manager_required" });
  });

  test("admins cannot create or change owners", async () => {
    const auth = await owner();
    await svc.addTeammate(auth, { name: "Admin Asad", email: "asad@acme.pk", password: "river-stone-77x", role: "admin" });
    const admin = await svc.authenticate((await svc.login({ email: "asad@acme.pk", password: "river-stone-77x" })).token);
    await assert.rejects(svc.addTeammate(admin, { name: "New Owner", email: "o@acme.pk", password: "river-stone-77z", role: "owner" }), { code: "owner_required" });
    await assert.rejects(svc.updateTeammate(admin, auth.user_id, { disabled: true }), { code: "owner_required" });
  });

  test("disabling a teammate signs them out; owners cannot lock themselves out", async () => {
    const auth = await owner();
    const u = await svc.addTeammate(auth, { name: "Agent Ali", email: "ali@acme.pk", password: "river-stone-77x" });
    const session = (await svc.login({ email: "ali@acme.pk", password: "river-stone-77x" })).token;
    await svc.updateTeammate(auth, u.id, { disabled: true });
    await assert.rejects(svc.authenticate(session), { status: 401 });
    await assert.rejects(svc.updateTeammate(auth, auth.user_id, { role: "agent" }), { code: "cannot_change_self" });
    await assert.rejects(svc.updateTeammate(auth, "usr_missing", { role: "agent" }), { status: 404 });
  });

  test("the last active owner cannot be demoted", async () => {
    const auth = await owner();
    const second = await svc.addTeammate(auth, { name: "Co Owner", email: "co@acme.pk", password: "river-stone-77x", role: "owner" });
    const coAuth = await svc.authenticate((await svc.login({ email: "co@acme.pk", password: "river-stone-77x" })).token);
    await svc.updateTeammate(coAuth, auth.user_id, { role: "admin" });
    const reAuth = await svc.authenticate((await svc.login({ email: "sara@acme.pk", password: PW })).token);
    assert.equal(reAuth.role, "admin");
    await assert.rejects(svc.updateTeammate(reAuth, second.id, { role: "agent" }), { code: "owner_required" });
    // Defence in depth: even a stale owner context cannot leave the workspace without an owner.
    await assert.rejects(svc.updateTeammate(auth, second.id, { role: "agent" }), { code: "last_owner" });
    assert.equal((await svc.listTeam(auth)).find((u) => u.id === second.id).role, "owner", "rolled back");
  });

  test("teammates are isolated per tenant", async () => {
    const auth = await owner();
    const other = await seedTenant(t.db, { name: "Other" });
    assert.equal((await svc.listTeam({ tenant_id: other.id })).length, 0);
    await assert.rejects(svc.updateTeammate({ ...auth, tenant_id: other.id }, auth.user_id + "x", { role: "agent" }), { status: 404 });
  });

  test("changing password keeps this session and ends the others", async () => {
    const r = await signup();
    const auth = await svc.authenticate(r.token);
    const other = (await svc.login({ email: "sara@acme.pk", password: PW })).token;
    await assert.rejects(svc.changePassword(auth, { current_password: "nope", new_password: "maple-quartz-88" }), { status: 400 });
    await assert.rejects(svc.changePassword(auth, { current_password: PW, new_password: "short" }), { status: 400 });
    await svc.changePassword(auth, { current_password: PW, new_password: "maple-quartz-88" });
    assert.ok(await svc.authenticate(r.token));
    await assert.rejects(svc.authenticate(other), { status: 401 });
    assert.ok((await svc.login({ email: "sara@acme.pk", password: "maple-quartz-88" })).token);
    await assert.rejects(svc.changePassword({ tenant_id: auth.tenant_id }, {}), { code: "session_required" });
  });
});
