function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createDeviceState(device) {
  switch (device.type) {
    case "light":
      return {
        power: device.id === "light-lobby" ? true : false,
        level: device.id === "light-lobby" ? 85 : 0,
      };
    case "door":
      return {
        locked: true,
        open: false,
      };
    case "camera":
      return {
        online: true,
        recording: true,
      };
    case "lift":
      return {
        floor: 1,
        direction: "idle",
        mode: "normal",
      };
    default:
      return {};
  }
}

function buildSceneDefinition() {
  return {
    meta: {
      name: "Twin Demo Building",
      units: "meters",
      footprint: {
        width: 24,
        depth: 20,
        height: 3.4,
      },
      storeys: 4,
      floor_to_floor: 3.4,
      source_note:
        "Approximate structured redraw from the supplied floor-plan image. Coordinates should be refined from CAD or verified dimensions before delivery.",
    },
    shell: {
      floorElevation: 0,
      wallHeight: 3.2,
      footprint: { x: 0, z: 0, width: 24, depth: 20 },
      podium: { x: 0, z: -1.4, width: 28, depth: 26, height: 0.28 },
      roof: { parapetHeight: 0.85, slabHeight: 0.22 },
      facade: {
        wallThickness: 0.22,
        railHeight: 1.05,
        glazingColor: "#86a8c6",
        bodyColor: "#d9d2c5",
        trimColor: "#b7ad9b",
        coreColor: "#cfc7ba",
      },
      balconies: [
        { id: "balcony-west", label: "Balcony West", x: -8.4, z: 9.7, width: 5.4, depth: 1.2 },
        { id: "balcony-east", label: "Balcony East", x: 8.4, z: 9.7, width: 5.4, depth: 1.2 },
      ],
    },
    rooms: [
      {
        id: "lobby",
        label: "Main Lobby",
        type: "shared",
        x: 0,
        z: -8.1,
        width: 4,
        depth: 2.4,
        height: 3.2,
        color: "#dfe7ef",
      },
      {
        id: "central-corridor",
        label: "Central Corridor",
        type: "shared",
        x: 0,
        z: -0.4,
        width: 13.2,
        depth: 2.8,
        height: 3.2,
        color: "#e7eadf",
      },
      {
        id: "service-core",
        label: "Lift + Service Core",
        type: "core",
        x: 0,
        z: 4.7,
        width: 4.2,
        depth: 7.4,
        height: 3.2,
        color: "#f1ead8",
      },
      {
        id: "unit-a-living",
        label: "Unit A Living / Dining",
        type: "residential",
        x: -8.5,
        z: 4.1,
        width: 5.8,
        depth: 4.2,
        height: 3.2,
        color: "#f4f0ea",
      },
      {
        id: "unit-a-suite",
        label: "Unit A Master Suite",
        type: "residential",
        x: -8.5,
        z: 8.1,
        width: 5.8,
        depth: 3.8,
        height: 3.2,
        color: "#f9f5ef",
      },
      {
        id: "unit-b-living",
        label: "Unit B Living / Dining",
        type: "residential",
        x: -8.5,
        z: -4.2,
        width: 5.8,
        depth: 3.8,
        height: 3.2,
        color: "#f4f0ea",
      },
      {
        id: "unit-b-bedroom",
        label: "Unit B Bedroom",
        type: "residential",
        x: -8.5,
        z: -7.9,
        width: 5.8,
        depth: 3.4,
        height: 3.2,
        color: "#fbf8f3",
      },
      {
        id: "unit-c-living",
        label: "Unit C Living / Dining",
        type: "residential",
        x: 8.5,
        z: 4.1,
        width: 5.8,
        depth: 4.2,
        height: 3.2,
        color: "#eef4ef",
      },
      {
        id: "unit-c-suite",
        label: "Unit C Master Suite",
        type: "residential",
        x: 8.5,
        z: 8.1,
        width: 5.8,
        depth: 3.8,
        height: 3.2,
        color: "#f4faf4",
      },
      {
        id: "unit-d-living",
        label: "Unit D Living / Dining",
        type: "residential",
        x: 8.5,
        z: -4.2,
        width: 5.8,
        depth: 3.8,
        height: 3.2,
        color: "#eef4ef",
      },
      {
        id: "unit-d-bedroom",
        label: "Unit D Bedroom",
        type: "residential",
        x: 8.5,
        z: -7.9,
        width: 5.8,
        depth: 3.4,
        height: 3.2,
        color: "#f5fbf5",
      },
    ],
    openings: [
      { id: "main-entry", type: "door", x: 0, z: -9.95, width: 1.8, height: 2.4, roomId: "lobby" },
      { id: "door-unit-a", type: "door", x: -3.2, z: 1.1, width: 1.1, height: 2.2, roomId: "unit-a-living" },
      { id: "door-unit-c", type: "door", x: 3.2, z: 1.1, width: 1.1, height: 2.2, roomId: "unit-c-living" },
      { id: "door-unit-b", type: "door", x: -3.4, z: -2.0, width: 1.1, height: 2.2, roomId: "unit-b-living" },
      { id: "door-unit-d", type: "door", x: 3.4, z: -2.0, width: 1.1, height: 2.2, roomId: "unit-d-living" },
    ],
    waypoints: [
      {
        id: "approach",
        label: "Approach",
        position: { x: 0, y: 10.5, z: -31 },
        target: { x: 0, y: 5.2, z: 0 },
      },
      {
        id: "lobby",
        label: "Lobby",
        position: { x: 0, y: 4.8, z: -12.2 },
        target: { x: 0, y: 1.2, z: -8 },
      },
      {
        id: "core",
        label: "Lift Core",
        position: { x: 4.5, y: 8, z: -2 },
        target: { x: 0, y: 4.9, z: 4.7 },
      },
      {
        id: "corridor-l2",
        label: "Level 2 Corridor",
        position: { x: 6.4, y: 8.1, z: -4.6 },
        target: { x: 0, y: 4.9, z: -0.4 },
      },
      {
        id: "unit-a",
        label: "Unit A",
        position: { x: -14.4, y: 7.8, z: -1.4 },
        target: { x: -8.5, y: 4.9, z: 5.4 },
      },
      {
        id: "unit-c",
        label: "Unit C",
        position: { x: 14.4, y: 7.8, z: -1.4 },
        target: { x: 8.5, y: 4.9, z: 5.4 },
      },
      {
        id: "inside-unit-b",
        label: "Inside Unit B",
        position: { x: -5.6, y: 2.4, z: -6.1 },
        target: { x: -8.7, y: 1.15, z: -6.1 },
      },
      {
        id: "roof",
        label: "Overview",
        position: { x: 0, y: 19.5, z: -29 },
        target: { x: 0, y: 5.5, z: 0 },
      },
    ],
    devices: [
      {
        id: "light-lobby",
        label: "Lobby Lighting",
        type: "light",
        roomId: "lobby",
        position: { x: 0, y: 1.4, z: -8.3 },
        focus: {
          position: { x: 1.6, y: 2.1, z: -10.7 },
          target: { x: 0, y: 1.4, z: -8.3 },
        },
        actions: ["toggle-power", "dim-up", "dim-down"],
      },
      {
        id: "light-corridor-west",
        label: "West Corridor Light",
        type: "light",
        roomId: "central-corridor",
        position: { x: -4.8, y: 1.4, z: -0.4 },
        focus: {
          position: { x: -7.6, y: 2.1, z: -3.2 },
          target: { x: -4.8, y: 1.4, z: -0.4 },
        },
        actions: ["toggle-power", "dim-up", "dim-down"],
      },
      {
        id: "light-corridor-east",
        label: "East Corridor Light",
        type: "light",
        roomId: "central-corridor",
        position: { x: 4.8, y: 1.4, z: -0.4 },
        focus: {
          position: { x: 7.6, y: 2.1, z: -3.2 },
          target: { x: 4.8, y: 1.4, z: -0.4 },
        },
        actions: ["toggle-power", "dim-up", "dim-down"],
      },
      {
        id: "door-main",
        label: "Main Entry Access",
        type: "door",
        roomId: "lobby",
        position: { x: 0, y: 1.2, z: -9.7 },
        focus: {
          position: { x: 0, y: 2.2, z: -13.5 },
          target: { x: 0, y: 1.1, z: -9.7 },
        },
        actions: ["lock", "unlock", "pulse-open"],
      },
      {
        id: "door-unit-a",
        label: "Unit A Access",
        type: "door",
        roomId: "unit-a-living",
        position: { x: -3.2, y: 1.2, z: 1.1 },
        focus: {
          position: { x: -6.5, y: 2.1, z: -1.2 },
          target: { x: -3.2, y: 1.1, z: 1.1 },
        },
        actions: ["lock", "unlock", "pulse-open"],
      },
      {
        id: "door-unit-c",
        label: "Unit C Access",
        type: "door",
        roomId: "unit-c-living",
        position: { x: 3.2, y: 1.2, z: 1.1 },
        focus: {
          position: { x: 6.5, y: 2.1, z: -1.2 },
          target: { x: 3.2, y: 1.1, z: 1.1 },
        },
        actions: ["lock", "unlock", "pulse-open"],
      },
      {
        id: "camera-entry",
        label: "Entry Camera",
        type: "camera",
        roomId: "lobby",
        position: { x: 0, y: 2.8, z: -9.2 },
        focus: {
          position: { x: 3.5, y: 2.6, z: -12.8 },
          target: { x: 0, y: 2.6, z: -9.2 },
        },
        actions: ["toggle-recording", "snapshot"],
      },
      {
        id: "camera-core",
        label: "Core Camera",
        type: "camera",
        roomId: "service-core",
        position: { x: 0, y: 2.8, z: 2.8 },
        focus: {
          position: { x: -3.4, y: 2.8, z: 0.5 },
          target: { x: 0, y: 2.6, z: 2.8 },
        },
        actions: ["toggle-recording", "snapshot"],
      },
      {
        id: "lift-core",
        label: "Passenger Lift",
        type: "lift",
        roomId: "service-core",
        position: { x: 0, y: 0.8, z: 5 },
        focus: {
          position: { x: 3.8, y: 2.3, z: 3.4 },
          target: { x: 0, y: 1.1, z: 5 },
        },
        actions: ["call-lift", "set-service-mode", "set-normal-mode"],
      },
    ],
    edge: {
      nodeId: "edge-agent-demo-01",
      transport: "mocked edge runtime",
      status: "staged",
      connectors: [
        { id: "lighting", label: "Lighting Bus", status: "mocked" },
        { id: "access", label: "Access Control", status: "mocked" },
        { id: "surveillance", label: "CCTV / Video", status: "mocked" },
        { id: "lift", label: "Lift Interface", status: "mocked" },
      ],
    },
  };
}

