const state = {
  sceneData: null,
  selected: null,
  selectedWaypointId: null,
  camera: {
    yaw: Math.PI,
    pitch: 0.5,
    distance: 32,
    target: { x: 0, y: 1.2, z: 0 },
  },
  drag: null,
  projectedHotspots: [],
  projectedWaypoints: [],
  frame: 0,
  floorFilter: "all",
  viewMode: "section",
  autoFitMode: true,
  viewport: {
    width: 1,
    height: 1,
    ratio: 1,
  },
};

if (new URLSearchParams(window.location.search).get("embed") === "1") {
  document.body.classList.add("embed");
}

const ui = {
  root: document.getElementById("scene-root"),
  waypoints: document.getElementById("waypoints"),
  devices: document.getElementById("devices"),
  connectors: document.getElementById("connectors"),
  floorButtons: Array.from(document.querySelectorAll("[data-floor]")),
  modeButtons: Array.from(document.querySelectorAll("[data-mode]")),
  fitView: document.getElementById("fit-view"),
  selectionTitle: document.getElementById("selection-title"),
  selectionBadge: document.getElementById("selection-badge"),
  selectionCopy: document.getElementById("selection-copy"),
  selectionMeta: document.getElementById("selection-meta"),
  selectionActions: document.getElementById("selection-actions"),
  syncEdge: document.getElementById("sync-edge"),
  syncStamp: document.getElementById("sync-stamp"),
  metricRooms: document.getElementById("metric-rooms"),
  metricDevices: document.getElementById("metric-devices"),
  metricFootprint: document.getElementById("metric-footprint"),
  metricEdge: document.getElementById("metric-edge"),
};

