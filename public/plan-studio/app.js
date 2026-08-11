const state = {
  project: null,
  projects: [],
  loading: false,
  activeView: "2d",
  activePage: "projects",
  activeDiscipline: "electrical",
  layerFilters: new Set(["electrical", "security", "sensors", "network", "safety", "hvac", "access", "lighting"]),
  scopeVisibility: {
    markers: true,
    zones: true,
    pathways: true,
  },
  selectedZoneId: "",
  editGeometry: null,
  dragZone: null,
  toolMode: "inspect",
  measurementStart: null,
  layerPanelOpen: true,
  planZoom: 1,
  agentThread: [],
  agentProjectId: "",
};

const disciplineConfig = {
  electrical: {
    label: "Electrical",
    subtitle: "Power, metering, and critical load planning",
    description:
      "Review feeder segmentation, smart metering, outlet density, and power-path protection for the active project portfolio.",
    accent: "#f59e0b",
    key: "power_outlets",
    pointsLabel: "power points",
    scope: "Load planning and distribution",
    owner: "MEP Team",
    tasks: ["Validate load segmentation", "Confirm smart meter positions", "Align critical circuits"],
    icon:
      '<svg viewBox="0 0 24 24"><path d="m13 2-7 11h5l-1 9 8-12h-5z"/></svg>',
  },
  security: {
    label: "Security",
    subtitle: "CCTV, access, and perimeter control",
    description:
      "Plan surveillance coverage, access policies, visitor flow, and core-zone protections against blind spots and unmonitored entries.",
    accent: "#8b5cf6",
    key: "cctv",
    pointsLabel: "security endpoints",
    scope: "Camera and access coverage",
    owner: "Protection Team",
    tasks: ["Review lobby camera angles", "Confirm access zoning", "Define audit events"],
    icon:
      '<svg viewBox="0 0 24 24"><path d="M12 3 5 6v6c0 4.5 3 7.8 7 9 4-1.2 7-4.5 7-9V6l-7-3Z"/><path d="M12 9v3"/><path d="M12 16h.01"/></svg>',
  },
  hvac: {
    label: "HVAC",
    subtitle: "Air handling, zoning, and mechanical coordination",
    description:
      "Map ventilation zones, plant coordination, duct pathways, and thermal automation touchpoints before implementation.",
    accent: "#31c6ff",
    key: "sensors",
    pointsLabel: "environmental sensors",
    scope: "Mechanical coordination",
    owner: "Mechanical Team",
    tasks: ["Check ventilation zones", "Place thermal sensors", "Reserve riser paths"],
    icon:
      '<svg viewBox="0 0 24 24"><path d="M12 3v6"/><path d="M12 15v6"/><path d="M4.9 7.5 10 10.5"/><path d="m14 13.5 5.1 3"/><path d="m4.9 16.5 5.1-3"/><path d="m14 10.5 5.1-3"/></svg>',
  },
  lighting: {
    label: "Lighting",
    subtitle: "Scenes, occupancy, and common-area efficiency",
    description:
      "Tune luminaire density, occupancy logic, scene groupings, and corridor timing for efficient and comfortable operation.",
    accent: "#f4b84d",
    key: "power_outlets",
    pointsLabel: "lighting circuits",
    scope: "Scene automation and fixture planning",
    owner: "Lighting Team",
    tasks: ["Set corridor occupancy scenes", "Group apartment circuits", "Review emergency lighting"],
    icon:
      '<svg viewBox="0 0 24 24"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M8 14c-1.2-1-2-2.5-2-4a6 6 0 1 1 12 0c0 1.5-.8 3-2 4l-1 2h-6z"/></svg>',
  },
  "fire-safety": {
    label: "Fire Safety",
    subtitle: "Detection, alarms, and life-safety pathways",
    description:
      "Verify detector coverage, alarm routing, evacuation path protection, and coordination with compliance signoff.",
    accent: "#fb6f65",
    key: "sensors",
    pointsLabel: "life-safety points",
    scope: "Alarm and path coverage",
    owner: "Safety Lead",
    tasks: ["Verify detector density", "Check egress signaling", "Align life-safety approvals"],
    icon:
      '<svg viewBox="0 0 24 24"><path d="M12 3c2 2.2 3.5 4.2 3.5 6.4A3.5 3.5 0 0 1 12 13a3.5 3.5 0 0 1-3.5-3.6C8.5 7.2 10 5.2 12 3Z"/><path d="M12 13c3.3 1.6 5 4 5 6a5 5 0 0 1-10 0c0-2 1.7-4.4 5-6Z"/></svg>',
  },
  "iot-sensors": {
    label: "IoT Sensors",
    subtitle: "Sensing, telemetry, and occupancy data",
    description:
      "Coordinate sensor density, event telemetry, and automation triggers needed to turn uploaded plans into live operational twins.",
    accent: "#2fd67d",
    key: "sensors",
    pointsLabel: "sensor nodes",
    scope: "Occupancy and telemetry network",
    owner: "IoT Team",
    tasks: ["Balance coverage density", "Align telemetry tags", "Define event thresholds"],
    icon:
      '<svg viewBox="0 0 24 24"><path d="M12 12h.01"/><path d="M8.5 8.5a5 5 0 0 1 7 0"/><path d="M5 5a10 10 0 0 1 14 0"/><path d="M2 2a14.5 14.5 0 0 1 20 0"/></svg>',
  },
  network: {
    label: "Network",
    subtitle: "Backbone, PoE, and connectivity planning",
    description:
      "Review LAN topology, Wi-Fi coverage, PoE segmentation, risers, and rack placement for smart-building traffic resilience.",
    accent: "#4d8dff",
    key: "access_points",
    pointsLabel: "network endpoints",
    scope: "Backbone and connectivity design",
    owner: "ICT Team",
    tasks: ["Reserve IDF/MDF space", "Segment CCTV traffic", "Plan Wi-Fi handoff zones"],
    icon:
      '<svg viewBox="0 0 24 24"><path d="M4 8h16"/><path d="M4 16h16"/><path d="M8 4v16"/><path d="M16 4v16"/></svg>',
  },
  "access-control": {
    label: "Access Control",
    subtitle: "Doors, lift logic, and secured movement",
    description:
      "Define credential zones, lobby and core access, visitor pathways, and lift permissions tied to the final security model.",
    accent: "#95a3c4",
    key: "access_points",
    pointsLabel: "controlled entries",
    scope: "Controlled movement and doors",
    owner: "Access Team",
    tasks: ["Map secure thresholds", "Link lift permissions", "Set visitor access flow"],
    icon:
      '<svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 12h6"/><path d="M15 9l3 3-3 3"/></svg>',
  },
};

