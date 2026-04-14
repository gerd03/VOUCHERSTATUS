const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function createElement() {
  return {
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll() { return []; },
    querySelector() { return null; },
    closest() { return null; },
    setAttribute() {},
    removeAttribute() {},
    focus() {},
    classList: {
      add() {},
      remove() {},
      contains() { return false; }
    },
    style: {},
    innerHTML: "",
    textContent: "",
    value: "",
    disabled: false
  };
}

function loadFrontendContext() {
  const elements = new Map();
  const documentStub = {
    body: createElement(),
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, createElement());
      }
      return elements.get(id);
    }
  };
  const locationStub = { search: "" };
  const historyStub = { replaceState() {} };
  const windowStub = {
    addEventListener() {},
    history: historyStub,
    location: locationStub,
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout,
    clearTimeout,
    EventSource: function EventSource() {}
  };

  const context = {
    console,
    Date,
    Math,
    JSON,
    URLSearchParams,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    document: documentStub,
    navigator: { onLine: true },
    window: windowStub,
    history: historyStub,
    location: locationStub,
    EventSource: function EventSource() {}
  };

  const source = fs.readFileSync("public/app.js", "utf8");
  const vmContext = vm.createContext(context);
  vm.runInContext(source, vmContext);
  return vmContext;
}

test("traffic ring uses Omada voucher meter instead of session totals when traffic limits exist", () => {
  const context = loadFrontendContext();
  const payload = {
    voucher: {
      trafficLimit: 100,
      trafficUsed: 38178160,
      trafficUnused: 66679440
    },
    usage: {
      source: "client_live",
      voucherMeterBytes: 38178160,
      totalBytes: 59500000,
      displayTotalBytes: 59500000,
      snapshotFresh: false,
      effectiveActive: false
    }
  };

  assert.equal(context.getDisplayDataUsed(payload), 38178160);
  assert.equal(context.getDisplayTrafficRemainingBytes(payload), 66679440);
});

test("auto-pause voucher accepts Omada corrected used time after client goes offline", () => {
  const context = loadFrontendContext();

  vm.runInContext(`
    currentPayload = {
      voucher: {
        code: "554339",
        timeUsedSec: 442,
        timeLeftSec: 10358,
        timingByClientUsage: true
      },
      group: {
        duration: 180,
        timingType: 1
      },
      usage: {
        active: false,
        onlineClients: 0
      }
    };
    payloadReceivedAtMs = Date.now();
  `, context);

  const stabilized = vm.runInContext(`
    stabilizeIncomingPayload({
      voucher: {
        code: "554339",
        timeUsedSec: 242,
        timeLeftSec: 10558,
        timingByClientUsage: true
      },
      group: {
        duration: 180,
        timingType: 1
      },
      usage: {
        active: false,
        onlineClients: 0
      }
    })
  `, context);

  assert.equal(stabilized.voucher.timeUsedSec, 242);
  assert.equal(stabilized.voucher.timeLeftSec, 10558);
});

test("auto-pause voucher clock ticks locally while Omada reports an active client", () => {
  const context = loadFrontendContext();

  vm.runInContext('connectionState = "live";', context);

  const shouldAdvance = context.shouldAdvanceVoucherClock(
    {
      voucher: {
        code: "554339",
        timeUsedSec: 242,
        timeLeftSec: 10558,
        timingByClientUsage: true
      },
      group: {
        duration: 180,
        timingType: 1
      }
    },
    {
      active: true,
      onlineClients: 1,
      snapshotFresh: true,
      effectiveActive: true,
      displayLiveDownloadBytesPerSec: 1024,
      displayLiveUploadBytesPerSec: 512
    }
  );

  assert.equal(shouldAdvance, true);
});

test("auto-pause voucher clock does not invent local used time while client is offline", () => {
  const context = loadFrontendContext();

  vm.runInContext('connectionState = "live";', context);

  const shouldAdvance = context.shouldAdvanceVoucherClock(
    {
      voucher: {
        code: "554339",
        timeUsedSec: 242,
        timeLeftSec: 10558,
        timingByClientUsage: true
      },
      group: {
        duration: 180,
        timingType: 1
      },
      usage: {
        active: false,
        onlineClients: 0
      }
    },
    {
      active: false,
      onlineClients: 0,
      snapshotFresh: true,
      effectiveActive: false,
      displayLiveDownloadBytesPerSec: 0,
      displayLiveUploadBytesPerSec: 0
    }
  );

  assert.equal(shouldAdvance, false);
});

test("auto-pause voucher accepts fresh Omada timer jumps instead of clamping to one second", () => {
  const context = loadFrontendContext();

  vm.runInContext(`
    currentPayload = {
      voucher: {
        code: "554339",
        timeUsedSec: 340,
        timeLeftSec: 10460,
        timingByClientUsage: true
      },
      group: {
        duration: 180,
        timingType: 1
      },
      usage: {
        active: true,
        onlineClients: 1
      }
    };
    connectionState = "live";
    payloadReceivedAtMs = Date.now();
  `, context);

  const stabilized = vm.runInContext(`
    stabilizeIncomingPayload({
      voucher: {
        code: "554339",
        timeUsedSec: 345,
        timeLeftSec: 10455,
        timingByClientUsage: true
      },
      group: {
        duration: 180,
        timingType: 1
      },
      usage: {
        active: true,
        onlineClients: 1
      }
    })
  `, context);

  assert.equal(stabilized.voucher.timeUsedSec, 345);
  assert.equal(stabilized.voucher.timeLeftSec, 10455);
});
