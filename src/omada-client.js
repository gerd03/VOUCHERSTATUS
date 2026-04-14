const https = require("https");
const axios = require("axios");

const STATUS_LABELS = Object.freeze({
  0: "Unused",
  1: "In Use",
  2: "Expired"
});

const AUTH_TYPE_VOUCHER = 3;

class OmadaApiError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = "OmadaApiError";
    this.code = code ?? null;
    this.details = details ?? null;
  }
}

class OmadaClient {
  constructor(config) {
    this.config = config;
    this.tokenState = null;
    this.http = axios.create({
      baseURL: config.controllerUrl,
      timeout: config.requestTimeoutMs,
      httpsAgent: new https.Agent({
        rejectUnauthorized: !config.insecureTls
      }),
      headers: {
        "Content-Type": "application/json"
      }
    });
  }

  async ensureAccessToken() {
    if (!this.isTokenExpired()) {
      return this.tokenState.accessToken;
    }

    if (this.tokenState?.refreshToken) {
      try {
        await this.refreshAccessToken();
        return this.tokenState.accessToken;
      } catch (error) {
        this.tokenState = null;
      }
    }

    await this.authenticate();
    return this.tokenState.accessToken;
  }

  isTokenExpired(bufferMs = 60_000) {
    if (!this.tokenState?.accessToken || !this.tokenState?.expiresAt) {
      return true;
    }

    return Date.now() >= this.tokenState.expiresAt - bufferMs;
  }

  async authenticate() {
    if (this.config.authMode === "authorization_code") {
      const session = await this.login();
      const code = await this.getAuthorizationCode(session);
      const result = await this.exchangeAuthorizationCode(code);
      return this.storeTokenState(result);
    }

    const result = await this.getClientCredentialsToken();
    return this.storeTokenState(result);
  }

  async login() {
    return this.requestAuth("post", "/openapi/authorize/login", {
      params: {
        client_id: this.config.clientId,
        omadac_id: this.config.omadaId
      },
      data: {
        username: this.config.username,
        password: this.config.password
      }
    });
  }

  async getAuthorizationCode(session) {
    return this.requestAuth("post", "/openapi/authorize/code", {
      params: {
        client_id: this.config.clientId,
        omadac_id: this.config.omadaId,
        response_type: "code"
      },
      headers: {
        "Csrf-Token": session.csrfToken,
        Cookie: `TPOMADA_SESSIONID=${session.sessionId}`
      }
    });
  }

  async exchangeAuthorizationCode(code) {
    return this.requestAuth("post", "/openapi/authorize/token", {
      params: {
        grant_type: "authorization_code",
        code
      },
      data: {
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret
      }
    });
  }

  async getClientCredentialsToken() {
    return this.requestAuth("post", "/openapi/authorize/token", {
      params: {
        grant_type: "client_credentials"
      },
      data: {
        omadacId: this.config.omadaId,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret
      }
    });
  }

  async refreshAccessToken() {
    if (!this.tokenState?.refreshToken) {
      throw new OmadaApiError("No refresh token is available.", null, null);
    }

    const result = await this.requestAuth("post", "/openapi/authorize/token", {
      params: {
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: this.tokenState.refreshToken,
        grant_type: "refresh_token"
      },
      data: {}
    });

    return this.storeTokenState(result);
  }

  async request(method, path, { params, data, retryOnAuth = true } = {}) {
    const accessToken = await this.ensureAccessToken();

    try {
      const response = await this.http.request({
        method,
        url: path,
        params,
        data,
        headers: {
          Authorization: `AccessToken=${accessToken}`
        }
      });

      return this.unwrapEnvelope(response.data);
    } catch (error) {
      if (retryOnAuth && this.isAuthenticationError(error)) {
        await this.recoverAuthentication();
        return this.request(method, path, { params, data, retryOnAuth: false });
      }

      throw this.normalizeError(error);
    }
  }