const ui = {
  uploadInput: document.getElementById("upload-input"),
  sidebarUpload: document.getElementById("sidebar-upload"),
  stageUpload: document.getElementById("stage-upload"),
  topUpload: document.getElementById("top-upload"),
  reanalyze: document.getElementById("reanalyze"),
  exportReport: document.getElementById("export-report"),
  expandPreview: document.getElementById("expand-preview"),
  closePreview: document.getElementById("close-preview"),
  previewOverlay: document.getElementById("preview-overlay"),
  projectName: document.getElementById("project-name"),
  projectStatus: document.getElementById("project-status"),
  fileName: document.getElementById("file-name"),
  emptyStage: document.getElementById("empty-stage"),
  planImage: document.getElementById("plan-image"),
  markerLayer: document.getElementById("marker-layer"),
  legend: document.getElementById("legend"),
  layerPills: document.getElementById("layer-pills"),
  scopePills: Array.from(document.querySelectorAll("[data-scope]")),
  zoneLayer: document.getElementById("zone-layer"),
  pathwayLayer: document.getElementById("pathway-layer"),
  openingLayer: document.getElementById("opening-layer"),
  layerSummary: document.getElementById("layer-summary"),
  planToolStatus: document.getElementById("plan-tool-status"),
  toolPan: document.getElementById("tool-pan"),
  toolTarget: document.getElementById("tool-target"),
  toolMeasure: document.getElementById("tool-measure"),
  toolAnnotate: document.getElementById("tool-annotate"),
  toolInspect: document.getElementById("tool-inspect"),
  layersToggle: document.getElementById("layers-toggle"),
  zoomFit: document.getElementById("zoom-fit"),
  zoomIn: document.getElementById("zoom-in"),
  zoomOut: document.getElementById("zoom-out"),
  zoomFocus: document.getElementById("zoom-focus"),
  summaryGrid: document.getElementById("summary-grid"),
  recommendList: document.getElementById("recommend-list"),
  estimateBox: document.getElementById("estimate-box"),
  projectList: document.getElementById("project-list"),
  planStage: document.getElementById("plan-stage"),
  stepUpload: document.getElementById("step-upload"),
  stepAnalyze: document.getElementById("step-analyze"),
  stepDesign: document.getElementById("step-design"),
  view2d: document.getElementById("view-2d"),
  view3d: document.getElementById("view-3d"),
  stage2d: document.getElementById("stage-2d"),
  stage3d: document.getElementById("stage-3d"),
  preview3d: document.getElementById("preview-3d"),
  preview2d: document.getElementById("preview-2d"),
  previewTab3d: document.getElementById("preview-tab-3d"),
  previewTab2d: document.getElementById("preview-tab-2d"),
  miniPlanImage: document.getElementById("mini-plan-image"),
  miniMarkerLayer: document.getElementById("mini-marker-layer"),
  navItems: Array.from(document.querySelectorAll("[data-page]")),
  pages: Array.from(document.querySelectorAll(".page")),
  railPages: Array.from(document.querySelectorAll(".rail-page")),
  metricProjectCount: document.getElementById("metric-project-count"),
  metricDisciplineCount: document.getElementById("metric-discipline-count"),
  metricSla: document.getElementById("metric-sla"),
  dashboardStatusText: document.getElementById("dashboard-status-text"),
  dashboardList1: document.getElementById("dashboard-list-1"),
  dashboardList2: document.getElementById("dashboard-list-2"),
  dashboardList3: document.getElementById("dashboard-list-3"),
  analyticsRoi: document.getElementById("analytics-roi"),
  analyticsSensors: document.getElementById("analytics-sensors"),
  analyticsRecommendations: document.getElementById("analytics-recommendations"),
  analyticsCoverageText: document.getElementById("analytics-coverage-text"),
  complianceLifeSafety: document.getElementById("compliance-life-safety"),
  complianceLifeStatus: document.getElementById("compliance-life-status"),
  compliancePower: document.getElementById("compliance-power"),
  compliancePowerStatus: document.getElementById("compliance-power-status"),
  complianceAccess: document.getElementById("compliance-access"),
  complianceAccessStatus: document.getElementById("compliance-access-status"),
  disciplineTitle: document.getElementById("discipline-title"),
  disciplineSubtitle: document.getElementById("discipline-subtitle"),
  disciplineHeroTitle: document.getElementById("discipline-hero-title"),
  disciplineDescription: document.getElementById("discipline-description"),
  disciplineBadge: document.getElementById("discipline-badge"),
  disciplineActiveProjects: document.getElementById("discipline-active-projects"),
  disciplineLayerPoints: document.getElementById("discipline-layer-points"),
  disciplineBudget: document.getElementById("discipline-budget"),
  disciplineWorkstreams: document.getElementById("discipline-workstreams"),
  disciplineRailTitle: document.getElementById("discipline-rail-title"),
  disciplineRailText: document.getElementById("discipline-rail-text"),
  disciplinePriorityList: document.getElementById("discipline-priority-list"),
  disciplineActiveProjectText: document.getElementById("discipline-active-project-text"),
  disciplineOpenProject: document.getElementById("discipline-open-project"),
  disciplineGenerateReport: document.getElementById("discipline-generate-report"),
  disciplineApproval: document.getElementById("discipline-approval"),
  disciplineDecisions: document.getElementById("discipline-decisions"),
  disciplineNotes: document.getElementById("discipline-notes"),
  disciplineSaveReview: document.getElementById("discipline-save-review"),
  disciplineReviewStatus: document.getElementById("discipline-review-status"),
  geometryReviewSummary: document.getElementById("geometry-review-summary"),
  zoneLabelInput: document.getElementById("zone-label-input"),
  zoneKindInput: document.getElementById("zone-kind-input"),
  zoneXInput: document.getElementById("zone-x-input"),
  zoneYInput: document.getElementById("zone-y-input"),
  zoneWidthInput: document.getElementById("zone-width-input"),
  zoneHeightInput: document.getElementById("zone-height-input"),
  applyZoneEdit: document.getElementById("apply-zone-edit"),
  saveGeometryTruth: document.getElementById("save-geometry-truth"),
  resetGeometryTruth: document.getElementById("reset-geometry-truth"),
  geometrySaveStatus: document.getElementById("geometry-save-status"),
  agentThread: document.getElementById("agent-thread"),
  agentInput: document.getElementById("agent-input"),
  agentSend: document.getElementById("agent-send"),
  agentStatus: document.getElementById("agent-status"),
  agentQuickPrompts: Array.from(document.querySelectorAll("[data-agent-prompt]")),
};

const markerLabels = {
  cctv: "CCTV Camera",
  access: "Access Control",
  sensor: "Motion Sensor",
  fire: "Smoke Detector",
  light: "Light",
  power: "Power Outlet",
  network: "Network Point",
};

