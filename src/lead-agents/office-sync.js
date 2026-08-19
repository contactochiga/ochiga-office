const axios = require("axios");

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clientForSource(baseURL, config, keyName) {
  if (!baseURL) return null;
  const headers = {};
  if (config[`${keyName}ApiKey`]) {
    headers["x-api-key"] = config[`${keyName}ApiKey`];
  }
  if (config[`${keyName}BearerToken`]) {
    headers.authorization = `Bearer ${config[`${keyName}BearerToken`]}`;
  }
  return axios.create({
    baseURL: String(baseURL).replace(/\/$/, ""),
    timeout: config.requestTimeoutMs,
    headers,
  });
}

function normalizeCollectionPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  if (payload.collections && typeof payload.collections === "object") {
    return payload.collections;
  }
  return {
    packages: Array.isArray(payload.packages) ? payload.packages : [],
    estates: Array.isArray(payload.estates) ? payload.estates : [],
    buildings: Array.isArray(payload.buildings) ? payload.buildings : [],
    homes: Array.isArray(payload.homes) ? payload.homes : [],
    devices: Array.isArray(payload.devices) ? payload.devices : [],
    wallets: Array.isArray(payload.wallets) ? payload.wallets : [],
    analytics: Array.isArray(payload.analytics) ? payload.analytics : [],
    documents: Array.isArray(payload.documents) ? payload.documents : [],
    support_mappings: Array.isArray(payload.support_mappings) ? payload.support_mappings : [],
  };
}

function packageFromEstate(estate, nowIso) {
  const code =
    String(
      estate.package_code ||
        estate.package ||
        estate.subscription_plan ||
        estate.plan ||
        estate.tier ||
        "starter"
    )
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_") || "starter";
  const name = String(
    estate.package_name || estate.package || estate.subscription_plan || estate.plan || code
  )
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
  return {
    id: `facility_pkg_${code}`,
    name,
    code,
    status: "active",
    setup_fee: toNumber(estate.setup_fee),
    monthly_fee: toNumber(estate.monthly_fee || estate.subscription_fee),
    estate_limit: estate.estate_limit ?? null,
    building_limit: estate.building_limit ?? null,
    home_limit: estate.home_limit ?? null,
    device_limit: estate.device_limit ?? null,
    api_access: Boolean(estate.api_access),
    support_tier: estate.support_tier || "",
    created_at: estate.created_at || nowIso,
    updated_at: nowIso,
  };
}

