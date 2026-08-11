const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deriveProjectName(fileName, fallback = "Untitled Project") {
  const raw = String(fileName || "").trim();
  if (!raw) return fallback;
  return raw
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizedRect(input, fallback) {
  const base = input && typeof input === "object" ? input : {};
  return {
    x: clamp(Number(base.x ?? fallback.x), 0, 1),
    y: clamp(Number(base.y ?? fallback.y), 0, 1),
    width: clamp(Number(base.width ?? fallback.width), 0.02, 1),
    height: clamp(Number(base.height ?? fallback.height), 0.02, 1),
  };
}

function normalizeZones(zones, fallbackBounds) {
  if (!Array.isArray(zones) || !zones.length) {
    return [
      { id: "zone-a", label: "West Unit", kind: "unit", ...normalizedRect({ x: 0.06, y: 0.16, width: 0.34, height: 0.62 }, fallbackBounds) },
      { id: "zone-core", label: "Core / Corridor", kind: "core", ...normalizedRect({ x: 0.42, y: 0.26, width: 0.16, height: 0.48 }, fallbackBounds) },
      { id: "zone-b", label: "East Unit", kind: "unit", ...normalizedRect({ x: 0.6, y: 0.16, width: 0.34, height: 0.62 }, fallbackBounds) },
      { id: "zone-entry", label: "Entry Forecourt", kind: "entry", ...normalizedRect({ x: 0.36, y: 0.76, width: 0.28, height: 0.16 }, fallbackBounds) },
    ];
  }
  return zones.map((zone, index) => ({
    id: zone.id || `zone-${index + 1}`,
    label: zone.label || `Zone ${index + 1}`,
    kind: zone.kind || "zone",
    ...normalizedRect(zone, fallbackBounds),
  }));
}

function normalizePathways(pathways) {
  if (!Array.isArray(pathways) || !pathways.length) {
    return [
      { id: "path-central", label: "Central Corridor", x1: 0.5, y1: 0.22, x2: 0.5, y2: 0.84, kind: "vertical" },
      { id: "path-cross", label: "Lateral Distribution", x1: 0.22, y1: 0.56, x2: 0.78, y2: 0.56, kind: "horizontal" },
    ];
  }
  return pathways.map((pathway, index) => ({
    id: pathway.id || `path-${index + 1}`,
    label: pathway.label || `Path ${index + 1}`,
    x1: clamp(Number(pathway.x1 || 0), 0, 1),
    y1: clamp(Number(pathway.y1 || 0), 0, 1),
    x2: clamp(Number(pathway.x2 || 0), 0, 1),
    y2: clamp(Number(pathway.y2 || 0), 0, 1),
    kind: pathway.kind || "path",
  }));
}

function normalizeOpenings(openings) {
  if (!Array.isArray(openings) || !openings.length) {
    return [
      { id: "opening-entry", label: "Main Entrance", kind: "door", x: 0.5, y: 0.9, orientation: "horizontal" },
    ];
  }
  return openings.map((opening, index) => ({
    id: opening.id || `opening-${index + 1}`,
    label: opening.label || `Opening ${index + 1}`,
    kind: opening.kind || "door",
    x: clamp(Number(opening.x || 0.5), 0, 1),
    y: clamp(Number(opening.y || 0.5), 0, 1),
    orientation: opening.orientation === "vertical" ? "vertical" : "horizontal",
  }));
}

function normalizeParsedGeometry(parsedGeometry, width, height) {
  const fallbackBounds = { x: 0.04, y: 0.08, width: 0.92, height: 0.84 };
  const source = parsedGeometry && typeof parsedGeometry === "object" ? parsedGeometry : {};
  const contentBounds = normalizedRect(source.content_bounds, fallbackBounds);
  const zones = normalizeZones(source.zones, contentBounds);
  const pathways = normalizePathways(source.pathways);
  const openings = normalizeOpenings(source.openings);
  const confidence = clamp(Number(source.confidence ?? 0.22), 0, 1);
  const wallBands = {
    vertical: Array.isArray(source.wall_bands?.vertical) ? source.wall_bands.vertical.slice(0, 12) : [],
    horizontal: Array.isArray(source.wall_bands?.horizontal) ? source.wall_bands.horizontal.slice(0, 12) : [],
  };

  return {
    content_bounds: contentBounds,
    zones,
    pathways,
    openings,
    wall_bands: wallBands,
    source: source.source || "fallback",
    confidence,
    image_width: Number(width || source.image_width || 0),
    image_height: Number(height || source.image_height || 0),
  };
}

function layerCatalog() {
  return [
    { key: "electrical", label: "Electrical", accent: "#f59e0b", enabled: true },
    { key: "security", label: "Security", accent: "#8b5cf6", enabled: true },
    { key: "sensors", label: "IoT Sensors", accent: "#22c55e", enabled: true },
    { key: "network", label: "Network", accent: "#3b82f6", enabled: true },
    { key: "safety", label: "Fire Safety", accent: "#ef4444", enabled: true },
    { key: "hvac", label: "HVAC", accent: "#06b6d4", enabled: true },
    { key: "access", label: "Access Control", accent: "#94a3b8", enabled: true },
    { key: "lighting", label: "Lighting", accent: "#f4b84d", enabled: true },
  ];
}

function markerTypeToLayer(markerType) {
  const map = {
    cctv: "security",
    access: "access",
    sensor: "sensors",
    fire: "safety",
    light: "lighting",
    power: "electrical",
    network: "network",
    hvac: "hvac",
  };
  return map[markerType] || "security";
}

function zoneCenter(zone) {
  return {
    x: zone.x + zone.width / 2,
    y: zone.y + zone.height / 2,
  };
}

function buildMarkersFromGeometry(geometry) {
  const markers = [];
  const unitZones = geometry.zones.filter(
    (zone) =>
      zone.kind === "unit" ||
      zone.kind === "room" ||
      zone.kind === "bedroom" ||
      zone.kind === "living"
  );
  const coreZone = geometry.zones.find((zone) => zone.kind === "core" || zone.kind === "corridor");
  const entryZone = geometry.zones.find((zone) => zone.kind === "entry") || geometry.zones[0];

  unitZones.forEach((zone, index) => {
    const center = zoneCenter(zone);
    markers.push({
      id: `mk-cctv-${index + 1}`,
      type: "cctv",
      label: `${zone.label} Camera`,
      x: clamp(center.x + zone.width * 0.18, 0.04, 0.96),
      y: clamp(zone.y + zone.height * 0.22, 0.04, 0.96),
      impact: "security",
      layer: "security",
      zone_id: zone.id,
    });
    markers.push({
      id: `mk-light-${index + 1}`,
      type: "light",
      label: `${zone.label} Lighting`,
      x: center.x,
      y: center.y,
      impact: "lighting",
      layer: "lighting",
      zone_id: zone.id,
    });
    markers.push({
      id: `mk-power-${index + 1}`,
      type: "power",
      label: `${zone.label} Power Cluster`,
      x: clamp(zone.x + zone.width * 0.82, 0.04, 0.96),
      y: clamp(zone.y + zone.height * 0.72, 0.04, 0.96),
      impact: "electrical",
      layer: "electrical",
      zone_id: zone.id,
    });
    markers.push({
      id: `mk-sensor-${index + 1}`,
      type: "sensor",
      label: `${zone.label} Occupancy`,
      x: clamp(zone.x + zone.width * 0.18, 0.04, 0.96),
      y: clamp(zone.y + zone.height * 0.18, 0.04, 0.96),
      impact: "sensors",
      layer: "sensors",
      zone_id: zone.id,
    });
  });

  if (coreZone) {
    const center = zoneCenter(coreZone);
    markers.push({
      id: "mk-core-access",
      type: "access",
      label: "Core Access",
      x: center.x,
      y: clamp(coreZone.y + coreZone.height * 0.9, 0.04, 0.96),
      impact: "access",
      layer: "access",
      zone_id: coreZone.id,
    });
    markers.push({
      id: "mk-core-network",
      type: "network",
      label: "Core Network Point",
      x: center.x,
      y: clamp(coreZone.y + coreZone.height * 0.18, 0.04, 0.96),
      impact: "network",
      layer: "network",
      zone_id: coreZone.id,
    });
    markers.push({
      id: "mk-core-fire",
      type: "fire",
      label: "Core Fire Detection",
      x: center.x,
      y: center.y,
      impact: "safety",
      layer: "safety",
      zone_id: coreZone.id,
    });
  }

  if (entryZone) {
    markers.push({
      id: "mk-entry-access",
      type: "access",
      label: "Main Entrance",
      x: clamp(entryZone.x + entryZone.width * 0.5, 0.04, 0.96),
      y: clamp(entryZone.y + entryZone.height * 0.82, 0.04, 0.96),
      impact: "access",
      layer: "access",
      zone_id: entryZone.id,
    });
  }

  return markers;
}

function recommendationCatalog(geometry) {
  const unitCount =
    geometry.zones.filter((zone) => zone.kind === "unit" || zone.kind === "room").length ||
    geometry.zones.length;
  const pathCount = geometry.pathways.length;
  const openingCount = geometry.openings.length;
  return [
    {
      id: "rec-energy",
      title: "Energy Optimization",
      detail:
        unitCount > 2
          ? "Detected multiple unit zones. Promote smart metering by zone and corridor load balancing."
          : "Use smart metering and grouped load balancing around the detected core pathways.",
      impact: "High Impact",
      category: "electrical",
    },
    {
      id: "rec-security",
      title: "Security Enhancement",
      detail:
        pathCount > 1
          ? `Detected ${pathCount} circulation paths and ${openingCount} openings. Cover all path junctions with CCTV and badge-controlled access.`
          : "Expand perimeter CCTV and badge-controlled access around the detected entry and core zones.",
      impact: "High Impact",
      category: "security",
    },
    {
      id: "rec-network",
      title: "Network Optimization",
      detail:
        "Use the detected core and corridor geometry as the backbone path for PoE, CCTV VLANs, and automation uplinks.",
      impact: "Medium Impact",
      category: "network",
    },
    {
      id: "rec-lighting",
      title: "Lighting Upgrade",
      detail:
        "Apply occupancy-triggered scenes across detected zones and pathway segments to reduce idle lighting loads.",
      impact: "Medium Impact",
      category: "lighting",
    },
  ];
}

function defaultDisciplineReviews() {
  const now = null;
  const base = {
    notes: "",
    approval: "pending",
    decisions: [],
    updated_at: now,
  };
  return {
    electrical: { ...base },
    security: { ...base },
    hvac: { ...base },
    lighting: { ...base },
    "fire-safety": { ...base },
    "iot-sensors": { ...base },
    network: { ...base },
    "access-control": { ...base },
  };
}

function mergeDisciplineReviews(existing) {
  return {
    ...defaultDisciplineReviews(),
    ...(existing && typeof existing === "object" ? existing : {}),
  };
}

function buildAnalysis(projectInput) {
  const width = Number(projectInput.image_width || 1600);
  const height = Number(projectInput.image_height || 1000);
  const geometry = normalizeParsedGeometry(projectInput.parsed_geometry, width, height);
  const zoneCount = geometry.zones.length;
  const pathCount = geometry.pathways.length;
  const openingCount = geometry.openings.length;
  const densityFactor = Math.max(1, Math.round((width * height) / 600000));
  const summary = {
    cctv: Math.max(4, Math.round(zoneCount * 1.4) + pathCount + Math.round(openingCount / 3)),
    access_points: Math.max(2, Math.round(zoneCount / 3) + pathCount + Math.round(openingCount / 2)),
    sensors: Math.max(6, zoneCount * 2 + pathCount + Math.round(openingCount / 3)),
    smart_meters: Math.max(2, Math.round(zoneCount / 2) + 1),
    power_outlets: Math.max(12, zoneCount * 4 + densityFactor),
  };
  const estimate = {
    min: 7800000 + zoneCount * 350000 + pathCount * 180000,
    max: 11600000 + zoneCount * 420000 + pathCount * 260000,
    roi: clamp(Math.round(28 + geometry.confidence * 10), 24, 42),
  };
  const markers = buildMarkersFromGeometry(geometry);

  return {
    plan_state: geometry.source === "client-parser" ? "Parsed Plan Ready" : "Project Saved",
    layers: layerCatalog(),
    markers,
    summary,
    recommendations: recommendationCatalog(geometry),
    estimate,
    geometry,
    overlay: {
      zones: geometry.zones,
      pathways: geometry.pathways,
      openings: geometry.openings,
    },
    geometry_quality: {
      source: geometry.source,
      confidence: geometry.confidence,
      zone_count: zoneCount,
      pathway_count: pathCount,
      opening_count: openingCount,
    },
    generated_at: new Date().toISOString(),
  };
}

async function readStore(storePath) {
  try {
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.projects)) {
      return parsed;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { projects: [] };
}

async function writeStore(storePath, data) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(data, null, 2), "utf8");
}