function naira(value) {
  return `₦${Number(value || 0).toLocaleString("en-NG")}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function currentGeometry() {
  if (state.editGeometry) return state.editGeometry;
  const geometry = state.project?.analysis?.geometry;
  return geometry ? cloneJson(geometry) : null;
}

function applyPlanZoom() {
  const scale = state.planZoom || 1;
  for (const node of [ui.planImage, ui.zoneLayer, ui.pathwayLayer, ui.openingLayer, ui.markerLayer]) {
    node.style.transform = `scale(${scale})`;
    node.style.transformOrigin = "center center";
  }
}

function setPlanZoom(zoom, message) {
  state.planZoom = clamp(Number(zoom || 1), 0.7, 2.5);
  applyPlanZoom();
  ui.planToolStatus.textContent =
    message || `Canvas zoom ${Math.round(state.planZoom * 100)}%.`;
}

function setToolMode(mode, message) {
  state.toolMode = mode;
  ui.toolPan.classList.toggle("active", mode === "pan");
  ui.toolTarget.classList.toggle("active", mode === "target");
  ui.toolMeasure.classList.toggle("active", mode === "measure");
  ui.toolAnnotate.classList.toggle("active", mode === "annotate");
  ui.toolInspect.classList.toggle("active", mode === "inspect");
  if (message) {
    ui.planToolStatus.textContent = message;
  } else {
    const defaults = {
      pan: "Pan mode active. Drag across the plan to navigate the drawing surface.",
      target: "Target mode active. Click a zone to focus the review on that geometry.",
      measure: "Measure mode active. Click two points on the plan to measure a normalized span.",
      annotate: "Annotate mode active. Click inside the plan to add a new correction zone.",
      inspect: "Inspect mode active. Select a zone or marker to review details.",
    };
    ui.planToolStatus.textContent = defaults[mode] || defaults.inspect;
  }
}

function renderAgentThread() {
  clearChildren(ui.agentThread);
  if (!state.agentThread.length) {
    const bubble = document.createElement("div");
    bubble.className = "agent-bubble agent";
    bubble.textContent = "Upload a plan to get an automatic explanation, smart opportunities, and a live planning conversation.";
    ui.agentThread.appendChild(bubble);
    return;
  }
  for (const item of state.agentThread) {
    const bubble = document.createElement("div");
    bubble.className = `agent-bubble ${item.role}`;
    bubble.textContent = item.text;
    ui.agentThread.appendChild(bubble);
  }
  ui.agentThread.scrollTop = ui.agentThread.scrollHeight;
}

function selectedZone() {
  const geometry = currentGeometry();
  if (!geometry || !state.selectedZoneId) return null;
  return geometry.zones.find((zone) => zone.id === state.selectedZoneId) || null;
}

function setSelectedZone(zoneId) {
  state.selectedZoneId = zoneId || "";
  populateZoneEditor();
  if (state.project) {
    renderGeometry(state.project.analysis);
  }
}

function focusSelectedZone() {
  const zone = selectedZone();
  if (!zone) {
    setPlanZoom(1, "No selected zone to focus. Fit view restored.");
    return;
  }
  const dominantDimension = Math.max(zone.width || 0.01, zone.height || 0.01);
  const targetZoom = clamp(0.42 / dominantDimension, 0.9, 2.5);
  setPlanZoom(targetZoom, `Focused ${zone.label}. Zoom ${Math.round(targetZoom * 100)}%.`);
}

function populateZoneEditor() {
  const zone = selectedZone();
  if (!zone) {
    ui.zoneLabelInput.value = "";
    ui.zoneKindInput.value = "room";
    ui.zoneXInput.value = "";
    ui.zoneYInput.value = "";
    ui.zoneWidthInput.value = "";
    ui.zoneHeightInput.value = "";
    return;
  }
  ui.zoneLabelInput.value = zone.label || "";
  ui.zoneKindInput.value = zone.kind || "room";
  ui.zoneXInput.value = Number(zone.x).toFixed(3);
  ui.zoneYInput.value = Number(zone.y).toFixed(3);
  ui.zoneWidthInput.value = Number(zone.width).toFixed(3);
  ui.zoneHeightInput.value = Number(zone.height).toFixed(3);
}

function ensureEditableGeometry() {
  if (!state.editGeometry && state.project?.analysis?.geometry) {
    state.editGeometry = cloneJson(state.project.analysis.geometry);
  }
  return state.editGeometry;
}

async function refinePlanGeometry(dataUrl, heuristicGeometry) {
  try {
    const response = await fetch("/api/plan-studio/parse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        image_data_url: dataUrl,
        parsed_geometry: heuristicGeometry,
      }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.parsed_geometry) {
      return heuristicGeometry;
    }
    return payload.parsed_geometry;
  } catch (error) {
    console.warn("Plan geometry refinement failed, using heuristic parser", error);
    return heuristicGeometry;
  }
}

async function parsePlanGeometry(fileOrDataUrl) {
  const dataUrl =
    typeof fileOrDataUrl === "string" ? fileOrDataUrl : await readAsDataUrl(fileOrDataUrl);
  const image = await loadImage(dataUrl);
  const maxWidth = 420;
  const scale = Math.min(1, maxWidth / image.width);
  const width = Math.max(64, Math.round(image.width * scale));
  const height = Math.max(64, Math.round(image.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);

  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  const colDensity = new Array(width).fill(0);
  const rowDensity = new Array(height).fill(0);
  let inkCount = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const a = data[index + 3];
      const brightness = (r + g + b) / 3;
      const isInk = a > 20 && brightness < 242;
      if (!isInk) continue;
      inkCount += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      colDensity[x] += 1;
      rowDensity[y] += 1;
    }
  }

  if (!inkCount) {
    return {
      source: "fallback",
      confidence: 0.2,
    };
  }

  const bounds = {
    x: minX / width,
    y: minY / height,
    width: Math.max(0.08, (maxX - minX) / width),
    height: Math.max(0.08, (maxY - minY) / height),
  };
  const verticalBands = detectBands(
    colDensity,
    Math.max(6, height * 0.16),
    width,
    bounds.x,
    bounds.x + bounds.width
  );
  const horizontalBands = detectBands(
    rowDensity,
    Math.max(6, width * 0.16),
    height,
    bounds.y,
    bounds.y + bounds.height
  );
  const verticalLines = buildPartitionLines(verticalBands, bounds.x, bounds.x + bounds.width);
  const horizontalLines = buildPartitionLines(horizontalBands, bounds.y, bounds.y + bounds.height);
  const zones = buildRoomZones(verticalLines, horizontalLines, bounds);
  const pathways = buildPathwaysFromZones(zones, bounds);
  const openings = buildOpeningsFromZones(zones, bounds);

  const confidence = clamp(
    0.42 +
      Math.min(verticalLines.length, 8) * 0.03 +
      Math.min(horizontalLines.length, 8) * 0.03 +
      Math.min(zones.length, 12) * 0.015,
    0.42,
    0.92
  );

  return {
    source: "client-parser",
    confidence,
    content_bounds: bounds,
    wall_bands: {
      vertical: verticalBands,
      horizontal: horizontalBands,
    },
    zones,
    pathways,
    openings,
    image_width: image.width,
    image_height: image.height,
  };
}

function detectBands(density, threshold, dimension, minNorm = 0, maxNorm = 1) {
  const bands = [];
  let start = -1;
  const minIndex = Math.max(0, Math.floor(minNorm * density.length));
  const maxIndex = Math.min(density.length - 1, Math.ceil(maxNorm * density.length));
  for (let index = minIndex; index <= maxIndex; index += 1) {
    if (density[index] >= threshold && start === -1) {
      start = index;
      continue;
    }
    if ((density[index] < threshold || index === maxIndex) && start !== -1) {
      const end = density[index] < threshold ? index - 1 : index;
      if (end - start >= Math.max(2, Math.round(dimension * 0.006))) {
        bands.push({
          start: start / density.length,
          end: end / density.length,
          center: (start + end) / 2 / density.length,
        });
      }
      start = -1;
    }
  }
  return bands;
}

function buildPartitionLines(bands, min, max) {
  const lines = [min];
  for (const band of bands) {
    if (band.center <= min + 0.01 || band.center >= max - 0.01) continue;
    if (!lines.some((value) => Math.abs(value - band.center) < 0.03)) {
      lines.push(band.center);
    }
  }
  lines.push(max);
  return lines.sort((a, b) => a - b);
}

function buildRoomZones(verticalLines, horizontalLines, bounds) {
  const zones = [];
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  let roomCounter = 1;

  for (let row = 0; row < horizontalLines.length - 1; row += 1) {
    for (let col = 0; col < verticalLines.length - 1; col += 1) {
      const x = verticalLines[col];
      const y = horizontalLines[row];
      const cellWidth = verticalLines[col + 1] - verticalLines[col];
      const cellHeight = horizontalLines[row + 1] - horizontalLines[row];
      if (cellWidth < 0.06 || cellHeight < 0.05) continue;

      const cx = x + cellWidth / 2;
      const cy = y + cellHeight / 2;
      const nearCenterX = Math.abs(cx - centerX) < bounds.width * 0.09;
      const nearCenterY = Math.abs(cy - centerY) < bounds.height * 0.08;
      const lowerBand = cy > bounds.y + bounds.height * 0.76;
      const slender = cellWidth < bounds.width * 0.11 || cellHeight < bounds.height * 0.11;

      let kind = "room";
      let label = `Room ${roomCounter}`;
      if (nearCenterX && nearCenterY) {
        kind = "core";
        label = "Core";
      } else if (nearCenterX || nearCenterY) {
        kind = "corridor";
        label = "Circulation";
      } else if (lowerBand && Math.abs(cx - centerX) < bounds.width * 0.24) {
        kind = "entry";
        label = "Entry";
      } else if (slender) {
        kind = "service";
        label = "Service";
      } else if (cellWidth > bounds.width * 0.18 && cellHeight > bounds.height * 0.16) {
        kind = "unit";
        label = cx < centerX ? `West Room ${roomCounter}` : `East Room ${roomCounter}`;
      }

      zones.push({
        id: `zone-${row + 1}-${col + 1}`,
        label,
        kind,
        x: clamp(x, 0, 1),
        y: clamp(y, 0, 1),
        width: clamp(cellWidth, 0.04, 1),
        height: clamp(cellHeight, 0.04, 1),
      });
      roomCounter += 1;
    }
  }

  if (!zones.some((zone) => zone.kind === "entry")) {
    zones.push({
      id: "zone-entry-fallback",
      label: "Entry",
      kind: "entry",
      x: bounds.x + bounds.width * 0.35,
      y: bounds.y + bounds.height * 0.78,
      width: bounds.width * 0.3,
      height: bounds.height * 0.12,
    });
  }

  return mergeAdjacentZones(zones);
}

function mergeAdjacentZones(zones) {
  const merged = [];
  const consumed = new Set();
  for (let index = 0; index < zones.length; index += 1) {
    if (consumed.has(index)) continue;
    const current = { ...zones[index] };
    if (current.kind === "corridor" || current.kind === "core") {
      for (let nextIndex = index + 1; nextIndex < zones.length; nextIndex += 1) {
        if (consumed.has(nextIndex)) continue;
        const candidate = zones[nextIndex];
        if (candidate.kind !== current.kind) continue;
        const verticalMerge =
          Math.abs(candidate.x - current.x) < 0.03 &&
          Math.abs(candidate.width - current.width) < 0.03 &&
          Math.abs(candidate.y - (current.y + current.height)) < 0.03;
        const horizontalMerge =
          Math.abs(candidate.y - current.y) < 0.03 &&
          Math.abs(candidate.height - current.height) < 0.03 &&
          Math.abs(candidate.x - (current.x + current.width)) < 0.03;
        if (verticalMerge) {
          current.height = candidate.y + candidate.height - current.y;
          consumed.add(nextIndex);
        } else if (horizontalMerge) {
          current.width = candidate.x + candidate.width - current.x;
          consumed.add(nextIndex);
        }
      }
    }
    merged.push(current);
  }
  return merged;
}

function buildPathwaysFromZones(zones, bounds) {
  const pathways = [];
  const circulation = zones.filter(
    (zone) => zone.kind === "corridor" || zone.kind === "core" || zone.kind === "entry"
  );
  circulation.forEach((zone, index) => {
    const vertical = zone.height > zone.width;
    pathways.push({
      id: `path-${index + 1}`,
      label: zone.label,
      kind: vertical ? "vertical" : "horizontal",
      x1: vertical ? zone.x + zone.width / 2 : zone.x,
      y1: vertical ? zone.y : zone.y + zone.height / 2,
      x2: vertical ? zone.x + zone.width / 2 : zone.x + zone.width,
      y2: vertical ? zone.y + zone.height : zone.y + zone.height / 2,
    });
  });
  if (!pathways.length) {
    pathways.push({
      id: "path-fallback",
      label: "Central Access",
      kind: "vertical",
      x1: bounds.x + bounds.width / 2,
      y1: bounds.y + bounds.height * 0.14,
      x2: bounds.x + bounds.width / 2,
      y2: bounds.y + bounds.height * 0.9,
    });
  }
  return pathways;
}

function buildOpeningsFromZones(zones, bounds) {
  const openings = [];
  const rooms = zones.filter((zone) => zone.kind === "room" || zone.kind === "unit" || zone.kind === "service");
  const circulation = zones.filter(
    (zone) => zone.kind === "corridor" || zone.kind === "core" || zone.kind === "entry"
  );
  let openingIndex = 1;
  for (const room of rooms) {
    const adjacent = circulation.find((zone) => zonesTouch(zone, room));
    if (!adjacent) continue;
    const verticalTouch =
      Math.abs(room.x + room.width - adjacent.x) < 0.03 ||
      Math.abs(adjacent.x + adjacent.width - room.x) < 0.03;
    openings.push({
      id: `opening-${openingIndex}`,
      label: `${room.label} Door`,
      kind: "door",
      x: verticalTouch ? Math.max(room.x, adjacent.x) : room.x + room.width / 2,
      y: verticalTouch ? room.y + room.height / 2 : Math.max(room.y, adjacent.y),
      orientation: verticalTouch ? "vertical" : "horizontal",
    });
    openingIndex += 1;
  }
  if (!openings.length) {
    openings.push({
      id: "opening-entry",
      label: "Main Entrance",
      kind: "door",
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height * 0.9,
      orientation: "horizontal",
    });
  }
  return openings;
}

function zonesTouch(a, b) {
  const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  const sharesVertical =
    overlapX > 0.02 &&
    (Math.abs(a.y + a.height - b.y) < 0.03 || Math.abs(b.y + b.height - a.y) < 0.03);
  const sharesHorizontal =
    overlapY > 0.02 &&
    (Math.abs(a.x + a.width - b.x) < 0.03 || Math.abs(b.x + b.width - a.x) < 0.03);
  return sharesVertical || sharesHorizontal;
}

function visibleMarkers(project) {
  if (!project?.analysis?.markers) return [];
  return project.analysis.markers.filter((marker) => {
    const layer = marker.layer || markerTypeToLayer(marker.type);
    return state.layerFilters.has(layer);
  });
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

function updateScopeVisibility() {
  ui.markerLayer.hidden = !state.scopeVisibility.markers;
  ui.miniMarkerLayer.hidden = !state.scopeVisibility.markers;
  ui.zoneLayer.hidden = !state.scopeVisibility.zones;
  ui.pathwayLayer.hidden = !state.scopeVisibility.pathways;
  ui.openingLayer.hidden = !state.scopeVisibility.pathways;
  for (const button of ui.scopePills) {
    button.classList.toggle("active", state.scopeVisibility[button.dataset.scope]);
  }
}

function renderGeometry(analysis) {
  clearChildren(ui.zoneLayer);
  clearChildren(ui.pathwayLayer);
  clearChildren(ui.openingLayer);
  const geometry = currentGeometry() || analysis?.geometry || {};
  const overlay = analysis?.overlay || {};
  const zones = Array.isArray(geometry.zones || overlay.zones) ? geometry.zones || overlay.zones : [];
  const pathways = Array.isArray(geometry.pathways || overlay.pathways)
    ? geometry.pathways || overlay.pathways
    : [];
  const openings = Array.isArray(geometry.openings || overlay.openings)
    ? geometry.openings || overlay.openings
    : [];

  ui.geometryReviewSummary.textContent = analysis?.geometry_quality
    ? `Parser source: ${analysis.geometry_quality.source}. Confidence ${Math.round(
        Number(analysis.geometry_quality.confidence || 0) * 100
      )}%. Zones ${zones.length}, paths ${pathways.length}, openings ${openings.length}.`
    : "Parser review will appear here after a plan is uploaded.";

  for (const zone of zones) {
    const box = document.createElement("div");
    box.className = `zone-box${zone.id === state.selectedZoneId ? " selected" : ""}`;
    box.style.left = `${zone.x * 100}%`;
    box.style.top = `${zone.y * 100}%`;
    box.style.width = `${zone.width * 100}%`;
    box.style.height = `${zone.height * 100}%`;
    box.innerHTML = `<div class="zone-label">${zone.label}</div>`;
    box.dataset.zoneId = zone.id;
    box.addEventListener("click", (event) => {
      event.stopPropagation();
      setSelectedZone(zone.id);
    });
    box.addEventListener("pointerdown", (event) => startZonePointer(event, zone.id, "move"));
    if (zone.id === state.selectedZoneId) {
      for (const direction of ["nw", "ne", "sw", "se"]) {
        const handle = document.createElement("div");
        handle.className = `zone-handle ${direction}`;
        handle.addEventListener("pointerdown", (event) =>
          startZonePointer(event, zone.id, `resize:${direction}`)
        );
        box.appendChild(handle);
      }
    }
    ui.zoneLayer.appendChild(box);
  }

  for (const pathway of pathways) {
    const line = document.createElement("div");
    const dx = pathway.x2 - pathway.x1;
    const dy = pathway.y2 - pathway.y1;
    const length = Math.sqrt(dx * dx + dy * dy);
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    line.className = "pathway-line";
    line.style.left = `${pathway.x1 * 100}%`;
    line.style.top = `${pathway.y1 * 100}%`;
    line.style.width = `${length * 100}%`;
    line.style.transform = `rotate(${angle}deg)`;
    ui.pathwayLayer.appendChild(line);
  }

  for (const opening of openings) {
    const mark = document.createElement("div");
    mark.className = `opening-mark ${opening.orientation === "vertical" ? "vertical" : ""}`;
    mark.style.left = `${opening.x * 100}%`;
    mark.style.top = `${opening.y * 100}%`;
    mark.title = opening.label;
    ui.openingLayer.appendChild(mark);
  }

  updateScopeVisibility();
}

function startZonePointer(event, zoneId, mode) {
  if (state.activeView !== "2d" || state.toolMode === "pan") return;
  const geometry = ensureEditableGeometry();
  const zone = geometry?.zones?.find((item) => item.id === zoneId);
  if (!zone) return;
  event.preventDefault();
  event.stopPropagation();
  setSelectedZone(zoneId);
  state.dragZone = {
    mode,
    zoneId,
    startX: event.clientX,
    startY: event.clientY,
    zone: cloneJson(zone),
    rect: ui.zoneLayer.getBoundingClientRect(),
  };
}

function handleZonePointerMove(event) {
  if (!state.dragZone) return;
  const geometry = ensureEditableGeometry();
  const zone = geometry?.zones?.find((item) => item.id === state.dragZone.zoneId);
  if (!zone) return;
  const dx = (event.clientX - state.dragZone.startX) / state.dragZone.rect.width;
  const dy = (event.clientY - state.dragZone.startY) / state.dragZone.rect.height;
  const original = state.dragZone.zone;

  if (state.dragZone.mode === "move") {
    zone.x = clamp(original.x + dx, 0, 1 - zone.width);
    zone.y = clamp(original.y + dy, 0, 1 - zone.height);
  } else {
    const direction = state.dragZone.mode.split(":")[1];
    if (direction.includes("e")) {
      zone.width = clamp(original.width + dx, 0.04, 1 - original.x);
    }
    if (direction.includes("s")) {
      zone.height = clamp(original.height + dy, 0.04, 1 - original.y);
    }
    if (direction.includes("w")) {
      zone.x = clamp(original.x + dx, 0, original.x + original.width - 0.04);
      zone.width = clamp(original.width - dx, 0.04, 1 - zone.x);
    }
    if (direction.includes("n")) {
      zone.y = clamp(original.y + dy, 0, original.y + original.height - 0.04);
      zone.height = clamp(original.height - dy, 0.04, 1 - zone.y);
    }
  }
  populateZoneEditor();
  if (state.project) renderGeometry(state.project.analysis);
}

function stopZonePointer() {
  if (!state.dragZone) return;
  state.dragZone = null;
}

function planCoordinatesFromEvent(event) {
  const rect = ui.planStage.getBoundingClientRect();
  return {
    x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
    y: clamp((event.clientY - rect.top) / rect.height, 0, 1),
  };
}

function handlePlanWorkspaceClick(event) {
  if (!state.project || state.activeView !== "2d") return;
  const coords = planCoordinatesFromEvent(event);

  if (state.toolMode === "annotate") {
    const geometry = ensureEditableGeometry();
    const newZone = {
      id: `zone-manual-${Date.now()}`,
      label: "New Zone",
      kind: "room",
      x: clamp(coords.x - 0.06, 0, 0.94),
      y: clamp(coords.y - 0.05, 0, 0.95),
      width: 0.12,
      height: 0.1,
    };
    geometry.zones.push(newZone);
    setSelectedZone(newZone.id);
    ui.geometrySaveStatus.textContent = "New zone added. Save truth to persist it.";
    renderGeometry(state.project.analysis);
    return;
  }

  if (state.toolMode === "measure") {
    if (!state.measurementStart) {
      state.measurementStart = coords;
      ui.planToolStatus.textContent = `Measurement start set at ${coords.x.toFixed(3)}, ${coords.y.toFixed(3)}. Click the second point.`;
      return;
    }
    const dx = coords.x - state.measurementStart.x;
    const dy = coords.y - state.measurementStart.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    ui.planToolStatus.textContent = `Measured span: ${length.toFixed(3)} normalized units (${Math.abs(dx).toFixed(3)} x ${Math.abs(dy).toFixed(3)}).`;
    state.measurementStart = null;
    return;
  }

  if (state.toolMode === "target") {
    const geometry = currentGeometry();
    const target = geometry?.zones?.find(
      (zone) =>
        coords.x >= zone.x &&
        coords.x <= zone.x + zone.width &&
        coords.y >= zone.y &&
        coords.y <= zone.y + zone.height
    );
    if (target) {
      setSelectedZone(target.id);
      ui.planToolStatus.textContent = `Focused ${target.label}. Review or edit the selected zone in the right rail.`;
    }
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load image"));
    image.src = src;
  });
}

function portfolioStats() {
  const total = state.projects.length;
  if (!total) {
    return {
      total,
      avgRoi: 0,
      avgSensors: 0,
      avgRecommendations: 0,
      activeCount: 0,
      totalBudgetMin: 0,
      totalBudgetMax: 0,
      totalCctv: 0,
      totalAccess: 0,
      totalSensors: 0,
      totalPower: 0,
    };
  }

  let totalRoi = 0;
  let totalRecommendations = 0;
  let totalBudgetMin = 0;
  let totalBudgetMax = 0;
  let totalCctv = 0;
  let totalAccess = 0;
  let totalSensors = 0;
  let totalPower = 0;
  let activeCount = 0;

  for (const project of state.projects) {
    if (project.plan_state && project.plan_state !== "Draft") activeCount += 1;
    totalRoi += Number(project.estimate?.roi || 0);
    totalRecommendations += Number(project.recommendation_count || 0);
    totalBudgetMin += Number(project.estimate?.min || 0);
    totalBudgetMax += Number(project.estimate?.max || 0);
    totalCctv += Number(project.summary?.cctv || 0);
    totalAccess += Number(project.summary?.access_points || 0);
    totalSensors += Number(project.summary?.sensors || 0);
    totalPower += Number(project.summary?.power_outlets || 0);
  }

  return {
    total,
    avgRoi: Math.round(totalRoi / total),
    avgSensors: Math.round(totalSensors / total),
    avgRecommendations: Number((totalRecommendations / total).toFixed(1)),
    activeCount,
    totalBudgetMin,
    totalBudgetMax,
    totalCctv,
    totalAccess,
    totalSensors,
    totalPower,
  };
}

function statusTone(value) {
  if (value >= 0.75) return "live";
  if (value >= 0.45) return "review";
  return "warning";
}

function setStatusPill(node, label, tone) {
  node.textContent = label;
  node.className = `status-pill ${tone}`;
}

function renderPortfolioPages() {
  const stats = portfolioStats();
  ui.metricProjectCount.textContent = String(stats.total);
  ui.metricDisciplineCount.textContent = String(stats.activeCount);
  ui.metricSla.textContent = `${stats.total ? Math.max(84, Math.min(98, 88 + stats.activeCount)) : 0}%`;
  ui.dashboardStatusText.textContent = stats.total
    ? `${stats.total} saved project${stats.total === 1 ? "" : "s"} are now in the planning workspace, with ${stats.activeCount} already carrying analyzed infrastructure scope.`
    : "No projects have been uploaded yet. Start with a floor plan to populate intake, analysis, and delivery workflows.";
  ui.dashboardList1.textContent = stats.total
    ? `${stats.total} project file${stats.total === 1 ? "" : "s"} are available for cross-discipline review.`
    : "Upload and triage new plans from clients.";
  ui.dashboardList2.textContent = stats.total
    ? `${stats.totalCctv} CCTV points, ${stats.totalAccess} access points, and ${stats.totalSensors} sensors are currently modeled across saved work.`
    : "Route electrical, security, HVAC, and network reviews.";
  ui.dashboardList3.textContent = stats.total
    ? `Estimated rollout portfolio range: ${naira(stats.totalBudgetMin)} - ${naira(stats.totalBudgetMax)}.`
    : "Move approved projects into implementation and operations.";

  ui.analyticsRoi.textContent = `${stats.avgRoi}%`;
  ui.analyticsSensors.textContent = String(stats.avgSensors);
  ui.analyticsRecommendations.textContent = String(stats.avgRecommendations);
  ui.analyticsCoverageText.textContent = stats.total
    ? `Across ${stats.total} saved project${stats.total === 1 ? "" : "s"}, the average model carries ${stats.avgSensors} sensors and ${stats.avgRecommendations} recommendations with an average ROI projection of ${stats.avgRoi}%.`
    : "Analytics will populate once projects are uploaded and analyzed.";

  const active = state.project;
  const fireCoverage = active ? Number(active.analysis?.summary?.sensors || 0) / 20 : 0;
  const powerCoverage = active ? Number(active.analysis?.summary?.power_outlets || 0) / 25 : 0;
  const accessCoverage = active ? Number(active.analysis?.summary?.access_points || 0) / 8 : 0;
  ui.complianceLifeSafety.textContent = active
    ? `${active.analysis.summary.sensors} sensor-linked safety points mapped in ${active.name}.`
    : "Detectors, paths, alarms";
  setStatusPill(ui.complianceLifeStatus, active ? (fireCoverage >= 0.75 ? "Ready" : "Review") : "Review", statusTone(fireCoverage));
  ui.compliancePower.textContent = active
    ? `${active.analysis.summary.power_outlets} managed outlets and metering loads identified.`
    : "Critical vs non-critical loads";
  setStatusPill(ui.compliancePowerStatus, active ? (powerCoverage >= 0.75 ? "Approved" : "Pending") : "Approved", statusTone(powerCoverage));
  ui.complianceAccess.textContent = active
    ? `${active.analysis.summary.access_points} controlled access points under design review.`
    : "Entrances and lift control";
  setStatusPill(ui.complianceAccessStatus, active ? (accessCoverage >= 0.75 ? "Ready" : "Pending") : "Pending", statusTone(accessCoverage));
}

function renderDisciplinePage(pageName) {
  const config = disciplineConfig[pageName];
  if (!config) return;
  state.activeDiscipline = pageName;
  const stats = portfolioStats();
  const project = state.project;
  const relevantValue = project ? Number(project.analysis?.summary?.[config.key] || 0) : 0;
  const avgBudget = stats.total ? Math.round((stats.totalBudgetMin + stats.totalBudgetMax) / (2 * stats.total)) : 0;

  ui.disciplineTitle.textContent = config.label;
  ui.disciplineSubtitle.textContent = config.subtitle;
  ui.disciplineHeroTitle.textContent = `${config.label} Design Workspace`;
  ui.disciplineDescription.textContent = config.description;
  ui.disciplineBadge.style.color = config.accent;
  ui.disciplineBadge.innerHTML = config.icon;
  ui.disciplineActiveProjects.textContent = String(stats.activeCount);
  ui.disciplineLayerPoints.textContent = String(relevantValue);
  ui.disciplineBudget.textContent = naira(avgBudget);
  ui.disciplineRailTitle.textContent = `${config.label} Summary`;
  ui.disciplineRailText.textContent = config.description;
  ui.disciplineActiveProjectText.textContent = project
    ? `${project.name} is the active project. Current ${config.pointsLabel}: ${relevantValue}.`
    : "Open a project from the saved list to apply current plan data to this discipline workspace.";

  clearChildren(ui.disciplinePriorityList);
  for (const task of config.tasks) {
    const item = document.createElement("li");
    item.textContent = task;
    ui.disciplinePriorityList.appendChild(item);
  }

  clearChildren(ui.disciplineWorkstreams);
  const rows = [
    [`${config.label} base scope`, project ? project.name : "Awaiting active project", project ? "Review" : "Pending", config.owner],
    [`${config.label} detailed routing`, config.scope, relevantValue > 0 ? "Ready" : "Pending", config.owner],
    [`${config.label} commissioning handoff`, `${config.pointsLabel} and reporting`, stats.activeCount > 0 ? "Review" : "Pending", "Operations Team"],
  ];
  for (const [name, focus, status, owner] of rows) {
    const row = document.createElement("div");
    const tone = status === "Ready" ? "live" : status === "Review" ? "review" : "warning";
    row.className = "table-row";
    row.innerHTML = `
      <div><strong>${name}</strong><span>${focus}</span></div>
      <div>${project ? project.file_name : "No file loaded"}</div>
      <div><span class="status-pill ${tone}">${status}</span></div>
      <div>${owner}</div>
    `;
    ui.disciplineWorkstreams.appendChild(row);
  }
  loadDisciplineReview(pageName);
}

function setActiveView(view) {
  state.activeView = view === "3d" ? "3d" : "2d";
  const show3dMain = state.activeView === "3d";

  ui.view2d.classList.toggle("active", !show3dMain);
  ui.view3d.classList.toggle("active", show3dMain);

  ui.stage2d.hidden = show3dMain;
  ui.stage3d.hidden = !show3dMain;
  ui.planStage.classList.toggle("dark-surface", show3dMain);
  ui.planStage.classList.toggle("clickable", !show3dMain);

  ui.preview3d.hidden = show3dMain;
  ui.preview2d.hidden = !show3dMain;
  ui.previewTab3d.classList.toggle("active", !show3dMain);
  ui.previewTab2d.classList.toggle("active", show3dMain);
}

function setBusy(isBusy, label) {
  state.loading = isBusy;
  const busyLabel = label || "Working";
  ui.sidebarUpload.disabled = isBusy;
  ui.stageUpload.disabled = isBusy;
  ui.topUpload.disabled = isBusy;
  ui.reanalyze.disabled = isBusy || !state.project;
  ui.exportReport.disabled = isBusy || !state.project;

  if (isBusy) {
    ui.topUpload.textContent = busyLabel;
  } else {
    ui.topUpload.textContent = "Upload";
    ui.reanalyze.textContent = "Analyze";
  }
}

function showPage(pageName) {
  const current = pageName || "projects";
  state.activePage = current;
  const disciplinePage = Boolean(disciplineConfig[current]);
  const mainPageId = disciplinePage ? "page-discipline" : `page-${current}`;
  const railPageId = disciplinePage ? "rail-discipline" : `rail-${current}`;
  for (const item of ui.navItems) {
    item.classList.toggle("active", item.dataset.page === current);
  }
  for (const page of ui.pages) {
    page.classList.toggle("active", page.id === mainPageId);
  }
  for (const page of ui.railPages) {
    page.classList.toggle("active", page.id === railPageId);
  }
  if (disciplinePage) {
    renderDisciplinePage(current);
  }
}

function resetWorkspace() {
  state.project = null;
  state.agentThread = [];
  state.measurementStart = null;
  state.planZoom = 1;
  ui.projectName.textContent = "Ochiga Planning Workspace";
  ui.projectStatus.textContent = "Awaiting plan upload";
  ui.fileName.textContent = "No plan uploaded yet";
  ui.emptyStage.hidden = false;
  ui.emptyStage.style.display = "grid";
  ui.planImage.hidden = true;
  ui.planImage.removeAttribute("src");
  ui.miniPlanImage.hidden = true;
  ui.miniPlanImage.removeAttribute("src");
  clearChildren(ui.markerLayer);
  clearChildren(ui.miniMarkerLayer);
  clearChildren(ui.zoneLayer);
  clearChildren(ui.pathwayLayer);
  clearChildren(ui.openingLayer);
  clearChildren(ui.legend);
  clearChildren(ui.layerPills);
  clearChildren(ui.summaryGrid);
  clearChildren(ui.recommendList);
  ui.estimateBox.innerHTML = "";
  ui.layerSummary.textContent = "All layers visible.";
  ui.disciplineReviewStatus.textContent = "No saved review yet.";
  ui.agentStatus.textContent = "Upload a plan to start the live planner.";
  ui.agentInput.value = "";
  syncWorkflow(null);
  syncProjectSelection();
  setBusy(false);
  setActiveView("2d");
  renderAgentThread();
  setToolMode("inspect");
  applyPlanZoom();
  if (ui.metricProjectCount) ui.metricProjectCount.textContent = String(state.projects.length || 0);
  renderPortfolioPages();
  if (disciplineConfig[state.activePage]) renderDisciplinePage(state.activePage);
}

function syncWorkflow(project) {
  const hasProject = Boolean(project);
  ui.stepUpload.className = `workflow-step${hasProject ? " active" : " done"}`;
  ui.stepAnalyze.className = `workflow-step${hasProject ? " active" : ""}`;
  ui.stepDesign.className = `workflow-step${hasProject ? " active" : ""}`;
}

function syncProjectSelection() {
  const nodes = ui.projectList.querySelectorAll("[data-project-id]");
  for (const node of nodes) {
    node.classList.toggle("active", node.dataset.projectId === state.project?.id);
  }
}

function renderProject(project) {
  state.project = project;
  if (state.agentProjectId !== project.id) {
    state.agentProjectId = project.id;
    state.agentThread = [];
  }
  state.editGeometry = cloneJson(project.geometry_truth || project.analysis.geometry || project.analysis.overlay || {});
  state.selectedZoneId = state.editGeometry?.zones?.[0]?.id || "";
  ui.projectName.textContent = project.name;
  ui.projectStatus.textContent = project.analysis.plan_state;
  ui.fileName.textContent = project.file_name;
  ui.emptyStage.hidden = true;
  ui.emptyStage.style.display = "none";
  ui.planImage.hidden = false;
  ui.planImage.src = project.image_data_url;
  ui.miniPlanImage.hidden = false;
  ui.miniPlanImage.src = project.image_data_url;
  ui.agentStatus.textContent = "Planner ready. Ask about rooms, smart integrations, or design changes.";
  state.planZoom = 1;
  applyPlanZoom();

  renderMarkers(visibleMarkers(project));
  renderLegend(visibleMarkers(project));
  renderGeometry(project.analysis);
  renderLayers(project.analysis.layers);
  renderSummary(project.analysis.summary);
  renderRecommendations(project.analysis.recommendations);
  renderEstimate(project.analysis.estimate);
  syncWorkflow(project);
  syncProjectSelection();
  setBusy(false);
  if (ui.metricProjectCount) ui.metricProjectCount.textContent = String(state.projects.length || 0);
  renderPortfolioPages();
  if (disciplineConfig[state.activePage]) renderDisciplinePage(state.activePage);
  populateZoneEditor();
  ui.geometrySaveStatus.textContent = project.training_hints?.length
    ? `${project.training_hints.length} saved correction${project.training_hints.length === 1 ? "" : "s"}.`
    : "No manual corrections saved yet.";
  renderAgentThread();
  if (!state.agentThread.length) {
    ui.agentStatus.textContent = "Planner is preparing an automatic summary...";
    queueMicrotask(async () => {
      try {
        await askPlanner(
          "Explain this plan in plain English, identify the main spaces, and list the strongest smart infrastructure opportunities."
        );
      } catch (error) {
        ui.agentStatus.textContent = "Planner summary could not be generated automatically.";
      }
    });
  }
}

function renderMarkers(markers) {
  clearChildren(ui.markerLayer);
  clearChildren(ui.miniMarkerLayer);
  for (const marker of markers) {
    const dot = document.createElement("div");
    dot.className = `marker ${marker.type}`;
    dot.style.left = `${marker.x * 100}%`;
    dot.style.top = `${marker.y * 100}%`;
    dot.textContent = marker.label[0];
    dot.title = marker.label;
    ui.markerLayer.appendChild(dot);

    const miniDot = document.createElement("div");
    miniDot.className = `mini-marker ${marker.type}`;
    miniDot.style.left = `${marker.x * 100}%`;
    miniDot.style.top = `${marker.y * 100}%`;
    ui.miniMarkerLayer.appendChild(miniDot);
  }
}

function renderLegend(markers) {
  clearChildren(ui.legend);
  const seen = new Set();
  for (const marker of markers) {
    if (seen.has(marker.type)) continue;
    seen.add(marker.type);
    const item = document.createElement("div");
    item.className = "legend-item";
    item.innerHTML = `<span class="legend-dot ${marker.type}"></span><span>${markerLabels[marker.type] || marker.type}</span>`;
    ui.legend.appendChild(item);
  }
}

function renderLayers(layers) {
  clearChildren(ui.layerPills);
  const activeLabels = [];
  for (const layer of layers) {
    const pill = document.createElement("button");
    pill.className = `chip-btn${layer.enabled ? " active" : ""}`;
    pill.textContent = layer.label;
    const enabled = state.layerFilters.has(layer.key);
    pill.className = `chip-btn${enabled ? " active" : ""}`;
    pill.style.borderColor = enabled ? layer.accent : "";
    pill.addEventListener("click", () => toggleLayer(layer.key));
    ui.layerPills.appendChild(pill);
    if (enabled) activeLabels.push(layer.label);
  }
  ui.layerSummary.textContent = activeLabels.length
    ? `${activeLabels.length} active layer${activeLabels.length === 1 ? "" : "s"}: ${activeLabels.join(", ")}`
    : "No layers visible.";
  ui.layerPills.style.display = state.layerPanelOpen ? "flex" : "none";
}

function renderSummary(summary) {
  clearChildren(ui.summaryGrid);
  const items = [
    ["CCTV", summary.cctv],
    ["Access Points", summary.access_points],
    ["Sensors", summary.sensors],
    ["Smart Meters", summary.smart_meters],
    ["Power Outlets", summary.power_outlets],
  ];
  for (const [label, value] of items) {
    const item = document.createElement("div");
    item.className = "summary-item";
    item.innerHTML = `<strong>${value}</strong><span>${label}</span>`;
    ui.summaryGrid.appendChild(item);
  }
}

function renderRecommendations(recommendations) {
  clearChildren(ui.recommendList);
  for (const recommendation of recommendations) {
    const tone = recommendation.impact.toLowerCase().includes("high") ? "high" : "medium";
    const item = document.createElement("div");
    item.className = "recommend-item";
    item.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
        <div>
          <h4>${recommendation.title}</h4>
          <p>${recommendation.detail}</p>
        </div>
        <span class="impact ${tone}">${recommendation.impact}</span>
      </div>
    `;
    ui.recommendList.appendChild(item);
  }
}

