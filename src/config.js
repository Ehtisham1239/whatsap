import { parseEncryptionKey } from "./lib/crypto.js";
import { loadPrices } from "./lib/pricing.js";

/** Reads and validates configuration. Throws one error listing every problem. */
export function loadConfig(env = process.env) {
  const problems = [];
  const required = (name, check = (v) => v.length > 0, hint = "is required") => {
    const v = env[name];
    if (v === undefined || !check(v)) problems.push(`${name} ${hint}`);
    return v;
  };
  const strong = (v) => v.length >= 32;

  const config = {
    port: Number(env.PORT || 8080),
    databaseUrl: required("DATABASE_URL", (v) => /^postgres(ql)?:\/\//.test(v), "must be a postgres:// connection string"),
    databasePoolMax: Number(env.DATABASE_POOL_MAX || 10),
    databaseSsl: env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" },
    adminToken: required("ADMIN_TOKEN", strong, "must be at least 32 characters"),
    apiKeyPepper: required("API_KEY_PEPPER", strong, "must be at least 32 characters"),
    // Optional until WhatsApp is set up: without them the Meta webhook answers 503.
    metaAppSecret: env.META_APP_SECRET || null,
    metaVerifyToken: env.META_VERIFY_TOKEN || null,
    cronSecret: env.CRON_SECRET || null,
    // Optional: the AI assistant is off without a key.
    anthropicApiKey: env.ANTHROPIC_API_KEY || null,
    aiModel: env.AI_MODEL || "claude-opus-5-5",
    aiEffort: env.AI_EFFORT || "low",
    graphVersion: env.META_GRAPH_VERSION || "v23.0",
    // Only for tests and local mocks of the Graph API.
    metaBaseUrl: env.META_API_BASE_URL || "https://graph.facebook.com",
    defaultCountryCode: env.DEFAULT_COUNTRY_CODE || undefined,
    trustProxy: env.TRUST_PROXY === "true",
    runWorkers: env.RUN_WORKERS !== "false",
    cookieSecure: env.COOKIE_SECURE !== "false",
    allowSignup: env.ALLOW_SIGNUP !== "false",
    signupCredits: Number(env.SIGNUP_CREDITS || 0),
  };
  try {
    config.encryptionKey = parseEncryptionKey(env.TOKEN_ENCRYPTION_KEY);
  } catch (err) {
    problems.push(err.message);
  }
  try {
    config.prices = loadPrices(env);
  } catch (err) {
    problems.push(err.message);
  }
  if (!Number.isInteger(config.databasePoolMax) || config.databasePoolMax < 1 || config.databasePoolMax > 100) problems.push("DATABASE_POOL_MAX must be 1-100");
  if (config.metaVerifyToken && config.metaVerifyToken.length < 16) problems.push("META_VERIFY_TOKEN must be at least 16 characters");
  if (!["low", "medium", "high", "xhigh", "max"].includes(config.aiEffort)) problems.push("AI_EFFORT must be low, medium, high, xhigh or max");
  if (!/^claude-[a-z0-9-]+$/.test(config.aiModel)) problems.push("AI_MODEL must be a Claude model id such as claude-opus-5-5");
  if (config.cronSecret && config.cronSecret.length < 16) problems.push("CRON_SECRET must be at least 16 characters");
  if (!Number.isInteger(config.signupCredits) || config.signupCredits < 0 || config.signupCredits > 1_000_000) problems.push("SIGNUP_CREDITS must be an integer 0-1000000");
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) problems.push("PORT must be 1-65535");
  if (config.defaultCountryCode && !/^[1-9]\d{0,2}$/.test(config.defaultCountryCode)) problems.push("DEFAULT_COUNTRY_CODE must be digits such as 92");
  if (!/^(https:\/\/[^/]+|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)$/.test(config.metaBaseUrl)) problems.push("META_API_BASE_URL must be an https origin (http only for localhost)");
  if (!/^v\d+\.\d+$/.test(config.graphVersion)) problems.push("META_GRAPH_VERSION must look like v23.0");
  if (problems.length) throw new Error(`Invalid configuration:\n- ${problems.join("\n- ")}`);
  return config;
}