function buildFacilityCollections({ overview, estates, homesByEstate }) {
  const nowIso = new Date().toISOString();
  const packages = [];
  const packageSeen = new Set();
  const officeEstates = [];
  const buildings = [];
  const homes = [];
  const wallets = [];

  estates.forEach((estate, estateIndex) => {
    const estateId = String(estate.id || `facility_estate_${estateIndex + 1}`);
    const packageRow = packageFromEstate(estate, nowIso);
    if (!packageSeen.has(packageRow.id)) {
      packageSeen.add(packageRow.id);
      packages.push(packageRow);
    }

    const estateHomes = Array.isArray(homesByEstate[estateId]) ? homesByEstate[estateId] : [];
    const buildingGroups = new Map();
    estateHomes.forEach((home, homeIndex) => {
      const blockKey =
        String(home.building || home.block || home.wing || home.cluster || "main").trim() || "main";
      const buildingId = `facility_building_${estateId}_${blockKey
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")}`;
      if (!buildingGroups.has(buildingId)) {
        buildingGroups.set(buildingId, {
          id: buildingId,
          estate_id: estateId,
          name: String(home.building || home.block || home.wing || "Main Block"),
          type: home.type || "estate block",
          homes_count: 0,
          devices_count: 0,
          permitted_users: 0,
          live_cameras: 0,
          occupancy_pct: 0,
          created_at: home.created_at || nowIso,
          updated_at: nowIso,
        });
      }
      const building = buildingGroups.get(buildingId);
      building.homes_count += 1;
      const deviceCount = toNumber(home.devices_count || home.active_devices || home.device_count);
      building.devices_count += deviceCount;
      building.live_cameras += toNumber(home.camera_count || home.cameras);
      building.permitted_users += toNumber(home.residents_count || home.users_count || home.residents);

      homes.push({
        id: String(home.id || `facility_home_${estateId}_${homeIndex + 1}`),
        estate_id: estateId,
        building_id: buildingId,
        name: String(home.name || home.unit || home.label || `Home ${homeIndex + 1}`),
        residents_count: toNumber(home.residents_count || home.users_count || home.residents),
        devices_count: deviceCount,
        wallet_balance: toNumber(home.wallet_balance || home.balance),
        automation_state: home.automation_state || "standby",
        created_at: home.created_at || nowIso,
        updated_at: nowIso,
      });
    });

    const buildingsForEstate = Array.from(buildingGroups.values());
    buildings.push(...buildingsForEstate);

    const estateWallet =
      toNumber(estate.wallet_balance) ||
      (String(overview?.estate_id || "") === estateId ? toNumber(overview?.wallet?.balance) : 0);
    const outstanding =
      toNumber(estate.outstanding_dues) ||
      (String(overview?.estate_id || "") === estateId
        ? toNumber(overview?.wallet?.outstanding_dues)
        : 0);

    officeEstates.push({
      id: estateId,
      name: String(estate.name || `Estate ${estateIndex + 1}`),
      package_id: packageRow.id,
      status: estate.membership_status || estate.status || "active",
      subscription_status: estate.subscription_status || "live",
      location: estate.address || estate.location || "",
      latitude: estate.latitude ?? estate.lat ?? estate.geo?.latitude ?? estate.geo?.lat ?? null,
      longitude: estate.longitude ?? estate.lng ?? estate.geo?.longitude ?? estate.geo?.lng ?? null,
      health_score: estate.health_score ?? estate.health_pct ?? null,
      buildings_count: buildingsForEstate.length || (estateHomes.length ? 1 : 0),
      homes_count: estateHomes.length,
      devices_count: buildingsForEstate.reduce((sum, item) => sum + toNumber(item.devices_count), 0),
      resident_count: homes.reduce(
        (sum, item) => sum + (item.estate_id === estateId ? toNumber(item.residents_count) : 0),
        0
      ),
      wallet_balance: estateWallet,
      support_open:
        toNumber(estate.open_support) +
        (String(overview?.estate_id || "") === estateId ? toNumber(overview?.alerts) : 0),
      support_escalated: toNumber(estate.escalated_support),
      metadata: {
        source: "facility",
        community_posts: toNumber(estate.community_posts || estate.community_count),
        utility_count: toNumber(estate.utility_count || estate.utilities_count),
        manager_name: estate.manager_name || estate.manager || "",
      },
      connected_at: estate.created_at || nowIso,
      updated_at: nowIso,
    });

    if (estateWallet || outstanding) {
      wallets.push({
        id: `facility_wallet_${estateId}`,
        scope_type: "estate",
        scope_id: estateId,
        label: `${estate.name || "Estate"} Wallet`,
        balance: estateWallet,
        currency: "NGN",
        pending_charges: outstanding,
        created_at: estate.created_at || nowIso,
        updated_at: nowIso,
      });
    }
  });

  const analytics = [
    {
      id: "analytics_facility_system",
      surface: "facility_system",
      label: "Facility Control",
      period: "live",
      sessions: officeEstates.length,
      unique_visitors: officeEstates.reduce((sum, item) => sum + toNumber(item.resident_count), 0),
      conversions: packages.length,
      active_agent: "Office",
      top_source: "Facility API",
      top_location: officeEstates[0]?.location || "",
      created_at: nowIso,
      updated_at: nowIso,
    },
  ];

  const supportMappings = officeEstates
    .filter((estate) => toNumber(estate.support_open) > 0)
    .map((estate, index) => ({
      id: `facility_support_${estate.id}_${index + 1}`,
      estate_id: estate.id,
      building_id: buildings.find((item) => item.estate_id === estate.id)?.id || null,
      home_id: null,
      title: `${estate.name} support pressure`,
      category: "facility",
      channel: "facility",
      priority: toNumber(estate.support_open) > 3 ? "high" : "medium",
      status: toNumber(estate.support_escalated) > 0 ? "escalated" : "open",
      assigned_team: "customer_support",
      created_at: nowIso,
      updated_at: nowIso,
    }));

  return {
    packages,
    estates: officeEstates,
    buildings,
    homes,
    devices: [],
    wallets,
    analytics,
    support_mappings: supportMappings,
  };
}