function renderEstimate(estimate) {
  ui.estimateBox.innerHTML = `
    <div>
      <strong>${naira(estimate.min)} - ${naira(estimate.max)}</strong>
      <p style="margin:12px 0 0;color:var(--muted);line-height:1.45">
        Structured smart-infrastructure estimate aligned to planning-stage deployment.
      </p>
    </div>
    <div class="roi-ring">ROI ${estimate.roi}%</div>
  `;
}

function toggleLayer(layerKey) {
  if (state.layerFilters.has(layerKey)) {
    state.layerFilters.delete(layerKey);
  } else {
    state.layerFilters.add(layerKey);
  }
  if (state.project) {
    renderMarkers(visibleMarkers(state.project));
    renderLegend(visibleMarkers(state.project));
    renderLayers(state.project.analysis.layers);
  }
}

function loadDisciplineReview(pageName) {
  const review = state.project?.discipline_reviews?.[pageName];
  ui.disciplineApproval.value = review?.approval || "pending";
  ui.disciplineDecisions.value = Array.isArray(review?.decisions) ? review.decisions.join(", ") : "";
  ui.disciplineNotes.value = review?.notes || "";
  ui.disciplineReviewStatus.textContent = review?.updated_at
    ? `Saved ${new Date(review.updated_at).toLocaleString()}`
    : "No saved review yet.";
}