function projectSummary(project) {
  return {
    id: project.id,
    name: project.name,
    file_name: project.file_name,
    created_at: project.created_at,
    updated_at: project.updated_at,
    plan_state: project.analysis?.plan_state || "Draft",
    summary: project.analysis?.summary || null,
    estimate: project.analysis?.estimate || null,
    recommendation_count: Array.isArray(project.analysis?.recommendations)
      ? project.analysis.recommendations.length
      : 0,
    marker_count: Array.isArray(project.analysis?.markers) ? project.analysis.markers.length : 0,
    geometry_quality: project.analysis?.geometry_quality || null,
    discipline_reviews: project.discipline_reviews || defaultDisciplineReviews(),
    correction_count: Array.isArray(project.training_hints) ? project.training_hints.length : 0,
  };
}

function normalizeDecisionList(decisions) {
  if (!Array.isArray(decisions)) return [];
  return decisions
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 12);
}

function createPlanStudioRuntime({ storePath }) {
  return {
    async listProjects() {
      const store = await readStore(storePath);
      return store.projects.map(projectSummary).sort((a, b) => {
        return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
      });
    },

    async getProject(projectId) {
      const store = await readStore(storePath);
      const project = store.projects.find((item) => item.id === projectId);
      return project ? clone(project) : null;
    },

    async saveProject(input) {
      const store = await readStore(storePath);
      const now = new Date().toISOString();
      const parsedGeometry = normalizeParsedGeometry(
        input.parsed_geometry,
        input.image_width,
        input.image_height
      );
      const project = {
        id: crypto.randomUUID(),
        name: deriveProjectName(input.name || input.file_name),
        file_name: String(input.file_name || "uploaded-plan.png"),
        image_data_url: String(input.image_data_url || ""),
        image_width: Number(input.image_width || 0),
        image_height: Number(input.image_height || 0),
        parsed_geometry: parsedGeometry,
        geometry_truth: null,
        training_hints: [],
        discipline_reviews: defaultDisciplineReviews(),
        created_at: now,
        updated_at: now,
        analysis: buildAnalysis({
          ...input,
          parsed_geometry: parsedGeometry,
          image_width: input.image_width,
          image_height: input.image_height,
        }),
      };
      store.projects.unshift(project);
      await writeStore(storePath, store);
      return clone(project);
    },

    async analyzeProject(projectId, parsedGeometry) {
      const store = await readStore(storePath);
      const index = store.projects.findIndex((item) => item.id === projectId);
      if (index === -1) {
        return null;
      }
      const project = store.projects[index];
      if (parsedGeometry) {
        project.parsed_geometry = normalizeParsedGeometry(
          parsedGeometry,
          project.image_width,
          project.image_height
        );
      }
      project.analysis = buildAnalysis({
        ...project,
        parsed_geometry: project.geometry_truth || project.parsed_geometry,
      });
      project.updated_at = new Date().toISOString();
      store.projects[index] = project;
      await writeStore(storePath, store);
      return clone(project);
    },

    async updateDisciplineReview(projectId, discipline, input) {
      const store = await readStore(storePath);
      const index = store.projects.findIndex((item) => item.id === projectId);
      if (index === -1) {
        return null;
      }
      const project = store.projects[index];
      const reviews = mergeDisciplineReviews(project.discipline_reviews);
      const key = String(discipline || "").trim();
      if (!reviews[key]) {
        return null;
      }
      reviews[key] = {
        notes: String(input.notes || ""),
        approval: ["pending", "review", "approved"].includes(String(input.approval || ""))
          ? String(input.approval)
          : "pending",
        decisions: normalizeDecisionList(input.decisions),
        updated_at: new Date().toISOString(),
      };
      project.discipline_reviews = reviews;
      project.updated_at = new Date().toISOString();
      store.projects[index] = project;
      await writeStore(storePath, store);
      return clone(project);
    },

    async updateGeometryTruth(projectId, input) {
      const store = await readStore(storePath);
      const index = store.projects.findIndex((item) => item.id === projectId);
      if (index === -1) {
        return null;
      }
      const project = store.projects[index];
      const truth = normalizeParsedGeometry(
        input.geometry_truth,
        project.image_width,
        project.image_height
      );
      const hint = {
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        source: input.source || "manual_correction",
        note: String(input.note || ""),
        changed_zone_id: String(input.changed_zone_id || ""),
        zone_count: truth.zones.length,
      };
      project.geometry_truth = truth;
      project.training_hints = Array.isArray(project.training_hints)
        ? [hint, ...project.training_hints].slice(0, 50)
        : [hint];
      project.analysis = buildAnalysis({
        ...project,
        parsed_geometry: project.geometry_truth,
      });
      project.updated_at = new Date().toISOString();
      store.projects[index] = project;
      await writeStore(storePath, store);
      return clone(project);
    },
  };
}

module.exports = {
  createPlanStudioRuntime,
};
