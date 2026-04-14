const dotenv = require("dotenv");

dotenv.config({ quiet: true });

const ENV_NAMES = Object.freeze({
  controllerUrl: "OMADA_CONTROLLER_URL",
  omadaId: "OMADA_ID",
  clientId: "OMADA_CLIENT_ID",
  clientSecret: "OMADA_CLIENT_SECRET",
  username: "OMADA_USERNAME",
  password: "OMADA_PASSWORD"
});

const OMADA_CLOUD_OPENAPI_HOSTS = Object.freeze({
  aps1: "https://aps1-omada-northbound.tplinkcloud.com",
  use1: "https://use1-omada-northbound.tplinkcloud.com",
  euw1: "https://euw1-omada-northbound.tplinkcloud.com"
});

function parseBoolean(value, defaultValue) {
  if (value == null || value === "") {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function parseInteger(value, defaultValue, { min, max } = {}) {
  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed)) {
    return defaultValue;
  }

  if (min != null && parsed < min) {
    return min;
  }

  if (max != null && parsed > max) {
    return max;
  }

  return parsed;
}

function normalizeBaseUrl(rawValue) {
  if (!rawValue) {
    return "";
  }

  return rawValue.trim().replace(/\/+$/, "");
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function getCloudOpenApiUrls(region, explicitUrl) {
  const normalizedExplicit = normalizeBaseUrl(explicitUrl);

  if (normalizedExplicit) {
    return [normalizedExplicit];
  }

  const normalizedRegion = String(region || "auto").trim().toLowerCase();

  if (OMADA_CLOUD_OPENAPI_HOSTS[normalizedRegion]) {
    return [OMADA_CLOUD_OPENAPI_HOSTS[normalizedRegion]];
  }

  return [
    OMADA_CLOUD_OPENAPI_HOSTS.aps1,
    OMADA_CLOUD_OPENAPI_HOSTS.use1,
    OMADA_CLOUD_OPENAPI_HOSTS.euw1
  ];
}

function isPrivateControllerUrl(rawValue) {
  const normalized = normalizeBaseUrl(rawValue);

  if (!normalized) {
    return false;
  }

  try {
    const hostname = new URL(normalized).hostname.toLowerCase();

    if (hostname === "localhost" || hostname === "::1") {
      return true;
    }

    if (/^127\./.test(hostname) || /^10\./.test(hostname) || /^192\.168\./.test(hostname)) {
      return true;
    }

    const match172 = hostname.match(/^172\.(\d{1,2})\./);

    if (match172) {
      const secondOctet = Number(match172[1]);
      return secondOctet >= 16 && secondOctet <= 31;
    }

    return hostname.endsWith(".local");
  } catch (error) {
    return false;
  }
}

function resolveControllerUrls(env = process.env) {
  const localControllerUrl = normalizeBaseUrl(env.OMADA_CONTROLLER_URL);
  const cloudUrls = getCloudOpenApiUrls(env.OMADA_CLOUD_REGION, env.OMADA_CLOUD_CONTROLLER_URL);
  const shouldUseCloud =
    parseBoolean(env.OMADA_USE_CLOUD_OPENAPI, Boolean(env.VERCEL) && isPrivateControllerUrl(localControllerUrl));

  if (shouldUseCloud) {
    return uniqueValues([...cloudUrls, ...(isPrivateControllerUrl(localControllerUrl) ? [] : [localControllerUrl])]);
  }

  return uniqueValues([localControllerUrl]);
}

function normalizeAuthMode(rawValue) {
  const value = String(rawValue || "client_credentials").trim().toLowerCase();

  if (["authorization_code", "authorization-code", "auth_code", "auth-code"].includes(value)) {
    return "authorization_code";
  }

  return "client_credentials";
}

const controllerUrls = resolveControllerUrls(process.env);
const config = Object.freeze({
  port: parseInteger(process.env.PORT, 3000, { min: 1, max: 65535 }),
  controllerUrl: controllerUrls[0] || "",
  controllerUrls,
  omadaId: String(process.env.OMADA_ID || "").trim(),
  clientId: String(process.env.OMADA_CLIENT_ID || "").trim(),
  clientSecret: String(process.env.OMADA_CLIENT_SECRET || "").trim(),
  username: String(process.env.OMADA_USERNAME || "").trim(),
  password: String(process.env.OMADA_PASSWORD || "").trim(),
  authMode: normalizeAuthMode(process.env.OMADA_AUTH_MODE),
  insecureTls: parseBoolean(process.env.OMADA_INSECURE_TLS, true),
  defaultSiteId: String(process.env.OMADA_SITE_ID || "").trim(),
  defaultSiteName: String(process.env.OMADA_SITE_NAME || "").trim(),
  defaultVoucherGroupId: String(process.env.OMADA_VOUCHER_GROUP_ID || "").trim(),
  defaultVoucherGroupName: String(process.env.OMADA_VOUCHER_GROUP_NAME || "").trim(),
  defaultStatus: String(process.env.OMADA_VOUCHER_STATUS || "").trim(),
  defaultPageSize: parseInteger(process.env.OMADA_PAGE_SIZE, 50, { min: 1, max: 1000 }),
  requestTimeoutMs: parseInteger(process.env.OMADA_TIMEOUT_MS, 20000, { min: 1000 }),
  speedTestEmbedUrl: String(process.env.SPEEDTEST_EMBED_URL || "https://fast.com/").trim()
});

if (config.insecureTls) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

function getMissingConfig(overrides = {}) {
  const effective = {
    ...config,
    ...overrides
  };

  const requiredKeys = ["controllerUrl", "omadaId", "clientId", "clientSecret"];

  if (normalizeAuthMode(effective.authMode) === "authorization_code") {
    requiredKeys.push("username", "password");
  }

  return requiredKeys
    .filter((key) => !String(effective[key] || "").trim())
    .map((key) => ENV_NAMES[key]);
}

module.exports = {
  OMADA_CLOUD_OPENAPI_HOSTS,
  config,
  getMissingConfig,
  isPrivateControllerUrl,
  resolveControllerUrls,
  normalizeAuthMode
};