function applyZoneEditorChanges() {
  const geometry = ensureEditableGeometry();
  const zone = geometry?.zones?.find((item) => item.id === state.selectedZoneId);
  if (!zone) return;
  zone.label = ui.zoneLabelInput.value.trim() || zone.label;
  zone.kind = ui.zoneKindInput.value || zone.kind;
  zone.x = clamp(Number(ui.zoneXInput.value || zone.x), 0, 1);
  zone.y = clamp(Number(ui.zoneYInput.value || zone.y), 0, 1);
  zone.width = clamp(Number(ui.zoneWidthInput.value || zone.width), 0.04, 1 - zone.x);
  zone.height = clamp(Number(ui.zoneHeightInput.value || zone.height), 0.04, 1 - zone.y);
  renderGeometry(state.project.analysis);
}

async function saveGeometryTruth() {
  if (!state.project || !state.editGeometry) return;
  ui.saveGeometryTruth.disabled = true;
  ui.geometrySaveStatus.textContent = "Saving geometry truth...";
  const response = await fetch("/api/plan-studio/geometry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project_id: state.project.id,
      geometry_truth: state.editGeometry,
      changed_zone_id: state.selectedZoneId,
      note: state.selectedZoneId ? `Manual correction for ${state.selectedZoneId}` : "Manual geometry correction",
      source: "manual_correction",
    }),
  });
  const payload = await response.json();
  ui.saveGeometryTruth.disabled = false;
  if (!response.ok) {
    throw new Error(payload.error || "Failed to save geometry truth");
  }
  renderProject(payload.project);
}

