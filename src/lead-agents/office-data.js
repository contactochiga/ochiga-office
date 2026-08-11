function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function formatMoney(value) {
  return `NGN ${toNumber(value, 0).toLocaleString("en-NG")}`;
}

function createOfficeSeedData(nowIso = new Date().toISOString()) {
  const packages = [
    {
      id: "pkg_starter",
      name: "Starter",
      code: "starter",
      status: "active",
      setup_fee: 3500000,
      monthly_fee: 180000,
      estate_limit: 1,
      building_limit: 24,
      home_limit: 150,
      device_limit: 20,
      api_access: false,
      support_tier: "Email",
      created_at: nowIso,
      updated_at: nowIso,
    },
    {
      id: "pkg_professional",
      name: "Professional",
      code: "professional",
      status: "active",
      setup_fee: 8000000,
      monthly_fee: 450000,
      estate_limit: 3,
      building_limit: 80,
      home_limit: 500,
      device_limit: 100,
      api_access: true,
      support_tier: "24/7 priority",
      created_at: nowIso,
      updated_at: nowIso,
    },
    {
      id: "pkg_enterprise",
      name: "Enterprise",
      code: "enterprise",
      status: "active",
      setup_fee: 15000000,
      monthly_fee: 850000,
      estate_limit: null,
      building_limit: null,
      home_limit: null,
      device_limit: null,
      api_access: true,
      support_tier: "Dedicated account",
      created_at: nowIso,
      updated_at: nowIso,
    },
  ];

  const estates = [
    {
      id: "estate_green_canopy",
      name: "Green Canopy Estate",
      package_id: "pkg_professional",
      status: "active",
      subscription_status: "live",
      location: "Lekki, Lagos",
      latitude: 6.4698,
      longitude: 3.5852,
      health_score: 92,
      buildings_count: 12,
      homes_count: 164,
      devices_count: 486,
      resident_count: 391,
      wallet_balance: 3250000,
      monthly_recurring_revenue: 450000,
      support_open: 4,
      support_escalated: 1,
      connected_at: nowIso,
      updated_at: nowIso,
    },
    {
      id: "estate_riverbank",
      name: "Riverbank Residences",
      package_id: "pkg_starter",
      status: "active",
      subscription_status: "live",
      location: "Abuja",
      latitude: 9.0765,
      longitude: 7.3986,
      health_score: 88,
      buildings_count: 6,
      homes_count: 92,
      devices_count: 204,
      resident_count: 203,
      wallet_balance: 1180000,
      monthly_recurring_revenue: 180000,
      support_open: 2,
      support_escalated: 0,
      connected_at: nowIso,
      updated_at: nowIso,
    },
    {
      id: "estate_atlas_district",
      name: "Atlas District",
      package_id: "pkg_enterprise",
      status: "active",
      subscription_status: "rollout",
      location: "Victoria Island, Lagos",
      latitude: 6.4281,
      longitude: 3.4219,
      health_score: 64,
      buildings_count: 18,
      homes_count: 286,
      devices_count: 932,
      resident_count: 711,
      wallet_balance: 6100000,
      monthly_recurring_revenue: 850000,
      support_open: 7,
      support_escalated: 2,
      connected_at: nowIso,
      updated_at: nowIso,
    },
  ];

  const buildings = [
    {
      id: "building_gc_towers",
      estate_id: "estate_green_canopy",
      name: "Canopy Towers",
      type: "apartment",
      status: "active",
      homes_count: 44,
      devices_count: 132,
      permitted_users: 68,
      live_cameras: 14,
      occupancy_pct: 91,
      updated_at: nowIso,
    },
    {
      id: "building_gc_villas",
      estate_id: "estate_green_canopy",
      name: "Garden Villas",
      type: "villa cluster",
      status: "active",
      homes_count: 36,
      devices_count: 88,
      permitted_users: 54,
      live_cameras: 8,
      occupancy_pct: 84,
      updated_at: nowIso,
    },
    {
      id: "building_rb_homes",
      estate_id: "estate_riverbank",
      name: "Riverbank Homes",
      type: "terrace homes",
      status: "active",
      homes_count: 52,
      devices_count: 104,
      permitted_users: 47,
      live_cameras: 6,
      occupancy_pct: 87,
      updated_at: nowIso,
    },
    {
      id: "building_atlas_heights",
      estate_id: "estate_atlas_district",
      name: "Atlas Heights",
      type: "mixed use tower",
      status: "warning",
      homes_count: 84,
      devices_count: 312,
      permitted_users: 126,
      live_cameras: 22,
      occupancy_pct: 79,
      updated_at: nowIso,
    },
    {
      id: "building_atlas_gardens",
      estate_id: "estate_atlas_district",
      name: "Atlas Gardens",
      type: "connected residences",
      status: "active",
      homes_count: 61,
      devices_count: 188,
      permitted_users: 93,
      live_cameras: 10,
      occupancy_pct: 83,
      updated_at: nowIso,
    },
  ];

  const homes = [
    {
      id: "home_gc_a101",
      estate_id: "estate_green_canopy",
      building_id: "building_gc_towers",
      name: "A101",
      residents_count: 4,
      devices_count: 10,
      wallet_balance: 145000,
      automation_state: "armed",
      updated_at: nowIso,
    },
    {
      id: "home_gc_b204",
      estate_id: "estate_green_canopy",
      building_id: "building_gc_villas",
      name: "B204",
      residents_count: 5,
      devices_count: 8,
      wallet_balance: 98000,
      automation_state: "standby",
      updated_at: nowIso,
    },
    {
      id: "home_rb_d12",
      estate_id: "estate_riverbank",
      building_id: "building_rb_homes",
      name: "D12",
      residents_count: 3,
      devices_count: 6,
      wallet_balance: 72000,
      automation_state: "armed",
      updated_at: nowIso,
    },
    {
      id: "home_atlas_ph9",
      estate_id: "estate_atlas_district",
      building_id: "building_atlas_heights",
      name: "PH-9",
      residents_count: 6,
      devices_count: 16,
      wallet_balance: 221000,
      automation_state: "maintenance",
      updated_at: nowIso,
    },
  ];

  const devices = [
    {
      id: "device_gate_cam_1",
      estate_id: "estate_green_canopy",
      building_id: "building_gc_towers",
      home_id: null,
      name: "North Gate Cam",
      category: "camera",
      protocol: "onvif",
      status: "online",
      last_seen_at: nowIso,
    },
    {
      id: "device_lobby_panel_1",
      estate_id: "estate_green_canopy",
      building_id: "building_gc_towers",
      home_id: null,
      name: "Lobby Access Panel",
      category: "access",
      protocol: "modbus",
      status: "online",
      last_seen_at: nowIso,
    },
    {
      id: "device_home_hub_1",
      estate_id: "estate_riverbank",
      building_id: "building_rb_homes",
      home_id: "home_rb_d12",
      name: "D12 Home Hub",
      category: "hub",
      protocol: "mqtt",
      status: "online",
      last_seen_at: nowIso,
    },
    {
      id: "device_sensor_1",
      estate_id: "estate_atlas_district",
      building_id: "building_atlas_heights",
      home_id: "home_atlas_ph9",
      name: "Penthouse Climate Sensor",
      category: "sensor",
      protocol: "zigbee",
      status: "warning",
      last_seen_at: nowIso,
    },
    {
      id: "device_cam_critical_1",
      estate_id: "estate_atlas_district",
      building_id: "building_atlas_gardens",
      home_id: null,
      name: "Perimeter AI Cam 04",
      category: "camera",
      protocol: "onvif",
      status: "offline",
      last_seen_at: nowIso,
    },
  ];

  const wallets = [
    {
      id: "wallet_estate_green_canopy",
      scope_type: "estate",
      scope_id: "estate_green_canopy",
      label: "Green Canopy Estate Wallet",
      balance: 3250000,
      currency: "NGN",
      pending_charges: 210000,
      updated_at: nowIso,
    },
    {
      id: "wallet_estate_riverbank",
      scope_type: "estate",
      scope_id: "estate_riverbank",
      label: "Riverbank Estate Wallet",
      balance: 1180000,
      currency: "NGN",
      pending_charges: 92000,
      updated_at: nowIso,
    },
    {
      id: "wallet_home_gc_a101",
      scope_type: "home",
      scope_id: "home_gc_a101",
      label: "A101 Household Wallet",
      balance: 145000,
      currency: "NGN",
      pending_charges: 12000,
      updated_at: nowIso,
    },
    {
      id: "wallet_home_atlas_ph9",
      scope_type: "home",
      scope_id: "home_atlas_ph9",
      label: "PH-9 Household Wallet",
      balance: 221000,
      currency: "NGN",
      pending_charges: 18000,
      updated_at: nowIso,
    },
  ];

  const analytics = [
    {
      id: "analytics_ochiga_website",
      surface: "ochiga_website",
      label: "Ochiga Website",
      period: "24h",
      sessions: 1842,
      unique_visitors: 1294,
      conversions: 34,
      active_agent: "Oma",
      top_source: "Organic search",
      top_location: "Lagos",
      updated_at: nowIso,
    },
    {
      id: "analytics_oyi_page",
      surface: "oyi_page",
      label: "Oyi Page",
      period: "24h",
      sessions: 1168,
      unique_visitors: 822,
      conversions: 22,
      active_agent: "Oma",
      top_source: "Direct",
      top_location: "Abuja",
      updated_at: nowIso,
    },
    {
      id: "analytics_widget",
      surface: "office_widget",
      label: "Office Widget",
      period: "24h",
      sessions: 286,
      unique_visitors: 209,
      conversions: 14,
      active_agent: "Osa",
      top_source: "Widget",
      top_location: "Port Harcourt",
      updated_at: nowIso,
    },
  ];

  const supportMappings = [
    {
      id: "support_green_canopy_1",
      estate_id: "estate_green_canopy",
      building_id: "building_gc_towers",
      home_id: null,
      title: "Visitor QR delivery delay",
      category: "visitor_access",
      channel: "facility",
      priority: "high",
      status: "open",
      assigned_team: "customer_support",
      updated_at: nowIso,
    },
    {
      id: "support_green_canopy_2",
      estate_id: "estate_green_canopy",
      building_id: "building_gc_villas",
      home_id: "home_gc_b204",
      title: "Wallet credit reconciliation",
      category: "wallet",
      channel: "support",
      priority: "medium",
      status: "open",
      assigned_team: "commercial",
      updated_at: nowIso,
    },
    {
      id: "support_atlas_1",
      estate_id: "estate_atlas_district",
      building_id: "building_atlas_gardens",
      home_id: null,
      title: "Perimeter camera offline",
      category: "security",
      channel: "smart_building",
      priority: "critical",
      status: "escalated",
      assigned_team: "security_ops",
      updated_at: nowIso,
    },
    {
      id: "support_riverbank_1",
      estate_id: "estate_riverbank",
      building_id: "building_rb_homes",
      home_id: "home_rb_d12",
      title: "Service charge wallet inquiry",
      category: "billing",
      channel: "facility",
      priority: "low",
      status: "resolved",
      assigned_team: "customer_support",
      updated_at: nowIso,
    },
  ];

  const documents = [
    {
      id: "doc_seed_proposal",
      title: "Green Canopy Estate Deployment Proposal",
      document_type: "proposal",
      status: "draft",
      owner: "Office",
      related_type: "estate",
      related_id: "estate_green_canopy",
      amount: 8000000,
      currency: "NGN",
      created_at: nowIso,
      updated_at: nowIso,
    },
  ];

  return {
    packages,
    estates,
    buildings,
    homes,
    devices,
    wallets,
    analytics,
    documents,
    support_mappings: supportMappings,
  };
}