function pushBox(target, box) {
  target.push(box);
}

function buildArchitecturalBoxes(scene, options = {}) {
  const includeDevices = options.includeDevices !== false;
  const boxes = [];
  const storeys = Number(scene.meta.storeys || 1);
  const floorToFloor = Number(scene.meta.floor_to_floor || 3.4);
  const facade = scene.shell.facade || {};
  const roof = scene.shell.roof || {};
  const wallThickness = Number(facade.wallThickness || 0.2);
  const floorInset = 0.18;
  const floorPlate = {
    x: scene.shell.footprint.x || 0,
    z: scene.shell.footprint.z || 0,
    width: scene.shell.footprint.width,
    depth: scene.shell.footprint.depth,
  };

  pushBox(boxes, {
    kind: "site-plinth",
    material: "site",
    fill: "#d8d0c1",
    alpha: 0.98,
    x: scene.shell.podium?.x || 0,
    y: -0.28,
    z: scene.shell.podium?.z || 0,
    width: scene.shell.podium?.width || 28,
    depth: scene.shell.podium?.depth || 26,
    height: scene.shell.podium?.height || 0.28,
  });
  pushBox(boxes, {
    kind: "forecourt",
    material: "forecourt",
    fill: "#b9b8ae",
    alpha: 0.95,
    x: 0,
    y: -0.02,
    z: -10.8,
    width: 22,
    depth: 5,
    height: 0.03,
  });
  pushBox(boxes, {
    kind: "entry-steps",
    material: "site-detail",
    fill: "#c4bbad",
    alpha: 0.98,
    x: 0,
    y: -0.01,
    z: -11.95,
    width: 5.8,
    depth: 1.8,
    height: 0.16,
  });
  pushBox(boxes, {
    kind: "entry-landing",
    material: "site-detail",
    fill: "#d9d1c4",
    alpha: 0.98,
    x: 0,
    y: 0.14,
    z: -10.95,
    width: 4.6,
    depth: 1.3,
    height: 0.08,
  });
  pushBox(boxes, {
    kind: "planter-west",
    material: "landscape",
    fill: "#8ea36e",
    alpha: 0.98,
    x: -8.7,
    y: 0,
    z: -11.2,
    width: 4.4,
    depth: 1.5,
    height: 0.42,
  });
  pushBox(boxes, {
    kind: "planter-east",
    material: "landscape",
    fill: "#8ea36e",
    alpha: 0.98,
    x: 8.7,
    y: 0,
    z: -11.2,
    width: 4.4,
    depth: 1.5,
    height: 0.42,
  });
  pushBox(boxes, {
    kind: "drive-lane",
    material: "site-detail",
    fill: "#8f918c",
    alpha: 0.92,
    x: 0,
    y: -0.03,
    z: -15,
    width: 30,
    depth: 5.8,
    height: 0.02,
  });
  pushBox(boxes, {
    kind: "landscape-strip",
    material: "landscape",
    fill: "#8ba06b",
    alpha: 0.98,
    x: 0,
    y: 0,
    z: 12.1,
    width: 25.5,
    depth: 2.4,
    height: 0.04,
  });

  for (let level = 0; level < storeys; level += 1) {
    const yBase = level * floorToFloor;
    const slabTop = yBase + 0.2;
    const clearHeight = 2.85;

    pushBox(boxes, {
      kind: "slab",
      level,
      material: "slab",
      fill: "#e9e3d8",
      alpha: 0.98,
      x: floorPlate.x,
      y: yBase,
      z: floorPlate.z,
      width: floorPlate.width,
      depth: floorPlate.depth,
      height: 0.2,
    });

    pushBox(boxes, {
      kind: "north-wall",
      level,
      material: "facade-solid",
      fill: facade.bodyColor || "#d9d2c5",
      alpha: 0.96,
      x: 0,
      y: slabTop,
      z: -10 + wallThickness / 2,
      width: 24,
      depth: wallThickness,
      height: clearHeight,
    });
    pushBox(boxes, {
      kind: "west-wall",
      level,
      material: "facade-solid",
      fill: facade.bodyColor || "#d9d2c5",
      alpha: 0.9,
      x: -12 + wallThickness / 2,
      y: slabTop,
      z: 0,
      width: wallThickness,
      depth: 20,
      height: clearHeight,
    });
    pushBox(boxes, {
      kind: "east-wall",
      level,
      material: "facade-solid",
      fill: facade.bodyColor || "#d9d2c5",
      alpha: 0.9,
      x: 12 - wallThickness / 2,
      y: slabTop,
      z: 0,
      width: wallThickness,
      depth: 20,
      height: clearHeight,
    });

    const southOpacity = level === 0 ? 0.16 : 0.42;
    pushBox(boxes, {
      kind: "south-left",
      level,
      material: "cutaway-facade",
      fill: facade.bodyColor || "#d9d2c5",
      alpha: southOpacity,
      x: -7.2,
      y: slabTop,
      z: 10 - wallThickness / 2,
      width: 9.2,
      depth: wallThickness,
      height: clearHeight,
    });
    pushBox(boxes, {
      kind: "south-right",
      level,
      material: "cutaway-facade",
      fill: facade.bodyColor || "#d9d2c5",
      alpha: southOpacity,
      x: 7.2,
      y: slabTop,
      z: 10 - wallThickness / 2,
      width: 9.2,
      depth: wallThickness,
      height: clearHeight,
    });

    pushBox(boxes, {
      kind: "core-mass",
      level,
      material: "core",
      fill: facade.coreColor || "#cfc7ba",
      alpha: 0.94,
      x: 0,
      y: slabTop,
      z: 4.7,
      width: 4.2,
      depth: 7.4,
      height: clearHeight,
    });

    const partitionHeight = 2.6;
    const partitionSegments = [
      { x: -6.1, z: -0.4, width: 0.14, depth: 12.4 },
      { x: 6.1, z: -0.4, width: 0.14, depth: 12.4 },
      { x: -0.78, z: 4.7, width: 0.14, depth: 7.0 },
      { x: 0.78, z: 4.7, width: 0.14, depth: 7.0 },
      { x: -8.5, z: 6.15, width: 5.3, depth: 0.14 },
      { x: 8.5, z: 6.15, width: 5.3, depth: 0.14 },
      { x: -8.5, z: -6.0, width: 5.4, depth: 0.14 },
      { x: 8.5, z: -6.0, width: 5.4, depth: 0.14 },
      { x: -10.2, z: -3.45, width: 0.14, depth: 2.1 },
      { x: 10.2, z: -3.45, width: 0.14, depth: 2.1 },
      { x: -6.9, z: 0.4, width: 0.14, depth: 2.3 },
      { x: 6.9, z: 0.4, width: 0.14, depth: 2.3 },
    ];
    for (const segment of partitionSegments) {
      pushBox(boxes, {
        kind: "partition-wall",
        level,
        material: "partition-wall",
        fill: "#f3eee6",
        alpha: 0.9,
        x: segment.x,
        y: slabTop,
        z: segment.z,
        width: segment.width,
        depth: segment.depth,
        height: partitionHeight,
      });
    }

    for (const room of scene.rooms) {
      pushBox(boxes, {
        kind: "room",
        level,
        roomId: room.id,
        material: room.type === "core" ? "core-room" : "interior",
        x: room.x,
        y: slabTop,
        z: room.z,
        width: room.width - floorInset,
        depth: room.depth - floorInset,
        height: room.type === "core" ? 2.7 : 1.95,
        fill: room.color,
        alpha: room.type === "core" ? 0.72 : 0.56,
      });
    }

    const furnishingBaseY = slabTop + 0.02;
    const furnishingSets = [
      { kind: "sofa-west", x: -9.6, z: 4.9, width: 2.1, depth: 0.9, height: 0.82, fill: "#d8cec0" },
      { kind: "table-west", x: -7.4, z: 4.3, width: 1.1, depth: 0.7, height: 0.48, fill: "#9b7f63" },
      { kind: "bed-west-top", x: -8.4, z: 8.2, width: 2.2, depth: 1.8, height: 0.62, fill: "#e7e0d8" },
      { kind: "wardrobe-west-top", x: -10.5, z: 8.55, width: 0.7, depth: 1.8, height: 1.55, fill: "#b1a18c" },
      { kind: "bath-west-top", x: -6.8, z: 8.15, width: 0.9, depth: 1.45, height: 0.55, fill: "#d7e0e6" },
      { kind: "kitchen-west", x: -10.3, z: -3.9, width: 2.4, depth: 0.72, height: 0.9, fill: "#b8b4ab" },
      { kind: "bed-west-bottom", x: -8.8, z: -7.9, width: 2.1, depth: 1.7, height: 0.6, fill: "#e9e2d9" },
      { kind: "bath-west-bottom", x: -6.95, z: -3.6, width: 0.9, depth: 1.4, height: 0.55, fill: "#d5dde3" },
      { kind: "sofa-east", x: 9.6, z: 4.9, width: 2.1, depth: 0.9, height: 0.82, fill: "#ccd7d0" },
      { kind: "table-east", x: 7.4, z: 4.3, width: 1.1, depth: 0.7, height: 0.48, fill: "#8f7963" },
      { kind: "bed-east-top", x: 8.4, z: 8.2, width: 2.2, depth: 1.8, height: 0.62, fill: "#e8eee7" },
      { kind: "wardrobe-east-top", x: 10.5, z: 8.55, width: 0.7, depth: 1.8, height: 1.55, fill: "#98a79b" },
      { kind: "bath-east-top", x: 6.8, z: 8.15, width: 0.9, depth: 1.45, height: 0.55, fill: "#d9e7ea" },
      { kind: "kitchen-east", x: 10.3, z: -3.9, width: 2.4, depth: 0.72, height: 0.9, fill: "#adb7af" },
      { kind: "bed-east-bottom", x: 8.8, z: -7.9, width: 2.1, depth: 1.7, height: 0.6, fill: "#edf2ee" },
      { kind: "bath-east-bottom", x: 6.95, z: -3.6, width: 0.9, depth: 1.4, height: 0.55, fill: "#d8e3e7" },
      { kind: "lift-car", x: 0, z: 5.35, width: 1.35, depth: 1.45, height: 2.35, fill: "#c5c8cd" },
    ];
    for (const furnishing of furnishingSets) {
      pushBox(boxes, {
        kind: "furniture",
        level,
        material: "furniture",
        alpha: 0.92,
        y: furnishingBaseY,
        ...furnishing,
      });
    }

    for (const balcony of scene.shell.balconies) {
      pushBox(boxes, {
        kind: "balcony-slab",
        level,
        material: "balcony",
        fill: "#dfe6ec",
        alpha: 0.96,
        x: balcony.x,
        y: yBase + 0.05,
        z: balcony.z,
        width: balcony.width,
        depth: balcony.depth,
        height: 0.1,
      });
      pushBox(boxes, {
        kind: "balcony-rail",
        level,
        material: "railing",
        fill: facade.glazingColor || "#86a8c6",
        alpha: 0.36,
        x: balcony.x,
        y: slabTop + 0.2,
        z: balcony.z + balcony.depth / 2 - 0.06,
        width: balcony.width,
        depth: 0.08,
        height: facade.railHeight || 1.05,
      });
    }

    const windowY = slabTop + 0.8;
    const windowHeight = 1.45;
    const northWindowDepth = 0.08;
    const northZ = -9.86;
    for (const windowX of [-8.4, -3.1, 3.1, 8.4]) {
      pushBox(boxes, {
        kind: "window-north",
        level,
        material: "glazing",
        fill: facade.glazingColor || "#86a8c6",
        alpha: 0.38,
        x: windowX,
        y: windowY,
        z: northZ,
        width: 3.2,
        depth: northWindowDepth,
        height: windowHeight,
      });
    }
    for (const windowZ of [-7.5, -3.8, 0.2, 4.3, 8]) {
      pushBox(boxes, {
        kind: "window-west",
        level,
        material: "glazing",
        fill: facade.glazingColor || "#86a8c6",
        alpha: 0.34,
        x: -11.88,
        y: windowY,
        z: windowZ,
        width: 0.08,
        depth: 2.2,
        height: windowHeight,
      });
      pushBox(boxes, {
        kind: "window-east",
        level,
        material: "glazing",
        fill: facade.glazingColor || "#86a8c6",
        alpha: 0.34,
        x: 11.88,
        y: windowY,
        z: windowZ,
        width: 0.08,
        depth: 2.2,
        height: windowHeight,
      });
    }
  }

  const roofBase = storeys * floorToFloor;
  pushBox(boxes, {
    kind: "roof-slab",
    material: "roof",
    fill: "#d5cec2",
    alpha: 0.98,
    x: 0,
    y: roofBase,
    z: 0,
    width: 24,
    depth: 20,
    height: roof.slabHeight || 0.22,
  });
  pushBox(boxes, {
    kind: "parapet-north",
    material: "roof",
    fill: facade.trimColor || "#b7ad9b",
    alpha: 0.96,
    x: 0,
    y: roofBase + (roof.slabHeight || 0.22),
    z: -9.95,
    width: 24,
    depth: 0.22,
    height: roof.parapetHeight || 0.85,
  });
  pushBox(boxes, {
    kind: "parapet-south",
    material: "roof",
    fill: facade.trimColor || "#b7ad9b",
    alpha: 0.62,
    x: 0,
    y: roofBase + (roof.slabHeight || 0.22),
    z: 9.95,
    width: 24,
    depth: 0.22,
    height: roof.parapetHeight || 0.85,
  });
  pushBox(boxes, {
    kind: "parapet-west",
    material: "roof",
    fill: facade.trimColor || "#b7ad9b",
    alpha: 0.96,
    x: -11.95,
    y: roofBase + (roof.slabHeight || 0.22),
    z: 0,
    width: 0.22,
    depth: 20,
    height: roof.parapetHeight || 0.85,
  });
  pushBox(boxes, {
    kind: "parapet-east",
    material: "roof",
    fill: facade.trimColor || "#b7ad9b",
    alpha: 0.96,
    x: 11.95,
    y: roofBase + (roof.slabHeight || 0.22),
    z: 0,
    width: 0.22,
    depth: 20,
    height: roof.parapetHeight || 0.85,
  });
  pushBox(boxes, {
    kind: "lift-overrun",
    material: "core",
    fill: facade.coreColor || "#cfc7ba",
    alpha: 0.94,
    x: 0,
    y: roofBase + 0.22,
    z: 4.7,
    width: 4.4,
    depth: 4.8,
    height: 2.7,
  });
  pushBox(boxes, {
    kind: "roof-tank-west",
    material: "roof-equipment",
    fill: "#6d7479",
    alpha: 0.96,
    x: -6,
    y: roofBase + 0.22,
    z: -2.2,
    width: 2.2,
    depth: 2.2,
    height: 1.8,
  });
  pushBox(boxes, {
    kind: "roof-tank-east",
    material: "roof-equipment",
    fill: "#6d7479",
    alpha: 0.96,
    x: 6,
    y: roofBase + 0.22,
    z: -2.2,
    width: 2.2,
    depth: 2.2,
    height: 1.8,
  });
  for (const panelX of [-7.2, -4.8, -2.4, 2.4, 4.8, 7.2]) {
    pushBox(boxes, {
      kind: "solar-array",
      material: "solar",
      fill: "#27495c",
      alpha: 0.98,
      x: panelX,
      y: roofBase + 0.42,
      z: 1.8,
      width: 1.8,
      depth: 2.6,
      height: 0.08,
    });
  }
  pushBox(boxes, {
    kind: "entry-canopy",
    material: "trim",
    fill: "#b9afa0",
    alpha: 0.98,
    x: 0,
    y: 3.02,
    z: -10.8,
    width: 5.4,
    depth: 1.5,
    height: 0.14,
  });

  if (includeDevices) {
    for (const device of scene.devices) {
      pushBox(boxes, {
        kind: "device",
        deviceId: device.id,
        material: "device",
        fill: "#d4a64f",
        alpha: 0.96,
        x: device.position.x,
        y: device.position.y - 0.15,
        z: device.position.z,
        width: 0.35,
        depth: 0.35,
        height: device.type === "lift" ? 1.2 : 0.3,
      });
    }
  }

  return boxes;
}

