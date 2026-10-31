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
    metaAppSecret: required("META_APP_SECRET"),
    metaVerifyToken: required("META_VERIFY_TOKEN", (v) => v.length >= 16, "must be at least 16 characters"),
    graphVersion: env.META_GRAPH_VERSION || "v23.0",
    // Only for tests and local mocks of the Graph API.
    metaBaseUrl: env.META_API_BASE_URL || "https://graph.facebook.com",
    defaultCountryCode: env.DEFAULT_COUNTRY_CODE || undefined,
    trustProxy: env.TRUST_PROXY === "true",
    runWorkers: env.RUN_WORKERS !== "false",
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
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) problems.push("PORT must be 1-65535");
  if (config.defaultCountryCode && !/^[1-9]\d{0,2}$/.test(config.defaultCountryCode)) problems.push("DEFAULT_COUNTRY_CODE must be digits such as 92");
  if (!/^(https:\/\/[^/]+|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)$/.test(config.metaBaseUrl)) problems.push("META_API_BASE_URL must be an https origin (http only for localhost)");
  if (!/^v\d+\.\d+$/.test(config.graphVersion)) problems.push("META_GRAPH_VERSION must look like v23.0");
  if (problems.length) throw new Error(`Invalid configuration:\n- ${problems.join("\n- ")}`);
  return config;
}