function resetGeometryTruth() {
  if (!state.project) return;
  state.editGeometry = cloneJson(state.project.analysis.geometry || state.project.analysis.overlay || {});
  state.selectedZoneId = state.editGeometry?.zones?.[0]?.id || "";
  renderGeometry(state.project.analysis);
  populateZoneEditor();
  ui.geometrySaveStatus.textContent = "Geometry editor reset to current parsed/project truth state.";
}

async function askPlanner(prompt) {
  if (!state.project) return;
  const question = String(prompt || ui.agentInput.value || "").trim();
  if (!question) return;
  state.agentThread.push({ role: "user", text: question });
  renderAgentThread();
  ui.agentStatus.textContent = "Planner is analyzing the project...";
  ui.agentSend.disabled = true;
  const response = await fetch("/api/plan-studio/agent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project_id: state.project.id,
      question,
    }),
  });
  const payload = await response.json();
  ui.agentSend.disabled = false;
  if (!response.ok) {
    throw new Error(payload.error || "Planner request failed");
  }
  state.agentThread.push({ role: "agent", text: payload.reply || "No planner response available." });
  renderAgentThread();
  ui.agentStatus.textContent = "Planner updated from the current project analysis.";
  ui.agentInput.value = "";
}

function renderProjectsList() {
  clearChildren(ui.projectList);
  if (!state.projects.length) {
    const empty = document.createElement("div");
    empty.className = "project-item";
    empty.innerHTML = `<h4>No saved projects</h4><p>Upload a plan to start the analysis workflow.</p>`;
    ui.projectList.appendChild(empty);
    return;
  }

  for (const project of state.projects) {
    const card = document.createElement("button");
    card.className = "project-item";
    card.dataset.projectId = project.id;
    card.style.textAlign = "left";
    card.style.border = "0";
    card.innerHTML = `
      <h4>${project.name}</h4>
      <p>${project.file_name}</p>
      <small>${project.plan_state} • ${new Date(project.updated_at).toLocaleString()}</small>
    `;
    card.addEventListener("click", () => loadProject(project.id));
    ui.projectList.appendChild(card);
  }

  syncProjectSelection();
}