function normalizeDevice(scene, deviceId, stateById, edgeState) {
  const device = scene.devices.find((item) => item.id === deviceId);
  if (!device) {
    return null;
  }
  return {
    ...device,
    state: clone(stateById[deviceId]),
    integration: {
      source: edgeState.connectedDeviceIds.includes(deviceId) ? "edge" : "mock",
      last_sync_at: edgeState.lastSyncAt,
      online: edgeState.connectedDeviceIds.includes(deviceId),
    },
  };
}

function createDigitalTwinRuntime() {
  const scene = buildSceneDefinition();
  const stateById = {};
  for (const device of scene.devices) {
    stateById[device.id] = createDeviceState(device);
  }

  const edgeState = {
    status: scene.edge.status,
    lastSyncAt: null,
    connectedDeviceIds: [],
  };

  return {
    getScene() {
      return {
        meta: clone(scene.meta),
        shell: clone(scene.shell),
        rooms: clone(scene.rooms),
        openings: clone(scene.openings),
        waypoints: clone(scene.waypoints),
        architecture: clone(buildArchitecturalBoxes(scene, { includeDevices: false })),
        devices: scene.devices.map((device) =>
          normalizeDevice(scene, device.id, stateById, edgeState)
        ),
        edge: {
          ...clone(scene.edge),
          status: edgeState.status,
          last_sync_at: edgeState.lastSyncAt,
          connectors: scene.edge.connectors.map((connector) => ({
            ...connector,
            status: edgeState.status === "connected" ? "live" : connector.status,
          })),
        },
      };
    },

    dispatchAction(deviceId, action) {
      const device = scene.devices.find((item) => item.id === deviceId);
      if (!device) {
        const error = new Error("device_not_found");
        error.statusCode = 404;
        throw error;
      }
      if (!device.actions.includes(action)) {
        const error = new Error("action_not_supported");
        error.statusCode = 400;
        throw error;
      }

      const state = stateById[deviceId];

      switch (device.type) {
        case "light":
          if (action === "toggle-power") {
            state.power = !state.power;
            state.level = state.power ? Math.max(state.level || 0, 60) : 0;
          }
          if (action === "dim-up") {
            state.power = true;
            state.level = Math.min(100, (state.level || 0) + 10);
          }
          if (action === "dim-down") {
            state.level = Math.max(0, (state.level || 0) - 10);
            state.power = state.level > 0;
          }
          break;
        case "door":
          if (action === "lock") {
            state.locked = true;
            state.open = false;
          }
          if (action === "unlock") {
            state.locked = false;
          }
          if (action === "pulse-open") {
            state.locked = false;
            state.open = true;
          }
          break;
        case "camera":
          if (action === "toggle-recording") {
            state.recording = !state.recording;
          }
          if (action === "snapshot") {
            state.lastSnapshotAt = new Date().toISOString();
          }
          break;
        case "lift":
          if (action === "call-lift") {
            state.direction = "serving call";
            state.floor = 1;
          }
          if (action === "set-service-mode") {
            state.mode = "service";
          }
          if (action === "set-normal-mode") {
            state.mode = "normal";
            state.direction = "idle";
          }
          break;
        default:
          break;
      }

      return {
        ok: true,
        device: normalizeDevice(scene, deviceId, stateById, edgeState),
      };
    },

    syncEdge() {
      edgeState.status = "connected";
      edgeState.lastSyncAt = new Date().toISOString();
      edgeState.connectedDeviceIds = [
        "light-lobby",
        "door-main",
        "camera-entry",
        "lift-core",
      ];
      return {
        ok: true,
        edge: {
          ...clone(scene.edge),
          status: edgeState.status,
          last_sync_at: edgeState.lastSyncAt,
          connected_device_ids: clone(edgeState.connectedDeviceIds),
        },
      };
    },
  };
}

module.exports = {
  buildArchitecturalBoxes,
  buildSceneDefinition,
  createDigitalTwinRuntime,
};
