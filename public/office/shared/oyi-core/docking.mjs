// Oyi Universal Interaction Shell — docking engine.
//
// Framework-agnostic, DOM-agnostic pure functions. No React, no direct
// DOM reads/writes — callers pass in plain numbers (viewport size, orb
// size, pointer position) and get plain numbers back. This is what
// makes the file safely importable both as a native ES module from
// Office's unbundled `<script type="module">` frontend and from
// Website's Next.js/webpack build with zero adaptation.
//
// Source of truth: Ochiga-website's lib/oyi-shell/core/docking.mjs.
// Office vendors a byte-identical copy at
// public/office/shared/oyi-core/docking.mjs — see
// docs/oyi-shell-core-sync.md in each repo for the sync process.

/** @typedef {"top-left"|"top-right"|"mid-left"|"mid-right"|"bottom-left"|"bottom-right"} AnchorId */

/** Canonical anchor order — also the fallback order used when nothing else disambiguates a tie. */
export const ANCHOR_IDS = /** @type {const} */ ([
  "top-left",
  "top-right",
  "mid-left",
  "mid-right",
  "bottom-left",
  "bottom-right",
]);

/**
 * Computes the top-left pixel position for every anchor given the
 * current viewport and orb size. Anchors sit `margin` px from the
 * edges they're attached to; "mid" anchors are vertically centered.
 * @param {{viewportWidth:number, viewportHeight:number, size:number, margin:number}} bounds
 * @returns {Record<AnchorId, {x:number,y:number}>}
 */
export function anchorPositions(bounds) {
  const { viewportWidth, viewportHeight, size, margin } = bounds;
  const left = margin;
  const right = viewportWidth - size - margin;
  const top = margin;
  const bottom = viewportHeight - size - margin;
  const midY = (viewportHeight - size) / 2;
  return {
    "top-left": { x: left, y: top },
    "top-right": { x: right, y: top },
    "mid-left": { x: left, y: midY },
    "mid-right": { x: right, y: midY },
    "bottom-left": { x: left, y: bottom },
    "bottom-right": { x: right, y: bottom },
  };
}

/**
 * During an active drag, projects a raw pointer-following position
 * onto whichever screen edge is nearest — the orb slides along that
 * edge rather than following the pointer freely into the interior.
 * This is the behavior the reference design calls out explicitly:
 * the center of the screen is never a valid resting position.
 * @param {{x:number,y:number}} raw - unconstrained position the orb would occupy if it just followed the pointer
 * @param {{viewportWidth:number, viewportHeight:number, size:number, margin:number}} bounds
 * @returns {{x:number,y:number}}
 */
export function projectToNearestEdge(raw, bounds) {
  const { viewportWidth, viewportHeight, size, margin } = bounds;
  const minX = margin;
  const maxX = viewportWidth - size - margin;
  const minY = margin;
  const maxY = viewportHeight - size - margin;

  const clampedX = Math.min(Math.max(raw.x, minX), maxX);
  const clampedY = Math.min(Math.max(raw.y, minY), maxY);

  // Distance from the (clamped) orb position to each of the 4 edges.
  const distToLeft = clampedX - minX;
  const distToRight = maxX - clampedX;
  const distToTop = clampedY - minY;
  const distToBottom = maxY - clampedY;
  const nearest = Math.min(distToLeft, distToRight, distToTop, distToBottom);

  if (nearest === distToLeft) return { x: minX, y: clampedY };
  if (nearest === distToRight) return { x: maxX, y: clampedY };
  if (nearest === distToTop) return { x: clampedX, y: minY };
  return { x: clampedX, y: maxY };
}

/**
 * Finds the closest of the 6 canonical anchors to a given position —
 * used on drag release to snap.
 * @param {{x:number,y:number}} position
 * @param {{viewportWidth:number, viewportHeight:number, size:number, margin:number}} bounds
 * @returns {AnchorId}
 */
export function nearestAnchor(position, bounds) {
  const anchors = anchorPositions(bounds);
  /** @type {AnchorId} */
  let best = ANCHOR_IDS[0];
  let bestDist = Infinity;
  for (const id of ANCHOR_IDS) {
    const a = anchors[id];
    const dx = a.x - position.x;
    const dy = a.y - position.y;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = id;
    }
  }
  return best;
}

/**
 * Direction the panel should expand in, so it always opens inward
 * from whichever edge the orb is docked to and never off-screen.
 * Top/bottom anchors have an unambiguous vertical direction; "mid"
 * anchors return "auto" and must be resolved against real available
 * space via resolveVerticalOpenDirection.
 * @param {AnchorId} anchor
 * @returns {{horizontal:"left"|"right", vertical:"up"|"down"|"auto"}}
 */
export function panelOpenDirection(anchor) {
  const horizontal = anchor.endsWith("left") ? "right" : "left";
  const vertical = anchor.startsWith("top") ? "down" : anchor.startsWith("bottom") ? "up" : "auto";
  return { horizontal, vertical };
}

/**
 * Whether the panel (opening in `vertical` direction from the orb's
 * current y position) actually fits without being clipped by the
 * viewport — callers use this to override panelOpenDirection's
 * default for "mid" anchors, or to flip a top/bottom anchor's panel
 * in the rare case the viewport is unusually short.
 * @param {{orbY:number, orbSize:number, panelHeight:number, viewportHeight:number, gap:number}} args
 */
export function resolveVerticalOpenDirection({ orbY, orbSize, panelHeight, viewportHeight, gap }) {
  const spaceAbove = orbY - gap;
  const spaceBelow = viewportHeight - (orbY + orbSize) - gap;
  if (spaceBelow >= panelHeight) return "down";
  if (spaceAbove >= panelHeight) return "up";
  // Neither fits fully — prefer whichever side has more room; the
  // panel's own max-height/scroll takes it from there.
  return spaceBelow >= spaceAbove ? "down" : "up";
}

/**
 * Full drag-release resolution in one call: snap to nearest anchor,
 * then resolve the panel's open direction against real viewport space.
 * @param {{x:number,y:number}} releasePosition
 * @param {{viewportWidth:number, viewportHeight:number, size:number, margin:number, panelWidth:number, panelHeight:number, panelGap:number}} bounds
 * @returns {{anchor:AnchorId, position:{x:number,y:number}, openDirection:{horizontal:"left"|"right", vertical:"up"|"down"}}}
 */
export function resolveDockedState(releasePosition, bounds) {
  const anchor = nearestAnchor(releasePosition, bounds);
  const position = anchorPositions(bounds)[anchor];
  const base = panelOpenDirection(anchor);
  const vertical =
    base.vertical === "auto"
      ? resolveVerticalOpenDirection({
          orbY: position.y,
          orbSize: bounds.size,
          panelHeight: bounds.panelHeight,
          viewportHeight: bounds.viewportHeight,
          gap: bounds.panelGap,
        })
      : base.vertical;
  return { anchor, position, openDirection: { horizontal: base.horizontal, vertical } };
}
