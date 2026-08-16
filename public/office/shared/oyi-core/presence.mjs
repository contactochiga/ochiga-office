// Oyi Universal Interaction Shell — shared presence state machine.
//
// Replaces the ad-hoc, duplicated state vocabularies found across
// Website (VoiceMode/VoiceStatus), Office (no formal states — just
// state.oyiBusy), and Consumer (orb state / VoiceStatus / message
// state / TruthState, four overlapping unions that were never
// unified). One vocabulary, one set of legal transitions, driving
// orb glow/animation, status text, and mode surfaces uniformly.
//
// Framework-agnostic — no DOM, no React. See docking.mjs for the
// dual-consumption rationale (Office <script type="module"> +
// Website's bundler, byte-identical vendored copy in Office).

/** @typedef {"idle"|"listening"|"thinking"|"speaking"|"attention"|"executing"|"offline"} PresenceState */

export const PRESENCE_STATES = /** @type {const} */ ([
  "idle",
  "listening",
  "thinking",
  "speaking",
  "attention",
  "executing",
  "offline",
]);

// Legal transitions. "offline" and "attention" can interrupt from
// anywhere (a backend outage or a proactive signal can happen mid
// any other state); everything else follows the natural
// input -> processing -> output loop back to idle.
/** @type {Record<PresenceState, PresenceState[]>} */
const TRANSITIONS = {
  idle: ["listening", "thinking", "attention", "executing", "offline"],
  listening: ["thinking", "idle", "offline", "attention"],
  thinking: ["speaking", "executing", "attention", "idle", "offline"],
  speaking: ["idle", "listening", "attention", "offline"],
  attention: ["idle", "listening", "thinking", "offline"],
  executing: ["speaking", "attention", "idle", "offline"],
  offline: ["idle"],
};

/**
 * @param {PresenceState} from
 * @param {PresenceState} to
 * @returns {boolean}
 */
export function canTransition(from, to) {
  if (from === to) return true;
  const allowed = TRANSITIONS[from];
  return Boolean(allowed && allowed.includes(to));
}

/**
 * Resolves the next state, falling back to the requested state
 * anyway if the transition table doesn't recognize the pair (fail
 * open, not closed — a presence indicator should never get stuck
 * because of a transition-table gap; log the anomaly instead).
 * @param {PresenceState} from
 * @param {PresenceState} to
 * @param {{onIllegalTransition?: (from: PresenceState, to: PresenceState) => void}} [options]
 * @returns {PresenceState}
 */
export function nextPresenceState(from, to, options) {
  if (!canTransition(from, to) && options?.onIllegalTransition) {
    options.onIllegalTransition(from, to);
  }
  return to;
}

/**
 * Declarative visual mapping consumed by both presentation layers —
 * keeps "what does thinking look like" defined once. Consumers apply
 * `glow`/`pulse`/`label` however fits their own rendering (CSS class,
 * inline style, React state); this module only decides the mapping.
 * @type {Record<PresenceState, {glow: "none"|"soft"|"active"|"warm"|"muted", pulse: boolean, label: string}>}
 */
export const PRESENCE_VISUAL = {
  idle: { glow: "soft", pulse: false, label: "" },
  listening: { glow: "active", pulse: true, label: "Listening" },
  thinking: { glow: "active", pulse: true, label: "Thinking" },
  speaking: { glow: "active", pulse: false, label: "Responding" },
  attention: { glow: "warm", pulse: true, label: "Needs attention" },
  executing: { glow: "active", pulse: true, label: "Working" },
  offline: { glow: "muted", pulse: false, label: "Unavailable" },
};