async function pullFacilityCollections(config) {
  const client = clientForSource(config.officeFacilityBaseUrl, config, "officeFacility");
  if (!client) {
    const error = new Error("OFFICE_FACILITY_BASE_URL is not configured");
    error.statusCode = 400;
    throw error;
  }

  if (config.officeFacilityExportPath) {
    const response = await client.get(config.officeFacilityExportPath);
    return normalizeCollectionPayload(response.data);
  }

  const [overviewResponse, estatesResponse] = await Promise.all([
    client.get("/facility/overview").catch(() => ({ data: null })),
    client.get("/facility/estates"),
  ]);
  const estates = Array.isArray(estatesResponse.data?.estates) ? estatesResponse.data.estates : [];
  const homesByEstate = {};
  await Promise.all(
    estates.map(async (estate) => {
      const estateId = String(estate.id || "");
      if (!estateId) return;
      try {
        const response = await client.get(`/facility/estates/${encodeURIComponent(estateId)}/homes`);
        homesByEstate[estateId] = Array.isArray(response.data?.homes) ? response.data.homes : [];
      } catch (_) {
        homesByEstate[estateId] = [];
      }
    })
  );
  return buildFacilityCollections({
    overview: overviewResponse.data || null,
    estates,
    homesByEstate,
  });
}

function buildConsumerCollections(payload) {
  const normalized = normalizeCollectionPayload(payload);
  const nowIso = new Date().toISOString();
  const analytics = Array.isArray(normalized.analytics) ? normalized.analytics : [];
  if (!analytics.length) {
    analytics.push({
      id: "analytics_consumer_sync",
      surface: "consumer_sync",
      label: "Consumer Smart Building",
      period: "live",
      sessions: Array.isArray(normalized.devices) ? normalized.devices.length : 0,
      unique_visitors: Array.isArray(normalized.homes) ? normalized.homes.length : 0,
      conversions: Array.isArray(normalized.wallets) ? normalized.wallets.length : 0,
      active_agent: "Office",
      top_source: "Consumer API",
      top_location: "",
      created_at: nowIso,
      updated_at: nowIso,
    });
  }
  return normalized;
}

async function pullConsumerCollections(config) {
  const client = clientForSource(config.officeConsumerBaseUrl, config, "officeConsumer");
  if (!client) {
    const error = new Error("OFFICE_CONSUMER_BASE_URL is not configured");
    error.statusCode = 400;
    throw error;
  }
  const exportPath = config.officeConsumerExportPath || "/office/export";
  const response = await client.get(exportPath);
  return buildConsumerCollections(response.data);
}

function createOfficeSyncService({ config, store }) {
  return {
    async ingestCollections(source, payload) {
      const normalized = normalizeCollectionPayload(payload);
      const snapshot = await store.upsertOfficeCollections(normalized);
      return {
        source,
        collections: Object.fromEntries(
          Object.entries(normalized).map(([key, rows]) => [key, Array.isArray(rows) ? rows.length : 0])
        ),
        snapshot,
      };
    },

    async syncFacility() {
      const collections = await pullFacilityCollections(config);
      const snapshot = await store.upsertOfficeCollections(collections);
      return {
        source: "facility",
        collections: Object.fromEntries(
          Object.entries(collections).map(([key, rows]) => [key, Array.isArray(rows) ? rows.length : 0])
        ),
        snapshot,
      };
    },

    async syncConsumer() {
      const collections = await pullConsumerCollections(config);
      const snapshot = await store.upsertOfficeCollections(collections);
      return {
        source: "consumer",
        collections: Object.fromEntries(
          Object.entries(collections).map(([key, rows]) => [key, Array.isArray(rows) ? rows.length : 0])
        ),
        snapshot,
      };
    },

    async syncAll() {
      const results = [];
      results.push(await this.syncFacility());
      results.push(await this.syncConsumer());
      return {
        results,
        snapshot: await store.getOfficeSnapshot(),
      };
    },
  };
}

module.exports = {
  createOfficeSyncService,
};
