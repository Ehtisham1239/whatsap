import * as repo from "../db/repo.js";
import { AppError, badRequest } from "../lib/errors.js";

export class InsufficientCreditsError extends AppError {
  constructor(required, balance) {
    super(402, "insufficient_credits", `This message needs ${required} credits; wallet balance is ${balance}.`, { required, balance });
  }
}

/** Debits credits for a message inside the caller's transaction and writes a `hold` ledger row. */
export async function holdCredits(q, { tenantId, amount, messageId, now }) {
  if (!Number.isInteger(amount) || amount < 0) throw new TypeError("amount must be a non-negative integer");
  if (amount === 0) return null;
  const balanceAfter = await repo.debitWallet(q, tenantId, amount);
  if (balanceAfter === null) throw new InsufficientCreditsError(amount, await repo.getBalance(q, tenantId));
  return repo.insertLedger(q, { tenantId, kind: "hold", amount: -amount, balanceAfter, messageId, now });
}

/** Returns a message's held credits once (guarded by messages.credits_refunded). */
export async function refundMessage(q, message, { now, note = null }) {
  const amount = await repo.claimRefund(q, message.id);
  if (!amount) return null;
  const balanceAfter = await repo.creditWallet(q, message.tenant_id, amount);
  return repo.insertLedger(q, { tenantId: message.tenant_id, kind: "refund", amount, balanceAfter, messageId: message.id, note, now });
}

/** Adds purchased credits (positive) or applies a signed manual adjustment. */
export async function changeBalance(db, { tenantId, kind, amount, note, now }) {
  if (kind !== "topup" && kind !== "adjustment") throw new TypeError("kind must be topup or adjustment");
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 100_000_000) throw badRequest("amount must be a non-zero integer up to 100,000,000");
  if (kind === "topup" && amount < 0) throw badRequest("a top-up amount must be positive");
  if (kind === "adjustment" && (typeof note !== "string" || !note.trim())) throw badRequest("an adjustment needs a note explaining it");
  return db.tx(async (q) => {
    if (!(await repo.getTenant(q, tenantId))) throw new AppError(404, "not_found", "Tenant not found");
    let balanceAfter;
    if (amount > 0) balanceAfter = await repo.creditWallet(q, tenantId, amount);
    else {
      balanceAfter = await repo.debitWallet(q, tenantId, -amount);
      if (balanceAfter === null) throw new InsufficientCreditsError(-amount, await repo.getBalance(q, tenantId));
    }
    return repo.insertLedger(q, { tenantId, kind, amount, balanceAfter, note: note ?? null, now });
  });
}
