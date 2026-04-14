const test = require("node:test");
const assert = require("node:assert/strict");

function loadConfigWithEnv(env) {
  const configPath = require.resolve("../src/config");
  const previousEnv = {};
  const keys = [
    "VERCEL",
    "OMADA_CONTROLLER_URL",
    "OMADA_CLOUD_REGION",
    "OMADA_CLOUD_CONTROLLER_URL",
    "OMADA_USE_CLOUD_OPENAPI"
  ];

  for (const key of keys) {
    previousEnv[key] = process.env[key];
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      process.env[key] = env[key];
    } else {
      delete process.env[key];
    }
  }

  delete require.cache[configPath];
  const loaded = require("../src/config");

  for (const key of keys) {
    if (previousEnv[key] == null) {
      delete process.env[key];
    } else {
      process.env[key] = previousEnv[key];
    }
  }

  delete require.cache[configPath];
  return loaded;
}

test("Vercel deployment uses cloud OpenAPI when controller URL is private", () => {
  const { config } = loadConfigWithEnv({
    VERCEL: "1",
    OMADA_CONTROLLER_URL: "https://192.168.1.50:443",
    OMADA_CLOUD_REGION: "aps1"
  });

  assert.equal(config.controllerUrl, "https://aps1-omada-northbound.tplinkcloud.com");
  assert.deepEqual(config.controllerUrls, ["https://aps1-omada-northbound.tplinkcloud.com"]);
});

test("local development keeps the configured private controller URL", () => {
  const { config } = loadConfigWithEnv({
    OMADA_CONTROLLER_URL: "https://192.168.1.50:443",
    OMADA_CLOUD_REGION: "aps1"
  });

  assert.equal(config.controllerUrl, "https://192.168.1.50:443");
  assert.deepEqual(config.controllerUrls, ["https://192.168.1.50:443"]);
});
