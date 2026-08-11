# Ochiga Infrastructure Intelligence Website

## Purpose
Design and implement a cinematic institutional website for Ochiga as an infrastructure intelligence company, not a generic SaaS landing page. The public story presents one unified ecosystem: Ochiga as the company layer, Oyi as the product family, and Oyi Facility, Oyi Home, Oyi AI, and Oyi Edge as public product surfaces.

## Positioning
Ochiga builds Africa's infrastructure operating layer for estates, buildings, and connected operational environments. The site should communicate operational infrastructure intelligence: lifecycle visibility, maintenance, security, utilities, smart environments, realtime supervision, and AI-assisted operations.

## Visual Direction
- Environment: obsidian black, charcoal grey, deep graphite, dark metallic surfaces.
- Accents: cyber blue, amber, operational green, emergency red only for telemetry, active nodes, alerts, and infrastructure states.
- Typography: large cinematic sans-serif headings, restrained body copy, strong whitespace, enterprise readability.
- 3D quality: photorealistic architectural-grade renders, PBR materials, glass reflections, metallic systems, twilight lighting, subtle fog, volumetric atmosphere.
- Avoid: startup gradients, generic cards, crypto aesthetics, childish holograms, low-poly, gaming visuals.

## Core 3D Subject
A premium modern Lagos smart-estate building, approximately 10 floors, with luxury facade, rooftop systems, basement parking cues, CCTV points, access nodes, utility infrastructure, and operational lighting. The building is the infrastructure graph.

## Scroll Architecture
The page uses React Three Fiber for a persistent 3D canvas and HTML/CSS overlay sections. Scroll progress drives camera position, material transitions, node activation, and overlay reveals. The scrollbar acts as an operational timeline.

## Scene 1: Physical Infrastructure
3D: Photorealistic building in a dark atmospheric void. Subtle pulses on access points, utility zones, rooftop systems, and security nodes.

Overlay:
- Headline: Ochiga — Technology Meets Infrastructure.
- Subhead: Building Africa's infrastructure operating layer for estates, buildings, and connected operational environments.
- Body: Ochiga unifies fragmented infrastructure systems into one intelligent operational ecosystem.

Motion:
- Camera starts wide at 35mm equivalent.
- Slow dolly inward with slight vertical rise.
- HTML copy fades from 0 to 1 opacity during first 20% of scene progress.

## Scene 2: Operational Layer
3D: Building partially dissolves into operational visualization. Keep realistic shell visible while wireframe edges, telemetry lines, and active system nodes appear.

Overlay:
- Headline: One Operational Platform.
- Subhead: Security, utilities, maintenance, devices, access control, and infrastructure operations often function independently. Ochiga unifies them into one coordinated operational environment.

Motion:
- Scroll progress controls material blend from physical facade to hybrid facade/wireframe.
- Nodes pulse lightly: access, CCTV, power, water, HVAC, maintenance.
- Do not replace realism with fantasy; this is an operational layer over a real building.

## Scene 3: Live Infrastructure Intelligence
3D: Camera enters the building operational layer. Scroll temporarily snaps/pauses into an interactive section.

Interaction:
- Users click glowing operational nodes.
- Panels open in-place as premium glass overlays.
- No page refresh.
- Node categories: Estate Portfolio, Security & Access, Utilities, Community Operations, Environment & Sensors, Infrastructure Intelligence.

Panel data examples:
- Estate Portfolio: blocks, occupancy, estate activity, deployment status.
- Security & Access: CCTV visibility, visitor logs, access activity, incidents.
- Utilities: power, water, HVAC, lighting, utility health.
- Community Operations: announcements, activity, amenities, communications.
- Environment & Sensors: temperature, air quality, smoke, occupancy.
- Infrastructure Intelligence: health, trends, AI insights, maintenance indicators, diagnostics.

## Scene 4: Infrastructure Intelligence
3D: Hybrid infrastructure mode with map overlays, heat maps, telemetry layers, and operational analytics. It must feel like supervision, not decoration.

Overlay:
- Headline: Infrastructure Intelligence.
- Subhead: Supervise estates and buildings through live infrastructure visibility, heat maps, realtime operations, spatial infrastructure awareness, and coordinated operational intelligence.
- Quote: The goal is not just automation. The goal is operational awareness.

Motion:
- Camera orbits slightly while map/heat/twin overlays blend.
- Active alerts ripple softly.
- Utility loads glow as restrained heat fields.

## Scene 5: Unified Lifecycle Onboarding
3D Part 1: Operational desk setup with large monitor showing Oyi Facility. Operator creates resident access.

3D Part 2: Camera pans downward through the desk toward a smartphone on the surface. Transition must feel seamless and cinematic.

3D Part 3: Smartphone illuminates and opens Oyi Home onboarding. Show secure notification, smart living, visitor management, device control, room intelligence, maintenance requests, and home automation.

Overlay:
- Headline: Enterprise-Grade Infrastructure Onboarding.
- Subhead: Estate administration provisions operational access through Oyi Facility. Residents securely onboard into Oyi Home for their connected living experience. Every role receives permission-aware operational visibility.

## Scene 6: Ecosystem Vision
3D: Camera pulls far back. The building becomes part of a connected infrastructure network of estates and operational clusters across Africa.

Product grid:
- Oyi Facility
- Oyi Home
- Oyi AI
- Oyi Edge

Final overlay:
- Headline: Building Africa's Infrastructure Operating Layer.
- Subhead: Intelligent. Connected. Operational. Maintainable. Continuously supervised.
- CTA: Request Enterprise Demo
- Secondary text: Operational deployments for estates, buildings, and infrastructure environments.

## React Three Fiber Implementation Notes
- Use one persistent `<Canvas>` with scene state derived from normalized scroll progress.
- Use `useScroll` from `@react-three/drei` or a custom IntersectionObserver + spring store.
- Use physically based materials: `meshPhysicalMaterial`, transmission for glass, roughness/metalness tuned per facade layer.
- Use `Environment`, `ContactShadows`, `fog`, and carefully controlled bloom.
- Keep post-processing restrained: subtle bloom only for active telemetry nodes.
- Use GSAP, Framer Motion, or `react-spring` for overlay reveal sequencing.
- HTML overlays should be fixed/sticky layers with pointer events enabled only during interactive scenes.

## Data/UI Layer Sync
- Scene progress 0.00-0.16: Hero camera push.
- Scene progress 0.16-0.32: Material dissolve and wireframe overlay.
- Scene progress 0.32-0.52: Interactive Live Infrastructure View; scroll lock optional until node panel closes.
- Scene progress 0.52-0.68: Hybrid intelligence, map, heat, telemetry.
- Scene progress 0.68-0.84: Facility-to-Home onboarding desk-to-phone transition.
- Scene progress 0.84-1.00: Ecosystem pullback and product grid.

## Production Requirements
- Desktop: cinematic full-canvas experience.
- Tablet: simplified camera paths, same story.
- Mobile: pre-rendered or simplified 3D model variants, lower particle count, retained premium overlays.
- Accessibility: reduced-motion mode switches to static cinematic frames and normal scroll sections.
- Performance: GLB optimization, Draco/KTX2, lazy-load heavy scenes, cap DPR on mobile, progressive model loading.