async function fetchProjects() {
  const response = await fetch("/api/plan-studio/projects");
  const payload = await response.json();
  state.projects = payload.projects || [];
  if (ui.metricProjectCount) ui.metricProjectCount.textContent = String(state.projects.length || 0);
  renderProjectsList();
  renderPortfolioPages();
  if (!state.projects.length) {
    resetWorkspace();
    return;
  }
  if (!state.project && state.projects[0]) {
    await loadProject(state.projects[0].id);
  }
}

async function loadProject(projectId) {
  setBusy(true, "Loading");
  const response = await fetch(`/api/plan-studio/project?id=${encodeURIComponent(projectId)}`);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Failed to load project");
  renderProject(payload.project);
}

async function saveUpload(file) {
  setBusy(true, "Uploading");
  const dataUrl = await readAsDataUrl(file);
  const dimensions = await measureImage(dataUrl);
  const heuristicGeometry = await parsePlanGeometry(dataUrl);
  const parsedGeometry = await refinePlanGeometry(dataUrl, heuristicGeometry);
  const response = await fetch("/api/plan-studio/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      file_name: file.name,
      image_data_url: dataUrl,
      image_width: dimensions.width,
      image_height: dimensions.height,
      parsed_geometry: parsedGeometry,
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Failed to save project");
  await fetchProjects();
  renderProject(payload.project);
}

async function analyzeCurrentProject() {
  if (!state.project) return;
  setBusy(true, "Analyzing");
  ui.reanalyze.textContent = "Analyzing";
  const heuristicGeometry = await parsePlanGeometry(state.project.image_data_url);
  const parsedGeometry = await refinePlanGeometry(
    state.project.image_data_url,
    heuristicGeometry
  );
  const response = await fetch("/api/plan-studio/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project_id: state.project.id, parsed_geometry: parsedGeometry }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Failed to analyze project");
  renderProject(payload.project);
  await fetchProjects();
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function measureImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.width, height: image.height });
    image.onerror = () => reject(new Error("Failed to measure image"));
    image.src = dataUrl;
  });
}

