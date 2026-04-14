const test = require("node:test");
const assert = require("node:assert/strict");

function loadConfigWithEnv(env) {
  const configPath = require.resolve("../src/config");
  const previousEnv = {};
  const keys = [
    "HOST",
    "OMADA_CONTROLLER_URL",
    "OMADA_AUTH_MODE"
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

test("configuration keeps the local OC200 controller URL", () => {
  const { config } = loadConfigWithEnv({
    OMADA_CONTROLLER_URL: "https://192.168.1.50:443"
  });

  assert.equal(config.controllerUrl, "https://192.168.1.50:443");
});

test("configuration binds to all interfaces by default for same-LAN access", () => {
  const { config } = loadConfigWithEnv({
    OMADA_CONTROLLER_URL: "https://192.168.1.50:443"
  });

  assert.equal(config.host, "0.0.0.0");
});

test("configuration allows overriding host for locked-down local installs", () => {
  const { config } = loadConfigWithEnv({
    HOST: "127.0.0.1",
    OMADA_CONTROLLER_URL: "https://192.168.1.50:443"
  });

  assert.equal(config.host, "127.0.0.1");
});