const canvas = document.createElement("canvas");
const context = canvas.getContext("2d");
canvas.style.width = "100%";
canvas.style.height = "100%";
canvas.style.display = "block";
ui.root.appendChild(canvas);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clearChildren(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

function appendMetaPill(text) {
  const pill = document.createElement("span");
  pill.className = "pill";
  pill.textContent = text;
  ui.selectionMeta.appendChild(pill);
}

function actionLabel(action) {
  const map = {
    "toggle-power": "Toggle Power",
    "dim-up": "Dim Up",
    "dim-down": "Dim Down",
    lock: "Lock",
    unlock: "Unlock",
    "pulse-open": "Pulse Open",
    "toggle-recording": "Toggle Recording",
    snapshot: "Snapshot",
    "call-lift": "Call Lift",
    "set-service-mode": "Service Mode",
    "set-normal-mode": "Normal Mode",
  };
  return map[action] || action;
}

function deviceSummary(device) {
  if (device.type === "light") {
    return device.state.power ? `On at ${device.state.level}%` : "Off";
  }
  if (device.type === "door") {
    if (device.state.open) return "Door pulsed open";
    return device.state.locked ? "Locked" : "Unlocked";
  }
  if (device.type === "camera") {
    return device.state.recording ? "Recording live" : "Standby";
  }
  return `${device.state.mode} mode, floor ${device.state.floor}`;
}

function hexToRgba(hex, alpha = 1) {
  const value = String(hex || "#999999").replace("#", "");
  const normal = value.length === 3
    ? value
        .split("")
        .map((char) => char + char)
        .join("")
    : value;
  const r = parseInt(normal.slice(0, 2), 16);
  const g = parseInt(normal.slice(2, 4), 16);
  const b = parseInt(normal.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function mixColor(hex, weight = 0.12) {
  const value = String(hex || "#999999").replace("#", "");
  const normal = value.length === 3
    ? value
        .split("")
        .map((char) => char + char)
        .join("")
    : value;
  const r = parseInt(normal.slice(0, 2), 16);
  const g = parseInt(normal.slice(2, 4), 16);
  const b = parseInt(normal.slice(4, 6), 16);
  const nr = Math.round(r + (255 - r) * weight);
  const ng = Math.round(g + (255 - g) * weight);
  const nb = Math.round(b + (255 - b) * weight);
  return `rgb(${nr}, ${ng}, ${nb})`;
}

function getCameraPosition() {
  const { yaw, pitch, distance, target } = state.camera;
  const horizontal = Math.cos(pitch) * distance;
  return {
    x: target.x + Math.sin(yaw) * horizontal,
    y: target.y + Math.sin(pitch) * distance,
    z: target.z + Math.cos(yaw) * horizontal,
  };
}

function subtract(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function scale(vector, amount) {
  return { x: vector.x * amount, y: vector.y * amount, z: vector.z * amount };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function normalize(vector) {
  const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function project(point) {
  const cameraPosition = getCameraPosition();
  const forward = normalize(subtract(state.camera.target, cameraPosition));
  const right = normalize(cross(forward, { x: 0, y: 1, z: 0 }));
  const up = cross(right, forward);
  const relative = subtract(point, cameraPosition);
  const x = dot(relative, right);
  const y = dot(relative, up);
  const z = dot(relative, forward);
  if (z <= 0.1) {
    return null;
  }
  const focal = Math.min(state.viewport.width, state.viewport.height) * 0.92;
  const frameY = state.viewport.height * 0.58;
  return {
    x: state.viewport.width / 2 + (x * focal) / z,
    y: frameY - (y * focal) / z,
    depth: z,
  };
}

function boxCorners(box) {
  const x0 = box.x - box.width / 2;
  const x1 = box.x + box.width / 2;
  const z0 = box.z - box.depth / 2;
  const z1 = box.z + box.depth / 2;
  const y0 = box.y;
  const y1 = box.y + box.height;
  return [
    { x: x0, y: y0, z: z0 },
    { x: x1, y: y0, z: z0 },
    { x: x1, y: y1, z: z0 },
    { x: x0, y: y1, z: z0 },
    { x: x0, y: y0, z: z1 },
    { x: x1, y: y0, z: z1 },
    { x: x1, y: y1, z: z1 },
    { x: x0, y: y1, z: z1 },
  ];
}

function boxFaces(corners) {
  return [
    [0, 1, 2, 3],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ].map((indices) => indices.map((index) => corners[index]));
}

function averageDepth(points) {
  return points.reduce((sum, point) => sum + point.depth, 0) / points.length;
}

function drawPolygon(points, fillStyle, strokeStyle) {
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index += 1) {
    context.lineTo(points[index].x, points[index].y);
  }
  context.closePath();
  context.fillStyle = fillStyle;
  context.fill();
  if (strokeStyle) {
    context.strokeStyle = strokeStyle;
    context.lineWidth = 1;
    context.stroke();
  }
}

function drawBox(box, palette) {
  const corners = boxCorners(box);
  const faces = boxFaces(corners)
    .map((face) => face.map(project))
    .filter((face) => face.every(Boolean))
    .sort((a, b) => averageDepth(b) - averageDepth(a));

  for (let index = 0; index < faces.length; index += 1) {
    const faceAlpha = box.alpha ?? (index < 2 ? 0.88 : 0.55);
    const alpha = index < 2 ? faceAlpha : Math.max(0.14, faceAlpha - 0.2);
    drawPolygon(faces[index], hexToRgba(palette.fill, alpha), palette.stroke);
  }
}

function buildingBoxes() {
  const architecture = state.sceneData.architecture || [];
  const modeFiltered = architecture.filter((box) => isBoxVisibleInMode(box, state.viewMode));
  if (state.floorFilter === "all") {
    return modeFiltered;
  }
  const selectedLevel = Number(state.floorFilter);
  return modeFiltered.filter((box) => {
    if (box.level === undefined) return true;
    if (
      box.kind === "site-plinth" ||
      box.kind === "roof-slab" ||
      box.kind.startsWith("parapet") ||
      box.kind.startsWith("roof-") ||
      box.kind.startsWith("solar")
    ) {
      return true;
    }
    return Number(box.level) === selectedLevel;
  });
}

function isBoxVisibleInMode(box, mode) {
  if (mode === "outside") {
    return !["room", "furniture", "partition-wall", "device"].includes(box.kind) &&
      box.material !== "cutaway-facade";
  }
  if (mode === "inside") {
    if (
      ["site", "site-detail", "landscape", "roof", "roof-equipment", "solar"].includes(
        box.material
      )
    ) {
      return false;
    }
    if (
      ["facade-solid", "glazing", "trim", "balcony", "railing", "cutaway-facade"].includes(
        box.material
      )
    ) {
      return false;
    }
    return true;
  }
  return true;
}

function drawGrid() {
  const extent = 24;
  context.strokeStyle = "rgba(90, 96, 91, 0.11)";
  context.lineWidth = 1;
  for (let value = -extent; value <= extent; value += 2) {
    drawLine({ x: value, y: 0, z: -extent }, { x: value, y: 0, z: extent });
    drawLine({ x: -extent, y: 0, z: value }, { x: extent, y: 0, z: value });
  }
}

function drawLine(start, end) {
  const a = project(start);
  const b = project(end);
  if (!a || !b) return;
  context.beginPath();
  context.moveTo(a.x, a.y);
  context.lineTo(b.x, b.y);
  context.stroke();
}

function drawLabel(point, text, fill, color) {
  const projected = project(point);
  if (!projected) return;
  context.font = "600 12px Avenir Next, Segoe UI, sans-serif";
  const width = context.measureText(text).width + 18;
  const height = 26;
  context.fillStyle = fill;
  drawRoundedRect(projected.x - width / 2, projected.y - 40, width, height, 12, fill);
  context.fillStyle = color;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, projected.x, projected.y - 27);
}

function drawRoundedRect(x, y, width, height, radius, fill) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
  context.fillStyle = fill;
  context.fill();
}

function drawScene() {
  context.clearRect(0, 0, state.viewport.width, state.viewport.height);
  context.fillStyle = "#f1ebe0";
  context.fillRect(0, 0, state.viewport.width, state.viewport.height);

  const gradient = context.createRadialGradient(
    state.viewport.width * 0.5,
    state.viewport.height * 0.3,
    20,
    state.viewport.width * 0.5,
    state.viewport.height * 0.5,
    state.viewport.width * 0.7
  );
  gradient.addColorStop(0, "rgba(212, 166, 79, 0.18)");
  gradient.addColorStop(1, "rgba(241, 235, 224, 0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, state.viewport.width, state.viewport.height);

  drawGrid();
  if (state.viewMode !== "inside") {
    drawBuildingShadow();
  }

  const boxes = buildingBoxes()
    .map((box) => {
      const centerProjection = project({
        x: box.x,
        y: box.y + box.height / 2,
        z: box.z,
      });
      return { ...box, depth: centerProjection ? centerProjection.depth : -1 };
    })
    .filter((box) => box.depth > 0)
    .sort((a, b) => b.depth - a.depth);

  for (const box of boxes) {
    const selected =
      state.selected &&
      state.selected.kind === "room" &&
      state.selected.data.id === box.roomId;
    drawBox(box, {
      fill: selected ? "#d4a64f" : box.fill,
      stroke: selected ? "rgba(107, 67, 0, 0.65)" : "rgba(16, 32, 25, 0.18)",
    });
  }

  state.projectedWaypoints = [];
  for (const waypoint of state.sceneData.waypoints) {
    const projected = project({
      x: waypoint.target.x,
      y: 0.12,
      z: waypoint.target.z,
    });
    if (!projected) continue;
    state.projectedWaypoints.push({ waypoint, projected });
    context.beginPath();
    context.arc(projected.x, projected.y, state.selectedWaypointId === waypoint.id ? 11 : 8, 0, Math.PI * 2);
    context.fillStyle = state.selectedWaypointId === waypoint.id ? "#d4a64f" : "#0b5b44";
    context.fill();
  }

  state.projectedHotspots = [];
  for (const device of state.sceneData.devices) {
    const projected = project(device.position);
    if (!projected) continue;
    state.projectedHotspots.push({ device, projected });
    const radius = device.type === "lift" ? 10 : 8;
    context.beginPath();
    context.arc(projected.x, projected.y, radius, 0, Math.PI * 2);
    context.fillStyle = hotspotColor(device);
    context.fill();
    context.strokeStyle = "rgba(255,255,255,0.94)";
    context.lineWidth = 2;
    context.stroke();
    if (
      state.selected &&
      state.selected.kind === "device" &&
      state.selected.data.id === device.id
    ) {
      drawLabel(
        add(device.position, { x: 0, y: 0.3, z: 0 }),
        device.label,
        "rgba(11, 91, 68, 0.92)",
        "#ffffff"
      );
    }
  }

  context.fillStyle = "rgba(11, 91, 68, 0.12)";
  context.fillRect(18, state.viewport.height - 52, 210, 34);
  context.fillStyle = "#0b5b44";
  context.font = "600 13px Avenir Next, Segoe UI, sans-serif";
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillText(
    "Drag to orbit • wheel to zoom • click a hotspot",
    32,
    state.viewport.height - 35
  );
}

function hotspotColor(device) {
  if (device.type === "light") {
    return device.state.power ? "#ffd166" : "#70858f";
  }
  if (device.type === "door") {
    return device.state.locked ? "#d95c5c" : "#1b8a5b";
  }
  if (device.type === "camera") {
    return device.state.recording ? "#45a3ff" : "#8a96a4";
  }
  return device.state.mode === "service" ? "#d4a64f" : "#5b78ff";
}

function drawBuildingShadow() {
  const shadowPoints = [
    project({ x: -14.5, y: 0.02, z: -11.5 }),
    project({ x: 14.5, y: 0.02, z: -11.5 }),
    project({ x: 16.5, y: 0.02, z: 13.5 }),
    project({ x: -16.5, y: 0.02, z: 13.5 }),
  ].filter(Boolean);
  if (shadowPoints.length !== 4) return;
  drawPolygon(shadowPoints, "rgba(16, 24, 20, 0.12)");
}

function computeBounds(boxes) {
  const bounds = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
  };
  for (const box of boxes) {
    bounds.minX = Math.min(bounds.minX, box.x - box.width / 2);
    bounds.maxX = Math.max(bounds.maxX, box.x + box.width / 2);
    bounds.minY = Math.min(bounds.minY, box.y);
    bounds.maxY = Math.max(bounds.maxY, box.y + box.height);
    bounds.minZ = Math.min(bounds.minZ, box.z - box.depth / 2);
    bounds.maxZ = Math.max(bounds.maxZ, box.z + box.depth / 2);
  }
  return bounds;
}

function fitCameraToBuilding(preserveAngles = true) {
  if (!state.sceneData) return;
  const boxes = buildingBoxes();
  if (!boxes.length) return;
  const bounds = computeBounds(boxes);
  const center = {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
    z: (bounds.minZ + bounds.maxZ) / 2,
  };
  const spanX = bounds.maxX - bounds.minX;
  const spanY = bounds.maxY - bounds.minY;
  const spanZ = bounds.maxZ - bounds.minZ;
  const aspect = Math.max(1, state.viewport.width / Math.max(state.viewport.height, 1));
  if (!preserveAngles) {
    if (state.viewMode === "inside") {
      state.camera.yaw = Math.PI;
      state.camera.pitch = 0.18;
    } else {
      state.camera.yaw = Math.PI;
      state.camera.pitch = state.viewMode === "outside" ? 0.36 : 0.43;
    }
  }
  state.camera.target = {
    x: center.x,
    y: center.y + Math.max(0.35, spanY * (state.viewMode === "inside" ? 0.02 : 0.05)),
    z: center.z,
  };
  const footprint = Math.max(spanX, spanZ * 1.08);
  const fitDistance =
    footprint * (aspect > 1.15 ? 1.02 : 1.2) +
    spanY * (state.viewMode === "inside" ? 0.72 : 1.2) +
    (state.viewMode === "inside" ? 2.5 : 8);
  state.camera.distance = clamp(fitDistance, 14, 90);
  requestDraw();
}

function renderWaypoints() {
  clearChildren(ui.waypoints);
  for (const waypoint of state.sceneData.waypoints) {
    const button = document.createElement("button");
    button.className = "waypoint-btn";
    button.dataset.id = waypoint.id;
    button.innerHTML = `<strong>${waypoint.label}</strong><span>Move camera to the ${waypoint.label.toLowerCase()} viewpoint.</span>`;
    button.addEventListener("click", () => {
      focusWaypoint(waypoint.id);
      selectEntity({ kind: "waypoint", data: waypoint });
    });
    ui.waypoints.appendChild(button);
  }
}

function renderDevices() {
  clearChildren(ui.devices);
  for (const device of state.sceneData.devices) {
    const button = document.createElement("button");
    button.className = "device-btn";
    button.dataset.id = device.id;
    button.innerHTML = `<strong>${device.label}</strong><span>${deviceSummary(device)}</span>`;
    button.addEventListener("click", () => {
      focusDevice(device);
      selectEntity({ kind: "device", data: device });
    });
    ui.devices.appendChild(button);
  }
}

function renderConnectors() {
  clearChildren(ui.connectors);
  for (const connector of state.sceneData.edge.connectors) {
    const item = document.createElement("div");
    item.className = "connector-item";
    item.innerHTML = `<strong>${connector.label}<span class="status ${connector.status}">${connector.status}</span></strong><span>Mapped to the ${state.sceneData.edge.transport} for staged device handoff.</span>`;
    ui.connectors.appendChild(item);
  }
}

function setSelectedWaypoint(id) {
  state.selectedWaypointId = id;
  for (const button of ui.waypoints.querySelectorAll("button")) {
    button.classList.toggle("active", button.dataset.id === id);
  }
}

function focusWaypoint(id) {
  const waypoint = state.sceneData.waypoints.find((item) => item.id === id);
  if (!waypoint) return;
  setSelectedWaypoint(id);
  state.camera.target = { ...waypoint.target };
  const offset = subtract(waypoint.position, waypoint.target);
  state.camera.distance = Math.hypot(offset.x, offset.y, offset.z);
  const horizontal = Math.max(Math.hypot(offset.x, offset.z), 0.001);
  state.camera.pitch = clamp(Math.atan2(offset.y, horizontal), -0.15, 1.1);
  state.camera.yaw = Math.atan2(offset.x, offset.z);
  state.autoFitMode = id === "roof";
  if (state.autoFitMode) {
    fitCameraToBuilding(true);
    return;
  }
  requestDraw();
}

function focusDevice(device) {
  setSelectedWaypoint(null);
  const focus = device.focus;
  const offset = subtract(focus.position, focus.target);
  state.camera.target = { ...focus.target };
  state.camera.distance = Math.hypot(offset.x, offset.y, offset.z);
  const horizontal = Math.max(Math.hypot(offset.x, offset.z), 0.001);
  state.camera.pitch = clamp(Math.atan2(offset.y, horizontal), -0.15, 1.1);
  state.camera.yaw = Math.atan2(offset.x, offset.z);
  state.autoFitMode = false;
  requestDraw();
}

function selectEntity(selection) {
  state.selected = selection;
  clearChildren(ui.selectionMeta);
  clearChildren(ui.selectionActions);

  for (const button of ui.devices.querySelectorAll("button")) {
    button.classList.toggle(
      "active",
      selection.kind === "device" && button.dataset.id === selection.data.id
    );
  }

  if (selection.kind === "waypoint") {
    ui.selectionTitle.textContent = `${selection.data.label} Waypoint`;
    ui.selectionBadge.textContent = "camera";
    ui.selectionCopy.textContent =
      "Stored camera pose for flythroughs, inside/outside transitions, and scripted twin navigation.";
    appendMetaPill(`x ${selection.data.position.x}`);
    appendMetaPill(`y ${selection.data.position.y}`);
    appendMetaPill(`z ${selection.data.position.z}`);
    requestDraw();
    return;
  }

  if (selection.kind === "room") {
    ui.selectionTitle.textContent = selection.data.label;
    ui.selectionBadge.textContent = selection.data.type;
    ui.selectionCopy.textContent =
      "This is a spatial zone from the structured geometry redraw. It can anchor automation groups, telemetry overlays, and room-level state.";
    appendMetaPill(`${selection.data.width}m x ${selection.data.depth}m`);
    appendMetaPill(`height ${selection.data.height}m`);
    requestDraw();
    return;
  }

  const device = selection.data;
  ui.selectionTitle.textContent = device.label;
  ui.selectionBadge.textContent = `${device.type} • ${device.integration.source}`;
  ui.selectionCopy.textContent =
    "This control point already updates the mock building state. The same action contract can route through the edge layer to live devices later.";
  appendMetaPill(deviceSummary(device));
  appendMetaPill(device.integration.online ? "edge linked" : "mock only");
  appendMetaPill(`room ${device.roomId}`);

  for (const action of device.actions) {
    const button = document.createElement("button");
    button.className = "action-btn";
    button.textContent = actionLabel(action);
    if (action.includes("dim") || action.includes("normal")) {
      button.classList.add("secondary");
    }
    button.addEventListener("click", () => runDeviceAction(device.id, action));
    ui.selectionActions.appendChild(button);
  }
  requestDraw();
}

async function runDeviceAction(deviceId, action) {
  const response = await fetch("/api/digital-twin/device-action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: deviceId, action }),
  });
  const payload = await response.json();
  if (!response.ok) {
    window.alert(payload.error || "Action failed");
    return;
  }
  const index = state.sceneData.devices.findIndex((item) => item.id === deviceId);
  state.sceneData.devices[index] = payload.device;
  renderDevices();
  selectEntity({ kind: "device", data: payload.device });
}

async function syncEdge() {
  const response = await fetch("/api/digital-twin/edge-sync", { method: "POST" });
  const payload = await response.json();
  if (!response.ok) {
    window.alert(payload.error || "Sync failed");
    return;
  }
  await loadScene();
  ui.syncStamp.textContent = `Last sync: ${new Date(payload.edge.last_sync_at).toLocaleString()}`;
}

function onPointerDown(event) {
  state.drag = {
    x: event.clientX,
    y: event.clientY,
    moved: false,
  };
}

function onPointerMove(event) {
  if (!state.drag) return;
  const deltaX = event.clientX - state.drag.x;
  const deltaY = event.clientY - state.drag.y;
  if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) {
    state.drag.moved = true;
  }
  state.drag.x = event.clientX;
  state.drag.y = event.clientY;
  state.camera.yaw -= deltaX * 0.008;
  state.camera.pitch = clamp(state.camera.pitch + deltaY * 0.006, -0.15, 1.25);
  state.autoFitMode = false;
  requestDraw();
}

function pickProjected(event) {
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * (canvas.width / rect.width);
  const y = (event.clientY - rect.top) * (canvas.height / rect.height);

  for (const hotspot of state.projectedHotspots) {
    const distance = Math.hypot(hotspot.projected.x - x, hotspot.projected.y - y);
    if (distance <= 14) {
      focusDevice(hotspot.device);
      selectEntity({ kind: "device", data: hotspot.device });
      return;
    }
  }

  for (const marker of state.projectedWaypoints) {
    const distance = Math.hypot(marker.projected.x - x, marker.projected.y - y);
    if (distance <= 14) {
      focusWaypoint(marker.waypoint.id);
      selectEntity({ kind: "waypoint", data: marker.waypoint });
      return;
    }
  }

  const room = pickRoomByProjection(x, y);
  if (room) {
    selectEntity({ kind: "room", data: room });
  }
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
    const xi = polygon[current].x;
    const yi = polygon[current].y;
    const xj = polygon[previous].x;
    const yj = polygon[previous].y;
    const intersect =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi + 0.000001) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pickRoomByProjection(x, y) {
  const candidates = [];
  for (const room of state.sceneData.rooms) {
    const polygon = [
      project({ x: room.x - room.width / 2, y: 0.04, z: room.z - room.depth / 2 }),
      project({ x: room.x + room.width / 2, y: 0.04, z: room.z - room.depth / 2 }),
      project({ x: room.x + room.width / 2, y: 0.04, z: room.z + room.depth / 2 }),
      project({ x: room.x - room.width / 2, y: 0.04, z: room.z + room.depth / 2 }),
    ];
    if (polygon.every(Boolean) && pointInPolygon({ x, y }, polygon)) {
      const center = project({ x: room.x, y: 1.2, z: room.z });
      candidates.push({ room, depth: center ? center.depth : 0 });
    }
  }
  candidates.sort((a, b) => a.depth - b.depth);
  return candidates[0] ? candidates[0].room : null;
}

function onPointerUp(event) {
  if (!state.drag) return;
  const wasClick = !state.drag.moved;
  state.drag = null;
  if (wasClick) {
    pickProjected(event);
  }
}

function onWheel(event) {
  event.preventDefault();
  state.camera.distance = clamp(state.camera.distance + event.deltaY * 0.02, 8, 70);
  state.autoFitMode = false;
  requestDraw();
}

function resize() {
  const rect = ui.root.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  state.viewport.width = Math.max(1, Math.floor(rect.width));
  state.viewport.height = Math.max(1, Math.floor(rect.height));
  state.viewport.ratio = ratio;
  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  if (state.sceneData && state.autoFitMode) {
    fitCameraToBuilding(true);
  }
  requestDraw();
}

function requestDraw() {
  if (state.frame) return;
  state.frame = window.requestAnimationFrame(() => {
    state.frame = 0;
    drawScene();
  });
}

async function loadScene() {
  const response = await fetch("/api/digital-twin/scene");
  state.sceneData = await response.json();
  ui.metricRooms.textContent = String(state.sceneData.rooms.length);
  ui.metricDevices.textContent = String(state.sceneData.devices.length);
  ui.metricFootprint.textContent = `${state.sceneData.meta.footprint.width}m x ${state.sceneData.meta.footprint.depth}m • ${state.sceneData.meta.storeys} floors`;
  ui.metricEdge.textContent = state.sceneData.edge.status;
  ui.syncStamp.textContent = state.sceneData.edge.last_sync_at
    ? `Last sync: ${new Date(state.sceneData.edge.last_sync_at).toLocaleString()}`
    : "Last sync: not connected";
  renderDevices();
  renderConnectors();
  renderFloorButtons();
  renderModeButtons();
  if (!ui.waypoints.childElementCount) {
    renderWaypoints();
  }
  requestDraw();
}

function renderFloorButtons() {
  for (const button of ui.floorButtons) {
    button.classList.toggle("active", button.dataset.floor === state.floorFilter);
  }
}

function renderModeButtons() {
  for (const button of ui.modeButtons) {
    button.classList.toggle("active", button.dataset.mode === state.viewMode);
  }
}

function setFloorFilter(value) {
  state.floorFilter = value;
  renderFloorButtons();
  fitCameraToBuilding(true);
}

function setViewMode(value) {
  state.viewMode = value;
  renderModeButtons();
  if (value === "inside" && state.floorFilter === "all") {
    state.floorFilter = "0";
    renderFloorButtons();
  }
  fitCameraToBuilding(false);
}

async function init() {
  canvas.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("resize", resize);
  ui.syncEdge.addEventListener("click", syncEdge);
  ui.fitView.addEventListener("click", () => {
    state.autoFitMode = true;
    setSelectedWaypoint("roof");
    fitCameraToBuilding(false);
    selectEntity({ kind: "waypoint", data: state.sceneData.waypoints.find((item) => item.id === "roof") });
  });
  for (const button of ui.modeButtons) {
    button.addEventListener("click", () => {
      state.autoFitMode = true;
      setViewMode(button.dataset.mode);
    });
  }
  for (const button of ui.floorButtons) {
    button.addEventListener("click", () => {
      state.autoFitMode = true;
      setFloorFilter(button.dataset.floor);
    });
  }

  await loadScene();
  resize();
  renderModeButtons();
  setFloorFilter("all");
  focusWaypoint("roof");
  selectEntity({ kind: "waypoint", data: state.sceneData.waypoints.find((item) => item.id === "roof") });
}

init().catch((error) => {
  console.error(error);
  ui.selectionTitle.textContent = "Prototype failed to load";
  ui.selectionCopy.textContent = String(error?.message || error);
});