function exportReport() {
  if (!state.project) return;
  const lines = [
    `Ochiga Plan Studio Report`,
    ``,
    `Project: ${state.project.name}`,
    `Source File: ${state.project.file_name}`,
    `Status: ${state.project.analysis.plan_state}`,
    ``,
    `Summary`,
    `- CCTV: ${state.project.analysis.summary.cctv}`,
    `- Access Points: ${state.project.analysis.summary.access_points}`,
    `- Sensors: ${state.project.analysis.summary.sensors}`,
    `- Smart Meters: ${state.project.analysis.summary.smart_meters}`,
    `- Power Outlets: ${state.project.analysis.summary.power_outlets}`,
    ``,
    `Recommendations`,
    ...state.project.analysis.recommendations.map(
      (item) => `- ${item.title}: ${item.detail} (${item.impact})`
    ),
    ``,
    `Estimated Investment: ${naira(state.project.analysis.estimate.min)} - ${naira(
      state.project.analysis.estimate.max
    )}`,
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${state.project.name.replace(/\s+/g, "_").toLowerCase()}_report.txt`;
  link.click();
  URL.revokeObjectURL(url);
}

function bindEvents() {
  const triggerUpload = () => ui.uploadInput.click();
  for (const item of ui.navItems) {
    item.addEventListener("click", () => showPage(item.dataset.page));
  }
  window.addEventListener("pointermove", handleZonePointerMove);
  window.addEventListener("pointerup", stopZonePointer);
  for (const button of ui.scopePills) {
    button.addEventListener("click", () => {
      const key = button.dataset.scope;
      state.scopeVisibility[key] = !state.scopeVisibility[key];
      updateScopeVisibility();
    });
  }
  ui.sidebarUpload.addEventListener("click", triggerUpload);
  ui.stageUpload.addEventListener("click", triggerUpload);
  ui.topUpload.addEventListener("click", triggerUpload);
  ui.toolPan.addEventListener("click", () => setToolMode("pan"));
  ui.toolTarget.addEventListener("click", () => setToolMode("target"));
  ui.toolMeasure.addEventListener("click", () => setToolMode("measure"));
  ui.toolAnnotate.addEventListener("click", () => setToolMode("annotate"));
  ui.toolInspect.addEventListener("click", () => setToolMode("inspect"));
  ui.layersToggle.addEventListener("click", () => {
    state.layerPanelOpen = !state.layerPanelOpen;
    ui.layerPills.style.display = state.layerPanelOpen ? "flex" : "none";
    ui.layersToggle.textContent = state.layerPanelOpen ? "Layers ▾" : "Layers ▸";
    ui.planToolStatus.textContent = state.layerPanelOpen
      ? "Infrastructure layer list opened in the right rail."
      : "Infrastructure layer list collapsed in the right rail.";
  });
  ui.view2d.addEventListener("click", () => setActiveView("2d"));
  ui.view3d.addEventListener("click", () => setActiveView("3d"));
  ui.zoomFit.addEventListener("click", () => setPlanZoom(1, "Plan fitted to the workspace."));
  ui.zoomIn.addEventListener("click", () => setPlanZoom(state.planZoom + 0.15));
  ui.zoomOut.addEventListener("click", () => setPlanZoom(state.planZoom - 0.15));
  ui.zoomFocus.addEventListener("click", () => focusSelectedZone());
  ui.previewTab3d.addEventListener("click", () => setActiveView("2d"));
  ui.previewTab2d.addEventListener("click", () => setActiveView("3d"));
  ui.planStage.addEventListener("click", (event) => {
    if (state.activeView !== "2d") return;
    if (!state.project && !state.loading && event.target.closest("#empty-stage")) {
      triggerUpload();
      return;
    }
    if (state.project && !event.target.closest(".zone-box")) {
      handlePlanWorkspaceClick(event);
    }
  });
  ui.uploadInput.addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      await saveUpload(file);
    } catch (error) {
      setBusy(false);
      window.alert(error.message || String(error));
    } finally {
      ui.uploadInput.value = "";
    }
  });
  ui.reanalyze.addEventListener("click", async () => {
    try {
      await analyzeCurrentProject();
    } catch (error) {
      setBusy(false);
      window.alert(error.message || String(error));
    }
  });
  ui.exportReport.addEventListener("click", exportReport);
  ui.expandPreview.addEventListener("click", () => {
    ui.previewOverlay.classList.add("open");
  });
  ui.closePreview.addEventListener("click", () => {
    ui.previewOverlay.classList.remove("open");
  });
  ui.previewOverlay.addEventListener("click", (event) => {
    if (event.target === ui.previewOverlay) {
      ui.previewOverlay.classList.remove("open");
    }
  });
  ui.disciplineOpenProject.addEventListener("click", () => showPage("projects"));
  ui.disciplineGenerateReport.addEventListener("click", exportReport);
  ui.applyZoneEdit.addEventListener("click", applyZoneEditorChanges);
  ui.saveGeometryTruth.addEventListener("click", async () => {
    try {
      await saveGeometryTruth();
    } catch (error) {
      ui.saveGeometryTruth.disabled = false;
      ui.geometrySaveStatus.textContent = "Geometry truth save failed.";
      window.alert(error.message || String(error));
    }
  });
  ui.resetGeometryTruth.addEventListener("click", resetGeometryTruth);
  ui.agentSend.addEventListener("click", async () => {
    try {
      await askPlanner();
    } catch (error) {
      ui.agentSend.disabled = false;
      ui.agentStatus.textContent = "Planner request failed.";
      window.alert(error.message || String(error));
    }
  });
  for (const button of ui.agentQuickPrompts) {
    button.addEventListener("click", async () => {
      try {
        await askPlanner(button.dataset.agentPrompt);
      } catch (error) {
        ui.agentSend.disabled = false;
        ui.agentStatus.textContent = "Planner request failed.";
        window.alert(error.message || String(error));
      }
    });
  }
  ui.disciplineSaveReview.addEventListener("click", async () => {
    try {
      await saveDisciplineReview();
    } catch (error) {
      ui.disciplineSaveReview.disabled = false;
      ui.disciplineReviewStatus.textContent = "Review save failed.";
      window.alert(error.message || String(error));
    }
  });
}

async function init() {
  resetWorkspace();
  bindEvents();
  updateScopeVisibility();
  showPage("projects");
  await fetchProjects();
}

async function saveDisciplineReview() {
  if (!state.project || !state.activeDiscipline) return;
  ui.disciplineSaveReview.disabled = true;
  ui.disciplineReviewStatus.textContent = "Saving review...";
  const decisions = ui.disciplineDecisions.value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const response = await fetch("/api/plan-studio/discipline", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project_id: state.project.id,
      discipline: state.activeDiscipline,
      approval: ui.disciplineApproval.value,
      notes: ui.disciplineNotes.value,
      decisions,
    }),
  });
  const payload = await response.json();
  ui.disciplineSaveReview.disabled = false;
  if (!response.ok) {
    throw new Error(payload.error || "Failed to save discipline review");
  }
  renderProject(payload.project);
  showPage(state.activePage);
}

init().catch((error) => {
  console.error(error);
  window.alert(error.message || "Failed to start Plan Studio");
});