  async requestAuth(method, path, { params, data, headers } = {}) {
    try {
      const response = await this.http.request({
        method,
        url: path,
        params,
        data,
        headers
      });

      return this.unwrapEnvelope(response.data);
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  async recoverAuthentication() {
    if (this.tokenState?.refreshToken) {
      try {
        await this.refreshAccessToken();
        return;
      } catch (error) {
        this.tokenState = null;
      }
    }

    await this.authenticate();
  }

  unwrapEnvelope(payload) {
    if (!payload || typeof payload !== "object") {
      return payload;
    }

    if (Object.prototype.hasOwnProperty.call(payload, "errorCode")) {
      if (payload.errorCode !== 0) {
        throw new OmadaApiError(payload.msg || "Omada API request failed.", payload.errorCode, payload);
      }

      return payload.result;
    }

    return payload;
  }

  isAuthenticationError(error) {
    const normalized = this.normalizeError(error);
    return [-44111, -44112, -44113].includes(normalized.code);
  }

  normalizeError(error) {
    if (error instanceof OmadaApiError) {
      return error;
    }

    const payload = error?.response?.data;

    if (payload && typeof payload === "object" && Object.prototype.hasOwnProperty.call(payload, "errorCode")) {
      return new OmadaApiError(payload.msg || "Omada API request failed.", payload.errorCode, payload);
    }

    return new OmadaApiError(
      error?.message || "Unexpected Omada API error.",
      error?.response?.status ?? null,
      payload ?? null
    );
  }

  storeTokenState(result) {
    const expiresInSeconds = Number(result?.expiresIn || 0);
    const accessToken = result?.accessToken;

    if (!accessToken) {
      throw new OmadaApiError("Omada did not return an access token.", null, result);
    }

    this.tokenState = {
      accessToken,
      refreshToken: result?.refreshToken || null,
      tokenType: result?.tokenType || "bearer",
      expiresIn: expiresInSeconds,
      expiresAt: Date.now() + expiresInSeconds * 1000
    };

    return this.tokenState;
  }

  async listSites({ page = 1, pageSize = 1000, searchKey } = {}) {
    return this.request("get", `/openapi/v1/${this.config.omadaId}/sites`, {
      params: {
        page,
        pageSize,
        ...(searchKey ? { searchKey } : {})
      }
    });
  }

  async listVoucherGroups({ siteId, page = 1, pageSize = 1000, searchKey } = {}) {
    return this.request(
      "get",
      `/openapi/v1/${this.config.omadaId}/sites/${encodeURIComponent(siteId)}/hotspot/voucher-groups`,
      {
        params: {
          page,
          pageSize,
          ...(searchKey ? { searchKey } : {})
        }
      }
    );
  }

  async getVoucherGroupDetail({ siteId, groupId, page = 1, pageSize = 50, status, searchKey } = {}) {
    return this.request(
      "get",
      `/openapi/v1/${this.config.omadaId}/sites/${encodeURIComponent(siteId)}/hotspot/voucher-groups/${encodeURIComponent(groupId)}`,
      {
        params: {
          page,
          pageSize,
          ...(status != null ? { "filters.status": status } : {}),
          ...(searchKey ? { searchKey } : {})
        }
      }
    );
  }

  async findVoucherByCode({ code, siteId, siteName, groupId, groupName } = {}) {
    const normalizedCode = normalizeVoucherCode(code);

    if (!normalizedCode) {
      throw new OmadaApiError("Voucher code is required.", 400, null);
    }

    const site = await this.resolveSite({ siteId, siteName });
    const groupGrid = await this.listVoucherGroups({
      siteId: site.id,
      page: 1,
      pageSize: 1000,
      searchKey: groupName || undefined
    });

    const groups = (groupGrid?.data || []).map(normalizeGroup);
    const selectedGroups = pickCandidateGroups(groups, groupId, groupName);

    if (!selectedGroups.length) {
      throw new OmadaApiError("No voucher groups are available for this site.", 404, {
        siteId: site.id
      });
    }

    for (const group of selectedGroups) {
      const groupDetail = await this.getVoucherGroupDetail({
        siteId: site.id,
        groupId: group.id,
        page: 1,
        pageSize: this.config.defaultPageSize,
        searchKey: normalizedCode
      });

      let voucher = findVoucherInGroupDetail(groupDetail, normalizedCode);

      if (voucher) {
        const usage = await this.getVoucherUsageSummary({
          siteId: site.id,
          normalizedCode,
          voucher
        });

        return {
          authMode: this.config.authMode,
          checkedAt: new Date().toISOString(),
          site,
          group: mergeGroupWithDetail(group, groupDetail),
          voucher,
          usage
        };
      }

      voucher = await this.findVoucherByCodeInGroupPages({
        siteId: site.id,
        groupId: group.id,
        normalizedCode,
        initialDetail: groupDetail
      });

      if (voucher) {
        const usage = await this.getVoucherUsageSummary({
          siteId: site.id,
          normalizedCode,
          voucher
        });

        return {
          authMode: this.config.authMode,
          checkedAt: new Date().toISOString(),
          site,
          group: mergeGroupWithDetail(group, groupDetail),
          voucher,
          usage
        };
      }
    }

    throw new OmadaApiError("Voucher code not found.", 404, {
      code: normalizedCode,
      siteId: site.id
    });
  }

  async getVoucherStatusByCode(lookup = {}) {
    const result = await this.findVoucherByCode(lookup);
    return result;
  }

  async buildVoucherStatusReport(filters) {
    const site = await this.resolveSite(filters);
    const groupGrid = await this.listVoucherGroups({
      siteId: site.id,
      page: 1,
      pageSize: 1000,
      searchKey: filters.groupName || undefined
    });

    const groups = (groupGrid?.data || []).map(normalizeGroup);
    const selectedGroup = pickGroup(groups, filters.groupId, filters.groupName);

    if (!selectedGroup) {
      return {
        authMode: this.config.authMode,
        site,
        filters: {
          status: filters.status ?? null,
          page: filters.page,
          pageSize: filters.pageSize
        },
        groups,
        selectedGroup: null,
        vouchers: [],
        pagination: {
          page: filters.page,
          pageSize: filters.pageSize,
          totalRows: 0
        }
      };
    }

    const groupDetail = await this.getVoucherGroupDetail({
      siteId: site.id,
      groupId: selectedGroup.id,
      page: filters.page,
      pageSize: filters.pageSize,
      status: filters.status
    });

    return {
      authMode: this.config.authMode,
      site,
      filters: {
        status: filters.status ?? null,
        page: filters.page,
        pageSize: filters.pageSize
      },
      groups,
      selectedGroup: normalizeGroupDetail(groupDetail),
      vouchers: (groupDetail?.data || []).map(normalizeVoucher),
      pagination: {
        page: groupDetail?.currentPage || filters.page,
        pageSize: groupDetail?.currentSize || filters.pageSize,
        totalRows: groupDetail?.totalRows || 0
      }
    };
  }

  async resolveSite({ siteId, siteName }) {
    const siteGrid = await this.listSites({
      page: 1,
      pageSize: 1000,
      searchKey: siteName || undefined
    });

    const sites = (siteGrid?.data || []).map(normalizeSite);

    if (!sites.length) {
      throw new OmadaApiError("No sites were returned by Omada.", null, siteGrid);
    }

    if (siteId) {
      const match = sites.find((site) => site.id === siteId);

      if (!match) {
        throw new OmadaApiError(`Site ID "${siteId}" was not found.`, null, siteGrid);
      }

      return match;
    }

    if (siteName) {
      const exactMatch = sites.find((site) => site.name.toLowerCase() === siteName.toLowerCase());

      if (exactMatch) {
        return exactMatch;
      }

      if (sites.length === 1) {
        return sites[0];
      }

      throw new OmadaApiError(`Could not resolve a unique site named "${siteName}".`, null, siteGrid);
    }

    const primarySite = sites.find((site) => site.primary);
    return primarySite || sites[0];
  }

  async findVoucherByCodeInGroupPages({ siteId, groupId, normalizedCode, initialDetail }) {
    const totalRows = Number(initialDetail?.totalRows || 0);
    const currentSize = Number(initialDetail?.currentSize || this.config.defaultPageSize || 50);

    if (!totalRows || totalRows <= currentSize) {
      return null;
    }

    const totalPages = Math.ceil(totalRows / currentSize);

    for (let page = 2; page <= totalPages; page += 1) {
      const detail = await this.getVoucherGroupDetail({
        siteId,
        groupId,
        page,
        pageSize: currentSize
      });

      const voucher = findVoucherInGroupDetail(detail, normalizedCode);

      if (voucher) {
        return voucher;
      }
    }

    return null;
  }

  async listClients({ siteId, page = 1, pageSize = 1000, scope = 0 } = {}) {
    return this.request("post", `/openapi/v2/${this.config.omadaId}/sites/${encodeURIComponent(siteId)}/clients`, {
      data: {
        page,
        pageSize,
        scope
      }
    });
  }

  async listAllClients({ siteId, scope = 0, pageSize = 1000 } = {}) {
    const firstPage = await this.listClients({
      siteId,
      page: 1,
      pageSize,
      scope
    });

    const clients = (firstPage?.data || []).map(normalizeClient);
    const totalRows = Number(firstPage?.totalRows || clients.length || 0);

    if (!totalRows || totalRows <= clients.length) {
      return clients;
    }

    const totalPages = Math.ceil(totalRows / pageSize);

    for (let page = 2; page <= totalPages; page += 1) {
      const nextPage = await this.listClients({
        siteId,
        page,
        pageSize,
        scope
      });

      clients.push(...(nextPage?.data || []).map(normalizeClient));
    }

    return clients;
  }

  async getVoucherUsageSummary({ siteId, normalizedCode, voucher } = {}) {
    try {
      const clients = await this.listAllClients({
        siteId,
        scope: 0,
        pageSize: 1000
      });

      const matches = clients.filter((client) => hasVoucherCodeMatch(client, normalizedCode));
      return summarizeVoucherUsage(matches, voucher);
    } catch (error) {
      return summarizeVoucherUsage([], voucher);
    }
  }
}

function pickGroup(groups, groupId, groupName) {
  if (!groups.length) {
    return null;
  }

  if (groupId) {
    return groups.find((group) => group.id === groupId) || null;
  }

  if (groupName) {
    return groups.find((group) => group.name.toLowerCase() === groupName.toLowerCase()) || null;
  }

  return groups[0];
}

function pickCandidateGroups(groups, groupId, groupName) {
  if (!groups.length) {
    return [];
  }

  if (groupId) {
    const match = groups.find((group) => group.id === groupId);
    return match ? [match] : [];
  }

  if (groupName) {
    const match = groups.find((group) => group.name.toLowerCase() === groupName.toLowerCase());
    return match ? [match] : [];
  }

  return groups;
}

function normalizeSite(site) {
  return {
    id: site.siteId || site.id || "",
    name: site.name || "",
    region: site.region || "",
    type: site.type ?? null,
    scenario: site.scenario || "",
    timeZone: site.timeZone || "",
    primary: Boolean(site.primary)
  };
}

function normalizeGroup(group) {
  const pricing = normalizeGroupPricing(group);

  return {
    id: group.id,
    name: group.name || "",
    createdTime: group.createdTime || null,
    creatorName: group.creatorName || "",
    totalCount: group.totalCount ?? 0,
    unusedCount: group.unusedCount ?? 0,
    usedCount: group.usedCount ?? 0,
    inUseCount: group.inUseCount ?? 0,
    expiredCount: group.expiredCount ?? 0,
    limitType: toNullableNumber(group.limitType),
    limitNum: toNullableNumber(group.limitNum),
    durationType: toNullableNumber(group.durationType),
    duration: toNullableNumber(group.duration),
    timingType: toNullableNumber(group.timingType),
    logout: Boolean(group.logout),
    validityType: toNullableNumber(group.validityType),
    validity: String(group?.validity || group?.voucherPattern?.validity || "").trim(),
    effectiveTime: toNullableNumber(group.effectiveTime),
    expirationTime: toNullableNumber(group.expirationTime),
    schedule: group?.schedule || null,
    totalAmount: pricing.totalAmount,
    totalAmountValue: pricing.totalAmountValue,
    currency: pricing.currency,
    unitPrice: pricing.unitPrice,
    hasPrice: pricing.hasPrice
  };
}

function normalizeGroupDetail(groupDetail) {
  const pricing = normalizeGroupPricing(groupDetail);

  return {
    id: groupDetail.id,
    name: groupDetail.name || "",
    createdTime: groupDetail.createdTime || null,
    creatorName: groupDetail.creatorName || "",
    totalCount: groupDetail.totalCount ?? 0,
    unusedCount: groupDetail.unusedCount ?? 0,
    usedCount: groupDetail.usedCount ?? 0,
    inUseCount: groupDetail.inUseCount ?? 0,
    expiredCount: groupDetail.expiredCount ?? 0,
    description: groupDetail.description || "",
    limitType: toNullableNumber(groupDetail.limitType),
    limitNum: toNullableNumber(groupDetail.limitNum),
    durationType: toNullableNumber(groupDetail.durationType),
    duration: toNullableNumber(groupDetail.duration),
    timingType: toNullableNumber(groupDetail.timingType),
    logout: Boolean(groupDetail.logout),
    validityType: toNullableNumber(groupDetail.validityType),
    validity: String(groupDetail?.validity || groupDetail?.voucherPattern?.validity || "").trim(),
    effectiveTime: toNullableNumber(groupDetail.effectiveTime),
    expirationTime: toNullableNumber(groupDetail.expirationTime),
    schedule: groupDetail?.schedule || null,
    totalAmount: pricing.totalAmount,
    totalAmountValue: pricing.totalAmountValue,
    currency: pricing.currency,
    unitPrice: pricing.unitPrice,
    hasPrice: pricing.hasPrice,
    portalNames: groupDetail.portalNames || []
  };
}

function mergeGroupWithDetail(group, groupDetail) {
  const normalizedDetail = normalizeGroupDetail(groupDetail);

  return {
    ...normalizedDetail,
    totalCount: group?.totalCount ?? normalizedDetail.totalCount,
    unusedCount: group?.unusedCount ?? normalizedDetail.unusedCount,
    usedCount: group?.usedCount ?? normalizedDetail.usedCount,
    inUseCount: group?.inUseCount ?? normalizedDetail.inUseCount,
    expiredCount: group?.expiredCount ?? normalizedDetail.expiredCount,
    limitType: normalizedDetail.limitType ?? group?.limitType ?? null,
    limitNum: normalizedDetail.limitNum ?? group?.limitNum ?? null,
    durationType: normalizedDetail.durationType ?? group?.durationType ?? null,
    duration: normalizedDetail.duration ?? group?.duration ?? null,
    timingType: group?.timingType ?? normalizedDetail.timingType ?? null,
    logout: typeof group?.logout === "boolean" ? group.logout : normalizedDetail.logout,
    validityType: normalizedDetail.validityType ?? group?.validityType ?? null,
    validity: normalizedDetail.validity || group?.validity || "",
    effectiveTime: normalizedDetail.effectiveTime ?? group?.effectiveTime ?? null,
    expirationTime: normalizedDetail.expirationTime ?? group?.expirationTime ?? null,
    schedule: normalizedDetail.schedule ?? group?.schedule ?? null,
    totalAmount: group?.totalAmount ?? normalizedDetail.totalAmount,
    totalAmountValue: group?.totalAmountValue ?? normalizedDetail.totalAmountValue,
    currency: group?.currency ?? normalizedDetail.currency,
    unitPrice: group?.unitPrice ?? normalizedDetail.unitPrice,
    hasPrice: group?.hasPrice ?? normalizedDetail.hasPrice
  };
}

function normalizeVoucher(voucher) {
  const status = Number(voucher.status);

  return {
    id: voucher.id,
    code: voucher.code || "",
    status,
    statusLabel: STATUS_LABELS[status] || "Unknown",
    trafficUsed: voucher.trafficUsed ?? 0,
    trafficUnused: voucher.trafficUnused ?? 0,
    trafficLimit: voucher.trafficLimit ?? 0,
    trafficLimitFrequency: toNullableNumber(voucher.trafficLimitFrequency),
    downLimit: voucher.downLimit ?? 0,
    upLimit: voucher.upLimit ?? 0,
    startTime: voucher.startTime || null,
    endTime: toNullableNumber(voucher.endTime),
    timeUsedSec: voucher.timeUsedSec ?? 0,
    timeLeftSec: voucher.timeLeftSec ?? 0,
    timingByClientUsage: Boolean(voucher.timingByClientUsage)
  };
}

function normalizeGroupPricing(group) {
  const totalAmountValue = toNumber(group?.totalAmount);
  const totalCount = toNumber(group?.totalCount);
  const directUnitPrice = toNumber(group?.unitPrice);
  const computedUnitPrice = totalAmountValue > 0 && totalCount > 0 ? totalAmountValue / totalCount : null;
  const unitPrice = directUnitPrice > 0 ? directUnitPrice : computedUnitPrice;
  const hasPrice = Number(unitPrice || 0) > 0;

  return {
    totalAmount: group?.totalAmount ?? "",
    totalAmountValue,
    currency: String(group?.currency || "").trim(),
    unitPrice: hasPrice ? unitPrice : null,
    hasPrice
  };
}

function normalizeClient(client) {
  const channel = toNumber(client.channel);
  const wifiMode = toNumber(client.wifiMode);
  const radioId = toNumber(client.radioId);
  const signalRank = toNumber(client.signalRank);
  const snr = toNumber(client.snr);

  return {
    id: client.id || "",
    mac: normalizeClientMac(client.mac || client.clientMac || ""),
    ip: client.ip || "",
    name: client.name || "",
    hostName: client.hostName || "",
    deviceType: client.deviceType || "",
    deviceCategory: client.deviceCategory || "",
    active: Boolean(client.active),
    blocked: Boolean(client.blocked),
    wireless: Boolean(client.wireless),
    guest: Boolean(client.guest),
    ssid: client.ssid || "",
    apName: client.apName || "",
    signalLevel: toNumber(client.signalLevel),
    rssi: toNumber(client.rssi),
    signalRank,
    snr,
    channel,
    radioId,
    wifiMode,
    bandLabel: deriveClientBandLabel({
      band: client.band,
      frequencyBand: client.frequencyBand,
      radioBand: client.radioBand,
      channel,
      wifiMode,
      radioId
    }),
    activity: toNumber(client.activity),
    uploadActivity: toNumber(client.uploadActivity),
    trafficDown: toNumber(client.trafficDown),
    trafficUp: toNumber(client.trafficUp),
    uptimeSec: toNumber(client.uptime),
    lastSeen: toNullableNumber(client.lastSeen),
    authStatus: toNumber(client.authStatus),
    rxRate: toNumber(client.rxRate),
    txRate: toNumber(client.txRate),
    authInfo: Array.isArray(client.authInfo)
      ? client.authInfo.map((entry) => ({
          authType: toNumber(entry?.authType),
          info: String(entry?.info || "")
        }))
      : []
  };
}

function normalizeClientMac(value) {
  return String(value || "").trim().toUpperCase();
}

function deriveClientBandLabel(client = {}) {
  const explicitBand = normalizeBandLabel(client.band || client.frequencyBand || client.radioBand);
  if (explicitBand) {
    return explicitBand;
  }

  const channel = toNumber(client.channel);
  if (channel >= 1 && channel <= 14) {
    return "2.4 GHz";
  }

  if (channel >= 36 && channel <= 177) {
    return "5 GHz";
  }

  if (channel >= 1 && channel <= 233) {
    return "6 GHz";
  }

  const wifiMode = toNumber(client.wifiMode);
  if (wifiMode >= 5) {
    return "5 GHz";
  }

  const radioId = toNumber(client.radioId);
  if (radioId === 0) return "2.4 GHz";
  if (radioId === 1) return "5 GHz";

  return "";
}

function normalizeBandLabel(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.includes("2.4")) return "2.4 GHz";
  if (raw.includes("5")) return "5 GHz";
  if (raw.includes("6")) return "6 GHz";
  return "";
}

function normalizeVoucherCode(code) {
  return String(code || "").trim().toUpperCase();
}

function findVoucherInGroupDetail(groupDetail, normalizedCode) {
  const vouchers = (groupDetail?.data || []).map(normalizeVoucher);
  return vouchers.find((entry) => normalizeVoucherCode(entry.code) === normalizedCode) || null;
}

function hasVoucherCodeMatch(client, normalizedCode) {
  return client.authInfo.some(
    (entry) => entry.authType === AUTH_TYPE_VOUCHER && normalizeVoucherCode(entry.info) === normalizedCode
  );
}

function isAutoPauseVoucher(voucher, group) {
  if (voucher?.timingByClientUsage === true) {
    return true;
  }

  return Number(group?.timingType) === 1;
}

function getLatestLastSeen(clients = []) {
  return clients.reduce((latest, client) => Math.max(latest, Number(client?.lastSeen || 0)), 0);
}

function summarizeVoucherUsage(matchedClients, voucher) {
  const snapshotAtMs = Date.now();
  const activeClients = matchedClients.filter((client) => client.active);
  const blockedClients = matchedClients.filter((client) => client.blocked);
  const primaryClient = pickPrimaryClient(activeClients.length ? activeClients : matchedClients);
  const totalDownloadBytes = sumBy(matchedClients, "trafficDown");
  const totalUploadBytes = sumBy(matchedClients, "trafficUp");
  const liveDownloadBytesPerSec = sumBy(activeClients, "activity");
  const liveUploadBytesPerSec = sumBy(activeClients, "uploadActivity");
  const voucherMeterBytes = toNumber(voucher?.trafficUsed);
  const hasVoucherMeter =
    voucherMeterBytes > 0 || toNumber(voucher?.trafficLimit) > 0 || toNumber(voucher?.trafficUnused) > 0;

  if (matchedClients.length > 0) {
    return {
      source: activeClients.length > 0 ? "client_live" : "client_history",
      active: activeClients.length > 0,
      matchedClients: matchedClients.length,
      onlineClients: activeClients.length,
      clientMacs: matchedClients.map((client) => client.mac).filter(Boolean),
      blockedClients: blockedClients.length,
      blockedClientMacs: blockedClients.map((client) => client.mac).filter(Boolean),
      primaryClientMac: primaryClient?.mac || "",
      authStatus: primaryClient?.authStatus ?? null,
      liveDownloadBytesPerSec,
      liveUploadBytesPerSec,
      totalDownloadBytes,
      totalUploadBytes,
      totalBytes: totalDownloadBytes + totalUploadBytes,
      voucherMeterBytes,
      ip: primaryClient?.ip || "",
      deviceName: getDisplayDeviceName(primaryClient),
      connectionLabel: activeClients.length > 0 ? "Online" : "Offline",
      ssid: primaryClient?.ssid || "",
      apName: primaryClient?.apName || "",
      lastSeen: primaryClient?.lastSeen || null,
      latestSeenAt: getLatestLastSeen(matchedClients) || null,
      controllerCheckedAtMs: snapshotAtMs,
      uptimeSec: primaryClient?.uptimeSec || 0,
      signalLevel: primaryClient?.signalLevel ?? null,
      signalRank: primaryClient?.signalRank ?? null,
      rssi: primaryClient?.rssi ?? null,
      snr: primaryClient?.snr ?? null,
      channel: primaryClient?.channel ?? null,
      radioId: primaryClient?.radioId ?? null,
      wifiMode: primaryClient?.wifiMode ?? null,
      bandLabel: primaryClient?.bandLabel || "",
      rxRateKbps: primaryClient?.rxRate || 0,
      txRateKbps: primaryClient?.txRate || 0
    };
  }

  return {
    source: hasVoucherMeter ? "voucher_meter" : "none",
    active: false,
    matchedClients: 0,
    onlineClients: 0,
    clientMacs: [],
    blockedClients: 0,
    blockedClientMacs: [],
    primaryClientMac: "",
    authStatus: null,
    liveDownloadBytesPerSec: 0,
    liveUploadBytesPerSec: 0,
    totalDownloadBytes: 0,
    totalUploadBytes: 0,
    totalBytes: voucherMeterBytes,
    voucherMeterBytes,
    controllerCheckedAtMs: snapshotAtMs,
    ip: "",
    deviceName: "",
    connectionLabel: "No active session found",
    ssid: "",
    apName: "",
    lastSeen: null,
    latestSeenAt: null,
    uptimeSec: 0,
    signalLevel: null,
    signalRank: null,
    rssi: null,
    snr: null,
    channel: null,
    radioId: null,
    wifiMode: null,
    bandLabel: "",
    rxRateKbps: 0,
    txRateKbps: 0
  };
}

function pickPrimaryClient(clients) {
  if (!clients.length) {
    return null;
  }

  return [...clients].sort((left, right) => {
    if (Number(right.active) !== Number(left.active)) {
      return Number(right.active) - Number(left.active);
    }

    if ((right.lastSeen || 0) !== (left.lastSeen || 0)) {
      return (right.lastSeen || 0) - (left.lastSeen || 0);
    }

    return (right.uptimeSec || 0) - (left.uptimeSec || 0);
  })[0];
}

function getDisplayDeviceName(client) {
  if (!client) {
    return "";
  }

  return client.name || client.hostName || client.deviceType || client.deviceCategory || "";
}

function sumBy(items, key) {
  return items.reduce((total, item) => total + toNumber(item?.[key]), 0);
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toNullableNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

module.exports = {
  OmadaApiError,
  OmadaClient,
  STATUS_LABELS
};
