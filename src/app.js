const express = require("express");
const path = require("path");
const { OmadaApiError, OmadaClient } = require("./omada-client");
const { getMissingConfig } = require("./config");

const STREAM_INTERVAL_MS = 1000;
const STREAM_RETRY_MS = 3000;
const STREAM_HEARTBEAT_MS = 15000;

function createApp(config) {
  const app = express();
  const omadaClient = new OmadaClient(config);
  const publicDir = path.join(__dirname, "..", "public");
  const hotspotLogoDir = path.join(__dirname, "..", "hotspotlogo");
  const faviconPath = path.join(hotspotLogoDir, "HOTSPOT LOGO.png");

  app.use(express.json());
  app.use("/api", (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store, max-age=0");
    next();
  });
  app.use(
    "/hotspotlogo",
    express.static(hotspotLogoDir, {
      etag: false,
      lastModified: false,
      setHeaders: (response) => {
        response.setHeader("Cache-Control", "no-store, max-age=0");
      }
    })
  );
  app.use(
    express.static(publicDir, {
      etag: false,
      lastModified: false,
      setHeaders: (response) => {
        response.setHeader("Cache-Control", "no-store, max-age=0");
      }
    })
  );

  app.get("/favicon.ico", (_request, response) => {
    response.setHeader("Cache-Control", "no-store, max-age=0");
    response.type("png").sendFile(faviconPath);
  });

  app.get("/api/health", (_request, response) => {
    response.json({
      ok: true,
      time: new Date().toISOString()
    });
  });

  app.get("/api/public-config", (_request, response) => {
    response.json({
      ok: true,
      speedTestEmbedUrl: config.speedTestEmbedUrl || "https://fast.com/"
    });
  });

  async function handleVoucherStatus(request, response) {
    try {
      const result = await lookupVoucherStatus(request.query, config, omadaClient);

      response.json({
        ok: true,
        ...result
      });
    } catch (error) {
      const normalized = error instanceof OmadaApiError ? error : new OmadaApiError(error.message, null, null);

      response.status(resolveStatusCode(normalized)).json({
        ok: false,
        error: normalized.message,
        code: normalized.code,
        details: normalized.details
      });
    }
  }

  async function handleVoucherStatusStream(request, response) {
    try {
      await ensureVoucherLookupRequest(request.query, config);
    } catch (error) {
      const normalized = error instanceof OmadaApiError ? error : new OmadaApiError(error.message, null, null);
      response.status(resolveStatusCode(normalized)).json({
        ok: false,
        error: normalized.message,
        code: normalized.code,
        details: normalized.details
      });
      return;
    }

    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");

    if (typeof response.flushHeaders === "function") {
      response.flushHeaders();
    }

    response.write(`retry: ${STREAM_RETRY_MS}\n\n`);

    let closed = false;
    let inFlight = false;

    const sendEvent = (eventName, payload) => {
      if (closed) {
        return;
      }

      response.write(`event: ${eventName}\n`);
      response.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const sendVoucherUpdate = async () => {
      if (closed || inFlight) {
        return;
      }

      inFlight = true;

      try {
        const result = await lookupVoucherStatus(request.query, config, omadaClient);
        sendEvent("voucher", {
          ok: true,
          ...result
        });
      } catch (error) {
        const normalized = error instanceof OmadaApiError ? error : new OmadaApiError(error.message, null, null);
        sendEvent("voucher-error", {
          ok: false,
          error: normalized.message,
          code: normalized.code,
          status: resolveStatusCode(normalized)
        });
      } finally {
        inFlight = false;
      }
    };

    const intervalId = setInterval(sendVoucherUpdate, STREAM_INTERVAL_MS);
    const heartbeatId = setInterval(() => {
      if (!closed) {
        response.write(": ping\n\n");
      }
    }, STREAM_HEARTBEAT_MS);

    sendVoucherUpdate().catch(() => {});

    request.on("close", () => {
      closed = true;
      clearInterval(intervalId);
      clearInterval(heartbeatId);
      response.end();
    });
  }

  app.get("/api/voucher-status", handleVoucherStatus);
  app.get("/api/vouchers", handleVoucherStatus);
  app.get("/api/voucher-status/stream", handleVoucherStatusStream);
  app.get("/api/vouchers/stream", handleVoucherStatusStream);

  app.get(/^(?!\/api(?:\/|$)).*/, (request, response, next) => {
    if (path.extname(request.path)) {
      next();
      return;
    }

    response.setHeader("Cache-Control", "no-store, max-age=0");
    response.sendFile(path.join(publicDir, "index.html"));
  });

  return app;
}

async function lookupVoucherStatus(query, config, omadaClient) {
  await ensureVoucherLookupRequest(query, config);
  const lookup = buildLookup(query, config);
  return omadaClient.getVoucherStatusByCode(lookup);
}

async function ensureVoucherLookupRequest(query, config) {
  const missing = getMissingConfig(config);

  if (missing.length) {
    throw new OmadaApiError("Missing required Omada client checker configuration.", 400, {
      missing
    });
  }

  const lookup = buildLookup(query, config);

  if (!lookup.code) {
    throw new OmadaApiError("Voucher code is required.", 400, null);
  }
}

function buildLookup(query, config) {
  return {
    code: firstValue(query.code),
    siteId: firstValue(query.siteId, config.defaultSiteId),
    siteName: firstValue(query.siteName, config.defaultSiteName),
    groupId: firstValue(query.groupId, config.defaultVoucherGroupId),
    groupName: firstValue(query.groupName, config.defaultVoucherGroupName)
  };
}

function firstValue(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      if (value.length > 0 && String(value[0]).trim() !== "") {
        return String(value[0]).trim();
      }

      continue;
    }

    if (value != null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }

  return "";
}

function resolveStatusCode(error) {
  if ([400, 401, 403, 404, 409, 500, 502, 503, 504].includes(error.code)) {
    return error.code;
  }

  if ([-44106, -44111, -44112, -44113].includes(error.code)) {
    return 401;
  }

  if ([-1005, -1007].includes(error.code)) {
    return 403;
  }

  if ([-33000, -33004].includes(error.code)) {
    return 502;
  }

  return 500;
}

module.exports = {
  createApp
};
