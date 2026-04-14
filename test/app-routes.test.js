const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createApp } = require("../src/app");

const testConfig = {
  authMode: "client_credentials",
  controllerUrl: "",
  omadaId: "",
  clientId: "",
  clientSecret: "",
  defaultSiteId: "",
  defaultSiteName: "",
  defaultVoucherGroupId: "",
  defaultVoucherGroupName: "",
  defaultPageSize: 50,
  requestTimeoutMs: 1000,
  insecureTls: true,
  speedTestEmbedUrl: "https://fast.com/"
};

async function startTestServer(t, config = testConfig) {
  const server = http.createServer(createApp(config));

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

test("extensionless page routes fall back to the app shell", async (t) => {
  const baseUrl = await startTestServer(t);

  const response = await fetch(`${baseUrl}/voucher/status/554339`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(body, /voucher-form/);
});

test("unknown API routes still return 404 instead of the app shell", async (t) => {
  const baseUrl = await startTestServer(t);

  const response = await fetch(`${baseUrl}/api/missing-route`);

  assert.equal(response.status, 404);
});

test("unreachable Omada controller returns a clear gateway error", async (t) => {
  const baseUrl = await startTestServer(t, {
    ...testConfig,
    controllerUrl: "http://127.0.0.1:1",
    omadaId: "test-omada-id",
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    requestTimeoutMs: 500
  });

  const response = await fetch(`${baseUrl}/api/voucher-status?code=449380`);
  const body = await response.json();

  assert.equal(response.status, 502);
  assert.equal(body.ok, false);
  assert.match(body.error, /not reachable/);
});