function buildOfficeSnapshot(input) {
  const source = input || {};
  const officeData =
    source.packages?.length ||
    source.estates?.length ||
    source.buildings?.length ||
    source.homes?.length ||
    source.devices?.length ||
    source.wallets?.length ||
    source.analytics?.length ||
    source.documents?.length ||
    source.support_mappings?.length
      ? source
      : createOfficeSeedData();

  const packages = officeData.packages || [];
  const estates = officeData.estates || [];
  const buildings = officeData.buildings || [];
  const homes = officeData.homes || [];
  const devices = officeData.devices || [];
  const wallets = officeData.wallets || [];
  const analytics = officeData.analytics || [];
  const documents = officeData.documents || [];
  const supportMappings = officeData.support_mappings || [];
  const leads = source.leads || [];
  const report = source.report || {};
  const totals = report.totals || {};

  const packageMap = new Map(packages.map((item) => [item.id, item]));
  const estateMap = new Map(estates.map((item) => [item.id, item]));
  const buildingMap = new Map(buildings.map((item) => [item.id, item]));
  const homeMap = new Map(homes.map((item) => [item.id, item]));

  const totalWalletBalance = wallets.reduce((sum, wallet) => sum + toNumber(wallet.balance), 0);
  const totalPendingCharges = wallets.reduce(
    (sum, wallet) => sum + toNumber(wallet.pending_charges),
    0
  );
  const onlineDevices = devices.filter((item) => item.status === "online").length;
  const flaggedDevices = devices.filter((item) => item.status !== "online").length;
  const openSupport = supportMappings.filter((item) => item.status === "open").length;
  const escalatedSupport = supportMappings.filter((item) => item.status === "escalated").length;
  const totalSessions = analytics.reduce((sum, item) => sum + toNumber(item.sessions), 0);
  const totalVisitors = analytics.reduce((sum, item) => sum + toNumber(item.unique_visitors), 0);
  const totalConversions = analytics.reduce((sum, item) => sum + toNumber(item.conversions), 0);
  const mrr = estates.reduce(
    (sum, item) => sum + toNumber(item.monthly_recurring_revenue || item.monthly_fee),
    0
  );

  const facilityItems = estates.map((estate) => {
    const pkg = packageMap.get(estate.package_id);
    return {
      title: estate.name,
      meta: `${estate.location || "Location pending"} · ${pkg ? pkg.name : "Package pending"}`,
            body: `Buildings: ${toNumber(estate.buildings_count)} · Homes: ${toNumber(
        estate.homes_count
      )} · Hardware devices: ${toNumber(estate.devices_count)} · Wallet: ${formatMoney(
        estate.wallet_balance
      )}`,
    };
  });

  const buildingItems = buildings.map((building) => {
    const estate = estateMap.get(building.estate_id);
    return {
      title: building.name,
      meta: `${building.type || "Building"} · ${estate ? estate.name : "Estate pending"}`,
      body: `Homes: ${toNumber(building.homes_count)} · Hardware devices: ${toNumber(
        building.devices_count
      )} · Permitted: ${toNumber(building.permitted_users)} · Cameras: ${toNumber(
        building.live_cameras
      )}`,
    };
  });

  const webItems = analytics.map((item) => ({
    title: item.label,
    meta: `${item.period || "24h"} · ${item.top_location || "Location pending"}`,
    body: `Sessions: ${toNumber(item.sessions)} · Visitors: ${toNumber(
      item.unique_visitors
    )} · Conversions: ${toNumber(item.conversions)} · Agent: ${item.active_agent || "Unassigned"}`,
  }));

  const supportItems = supportMappings.map((item) => ({
    title: item.title,
    meta: `${item.priority || "normal"} · ${item.status || "open"} · ${
      estateMap.get(item.estate_id)?.name || "Estate pending"
    }`,
    body: `${item.category || "general"} via ${item.channel || "office"} · Team: ${
      item.assigned_team || "support"
    } · Building: ${buildingMap.get(item.building_id)?.name || "n/a"} · Home: ${
      homeMap.get(item.home_id)?.name || "n/a"
    }`,
  }));

  const packageCounts = estates.reduce((acc, estate) => {
    const pkg = packageMap.get(estate.package_id);
    const key = pkg ? pkg.name : "Unassigned";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const supportStatusCounts = supportMappings.reduce((acc, item) => {
    const key = item.status || "open";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const deviceStatusCounts = devices.reduce((acc, item) => {
    const key = item.status || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const webSourceCounts = analytics.reduce((acc, item) => {
    const key = item.top_source || item.surface || "unknown";
    acc[key] = (acc[key] || 0) + toNumber(item.sessions, 0);
    return acc;
  }, {});

  function topEntries(map) {
    return Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([label, value]) => ({ label, value }));
  }

  return {
    generated_at: new Date().toISOString(),
    collections: {
      packages,
      estates,
      buildings,
      homes,
      devices,
      wallets,
      analytics,
      documents,
      support_mappings: supportMappings,
    },
    totals: {
      estates: estates.length,
      packages: packages.length,
      buildings: buildings.length,
      homes: homes.length,
      devices: devices.length,
      wallets: wallets.length,
      analytics: analytics.length,
      documents: documents.length,
      support_mappings: supportMappings.length,
      online_devices: onlineDevices,
      flagged_devices: flaggedDevices,
      wallet_balance_total: totalWalletBalance,
      pending_charges_total: totalPendingCharges,
      sessions: totalSessions,
      visitors: totalVisitors,
      conversions: totalConversions,
      monthly_recurring_revenue: mrr,
      crm_records: totals.leads || leads.length || 0,
      invoices: documents.filter((item) => String(item.document_type || item.type).toLowerCase() === "invoice").length,
      contracts: documents.filter((item) => String(item.document_type || item.type).toLowerCase() === "contract").length,
    },
    domains: {
      summary: {
        title: "Office Overview",
        subtitle:
          "Full operational supervision across estates, buildings, websites, support, wallets, and connected infrastructure.",
        badge: estates.length ? "Live" : "Standby",
        tone: estates.length ? "" : "warning",
        primaryMetric: estates.length,
        primaryLabel: "Estates",
        metrics: [
          { label: "Estates connected", value: estates.length },
          { label: "Buildings tracked", value: buildings.length },
          { label: "Hardware devices online", value: onlineDevices },
          { label: "Open support", value: openSupport },
        ],
        batches: [
          { label: "Wallet float", value: formatMoney(totalWalletBalance) },
          { label: "MRR", value: formatMoney(mrr) },
          { label: "Visitors", value: totalVisitors },
          { label: "Conversions", value: totalConversions },
        ],
        charts: [
          { title: "Subscribed packages", entries: topEntries(packageCounts) },
          { title: "Hardware device status", entries: topEntries(deviceStatusCounts) },
        ],
        items: [
          {
            title: "Facility operations",
            meta: `${estates.length} estate accounts · ${formatMoney(mrr)} recurring`,
            body: `${buildings.length} buildings, ${homes.length} homes, and ${devices.length} hardware device records are now tracked through Office.`,
          },
          {
            title: "Resident and wallet posture",
            meta: `${wallets.length} wallet views · ${formatMoney(totalPendingCharges)} pending`,
            body: "Estate and home wallet balances can now be queried directly by Office for subscription, billing, and support actions.",
          },
          {
            title: "Web and support pressure",
            meta: `${totalSessions} sessions · ${openSupport} open support cases`,
            body: "Public web activity, agent conversion pressure, and support mappings are available as Office-level supervision data.",
          },
        ],
      },
      facility: {
        title: "Estate Facilities",
        subtitle:
          "Subscribed estates, estate communities, packages, buildings, connected homes, wallets, and support posture.",
        badge: estates.length ? "Connected" : "Awaiting sync",
        tone: estates.length ? "" : "warning",
        primaryMetric: estates.length,
        primaryLabel: "Estates",
        metrics: [
          { label: "Packages", value: packages.length },
          { label: "Buildings", value: buildings.length },
          { label: "Homes", value: homes.length },
          { label: "Estate wallet float", value: formatMoney(totalWalletBalance) },
        ],
        batches: [
          { label: "Open support", value: openSupport },
          { label: "Escalated", value: escalatedSupport },
          { label: "MRR", value: formatMoney(mrr) },
          { label: "CRM records", value: totals.leads || leads.length || 0 },
        ],
        charts: [
          { title: "Packages", entries: topEntries(packageCounts) },
          {
            title: "Estate support",
            entries: estates.map((estate) => ({
              label: estate.name,
              value: toNumber(estate.support_open) + toNumber(estate.support_escalated),
            })),
          },
        ],
        items: facilityItems,
      },
      smart_buildings: {
        title: "Smart Buildings",
        subtitle:
          "Buildings, homes, hardware device posture, permitted operators, and smart-home states across the Oyi building layer.",
        badge: buildings.length ? "Monitoring" : "Queued",
        tone: buildings.length ? "" : "warning",
        primaryMetric: buildings.length,
        primaryLabel: "Buildings",
        metrics: [
          { label: "Homes", value: homes.length },
          { label: "Hardware devices", value: devices.length },
          { label: "Online", value: onlineDevices },
          { label: "Flagged", value: flaggedDevices },
        ],
        batches: [
          { label: "Camera channels", value: devices.filter((item) => item.category === "camera").length },
          { label: "Home wallets", value: wallets.filter((item) => item.scope_type === "home").length },
          { label: "Automation states", value: homes.length },
          { label: "Permitted users", value: buildings.reduce((sum, item) => sum + toNumber(item.permitted_users), 0) },
        ],
        charts: [
          {
            title: "Hardware device status",
            entries: topEntries(deviceStatusCounts),
          },
          {
            title: "Building occupancy",
            entries: buildings.map((item) => ({
              label: item.name,
              value: toNumber(item.occupancy_pct),
            })),
          },
        ],
        items: buildingItems,
      },
      web_presence: {
        title: "Web Presence",
        subtitle:
          "Real-time web sessions, conversions, active public-facing agents, top locations, and source pressure across Ochiga surfaces.",
        badge: analytics.length ? "Connected" : "No feed",
        tone: analytics.length ? "" : "warning",
        primaryMetric: totalSessions,
        primaryLabel: "Sessions",
        metrics: [
          { label: "Unique visitors", value: totalVisitors },
          { label: "Conversions", value: totalConversions },
          { label: "Surfaces tracked", value: analytics.length },
          { label: "Public agents", value: Array.from(new Set(analytics.map((item) => item.active_agent).filter(Boolean))).length },
        ],
        batches: [
          { label: "Top source count", value: Object.keys(webSourceCounts).length },
          { label: "Live sessions", value: totalSessions },
          { label: "Conversion rate", value: totalSessions ? `${Math.round((totalConversions / totalSessions) * 100)}%` : "0%" },
          { label: "Active agent", value: analytics[0]?.active_agent || "Oma" },
        ],
        charts: [
          { title: "Traffic sources", entries: topEntries(webSourceCounts) },
          {
            title: "Surface sessions",
            entries: analytics.map((item) => ({ label: item.label, value: toNumber(item.sessions) })),
          },
        ],
        items: webItems,
      },
      support: {
        title: "Customer Support",
        subtitle:
          "Mapped support tickets by estate, building, home, category, priority, and assigned team for direct Office supervision.",
        badge: openSupport ? `${openSupport} Open` : "Stable",
        tone: escalatedSupport ? "alert" : openSupport ? "warning" : "",
        primaryMetric: openSupport,
        primaryLabel: "Open",
        metrics: [
          { label: "Escalated", value: escalatedSupport },
          { label: "Resolved", value: supportMappings.filter((item) => item.status === "resolved").length },
          { label: "Mapped estates", value: new Set(supportMappings.map((item) => item.estate_id).filter(Boolean)).size },
          { label: "Assigned teams", value: new Set(supportMappings.map((item) => item.assigned_team).filter(Boolean)).size },
        ],
        batches: [
          { label: "Facility", value: supportMappings.filter((item) => item.channel === "facility").length },
          { label: "Smart building", value: supportMappings.filter((item) => item.channel === "smart_building").length },
          { label: "Wallet", value: supportMappings.filter((item) => item.category === "wallet" || item.category === "billing").length },
          { label: "Security", value: supportMappings.filter((item) => item.category === "security").length },
        ],
        charts: [
          { title: "Support status", entries: topEntries(supportStatusCounts) },
          {
            title: "Estate pressure",
            entries: estates.map((estate) => ({
              label: estate.name,
              value: supportMappings.filter((item) => item.estate_id === estate.id).length,
            })),
          },
        ],
        items: supportItems,
      },
    },
  };
}

module.exports = {
  buildOfficeSnapshot,
  createOfficeSeedData,
  formatMoney,
};
