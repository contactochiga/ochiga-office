This file defines the approved proposal language for a building-scale digital twin experience when a lead wants more than a static 3D render.

Scope this file covers:
- converting a supplied floor plan into a navigable building model
- combining exterior, interior, and control-system overlays into one operational twin
- showing device control, automation state, and building events inside the 3D scene

Important positioning rule:
- treat this as proposed solution architecture and demo scope, not as a blanket claim that every module is already production-ready in the current codebase
- use this file when a lead explicitly asks for a full smart-building twin, clickable controls, or a live building operations view

What the buyer is asking for in plain language:
- a full 3D building model derived from the floor plan
- both exterior and interior visualization, not only shell massing
- free camera movement across the building
- real-time status overlays for building systems
- clickable controls in-scene, such as selecting a switch, lock, panel, elevator, or camera and opening a control drawer
- a path to attach live devices and automation rules later

Safe description of the target experience:
The target solution is a live digital twin of the building: a navigable 3D model connected to building systems so operators can inspect spaces, open equipment panels, view status, and trigger approved controls from one operational view.

Suggested floor-plan interpretation for this specific image:
- building footprint shown as approximately 24 m by 20 m
- central circulation and service core
- multiple apartment units around the core
- balconies on upper perimeter edges
- suitable initial twin zones: entrance, core lobby, stair/lift zone, corridors, unit shells, bedrooms, kitchens, bathrooms, balconies

Recommended product architecture:

1. Spatial layer
- 2D plan tracing and zoning from the supplied image or CAD redraw
- 3D building shell generation
- room volumes, doors, windows, stairs, lift shaft, balconies, and circulation paths
- interior fit-out pass for walls, floors, ceilings, fixtures, furniture, and lighting placeholders

2. Twin scene layer
- web-based real-time 3D scene for desktop and mobile review
- orbit, walk, first-person, and guided-tour camera modes
- object picking for rooms, devices, and control points
- contextual info panels anchored to selected objects

3. Building systems layer
- lighting circuits and scene control
- access control for main entry, unit entry, shared doors, gates, and restricted zones
- elevator state, call, floor, mode, and alarm status
- HVAC or environmental monitoring if included later
- power, backup, and critical equipment status
- CCTV camera positions and live or snapshot feeds where allowed
- fire, safety, and incident overlays where integrated
- maintenance state and fault indicators

4. Edge and integration layer
- device registry with unique twin IDs mapped to 3D objects
- site gateway or edge agent for local device connectivity
- protocol adapters for cameras, relays, access hardware, meters, PLC/BMS points, and IoT devices
- event ingestion for telemetry, alarms, state changes, and operator commands

5. Application layer
- operator dashboard for alerts, permissions, logs, schedules, and workflows
- resident or occupant controls only where policy allows
- audit trail for every control action taken inside the twin
- role-based permissions so high-risk controls remain gated

How interactive control should work:
- the user clicks or taps a visible object in the 3D scene
- the camera animates toward that object
- the twin highlights the selected equipment or room
- a small control panel opens with live state, available actions, history, and automation rules
- actions are permission-checked before being sent to the device or workflow service
- resulting state changes update both the panel and the scene

Examples of object interactions:
- light switch: on or off, dim level, scene preset, occupancy status, recent activity
- door or access point: locked or unlocked, credential events, forced-open alarm, remote open if permitted
- elevator: current floor, travel direction, service mode, fault state, call request
- camera: live stream or recent snapshot, health, recording state, linked alerts
- room: temperature, occupancy, active devices, maintenance issues, energy usage if metered

Core data objects for the twin:
- site
- building
- floor
- zone
- room
- asset
- device
- control point
- event
- alert
- automation rule
- camera waypoint

Suggested implementation phases:

Phase 1: spatial prototype
- redraw the plan cleanly into a structured digital floor plan
- build the 3D shell and room zoning
- support camera navigation and clickable zones
- use mocked device states first

Phase 2: interactive twin demo
- add interior styling and key equipment markers
- add object selection, animated focus, and control drawers
- connect a subset of systems such as lighting, access, cameras, and lift status
- implement event feed and audit logging

Phase 3: operational twin
- connect live site devices through the edge layer
- add alarms, schedules, workflows, and operator permissions
- support service tickets, incident replay, and health monitoring
- optimize model loading, streaming, and scene performance

What to say about realism and output formats:
- the twin can be delivered as a real-time interactive web scene
- a guided video flythrough can be generated from the same model for sales or approvals
- photorealism is possible, but operational clarity should take priority over purely cinematic rendering

What not to promise without technical confirmation:
- exact hardware compatibility across every vendor
- exact BIM, CAD, or BMS import path
- exact real-time latency targets
- exact mobile graphics performance on all devices
- exact delivery timeline for the full operational scope

Discovery questions the agent should collect before sales handoff:
- Is the goal sales visualization, operator control, or both?
- Do they have CAD, SketchUp, Revit, or only image floor plans?
- How many floors, buildings, units, and shared facilities are in scope?
- Which systems matter first: access, lights, elevator, CCTV, HVAC, energy, fire, maintenance?
- Should the first delivery be a demo twin, a design twin, or a live integrated twin?

Recommended next-step phrasing:
- "We can scope this as a phased digital twin: first the navigable 3D building, then clickable controls, then live system integration."
- "The right first milestone is usually an interactive twin demo built from your floor plan and priority control systems."
- "For a full smart-building twin, we should confirm the building systems, device vendors, and whether this first version is for presentation or live operations."
