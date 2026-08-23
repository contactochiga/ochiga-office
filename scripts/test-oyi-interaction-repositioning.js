const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public/office/index.html"), "utf8");
const client = fs.readFileSync(path.join(root, "public/office/office.js"), "utf8");
const gateway = fs.readFileSync(path.join(root, "src/lead-agents/oyi-core-gateway.js"), "utf8");
const server = fs.readFileSync(path.join(root, "src/lead-agents/server.js"), "utf8");

assert(html.includes('<div class="subtitle">Office Intelligence</div>'), "canonical Oyi header subtitle is missing");
assert(html.includes('<div class="oyi-minimized-subtitle">Office Intelligence</div>'), "minimized identity must match the header");
assert(html.includes('placeholder="Ask Oyi anything…"'), "reference composer placeholder is missing");
assert(html.includes('id="oyiSend" aria-label="Send" disabled'), "send must begin disabled");
assert(html.includes('aria-haspopup="menu"') && html.includes('aria-controls="oyiPlusMenu"'), "capability trigger needs menu semantics");
assert(html.includes("Share file") && html.includes("Send photo / video") && html.includes("Voice chat"), "capability menu is incomplete");
assert(/\.oyi-composer \.oyi-plus-item\s*\{[\s\S]*?width: 100%; height: auto/.test(html), "capability rows must override icon-button dimensions");
assert(html.includes("background: none; border: none; color: var(--text-secondary)"), "capability rows must override the generic red send-button treatment");
assert(html.includes("prefers-reduced-motion: reduce"), "reduced-motion support is missing");
assert(/\.oyi-panel\s*\{[\s\S]*?height: min\(560px, calc\(100dvh - 120px\)\)/.test(html), "open Oyi needs a stable viewport-bounded working height");

assert(client.includes('event.key === "Enter" && !event.shiftKey'), "Enter/Shift+Enter behavior is missing");
assert(!client.includes('getElementById("oyiContext")'), "removed context-label presentation must not be a navigation dependency");
assert(client.includes("syncOyiPresentationSafely()"), "Oyi presentation synchronization must be isolated from route state");
assert(client.includes("async function renderRouteSafely()"), "the Office outlet needs a route-level error boundary");
assert(client.includes("resetOyiTransientModesForNavigation()"), "navigation must clear turn-scoped visual/voice UI state");
assert(client.includes("page_context: currentPageContext()"), "internal Oyi page context must remain in the canonical chat request");
assert(client.includes('event.key === "ArrowDown" || event.key === "ArrowUp"'), "menu arrow-key navigation is missing");
assert(client.includes("closeOyiPlusMenu({ restoreFocus: true })"), "Escape must restore focus to the menu trigger");
assert(client.includes("initialOyiActivity(message)"), "honest processing-state selection is missing");
assert(!html.includes("oyi-activity-steps") && !html.includes("oyi-activity-step"), "processing UI must not render a stacked checklist");
assert(!client.includes("initial.steps"), "processing UI must not pass multiple simultaneous stages");
assert(client.includes('class="oyi-activity-content"'), "canonical single processing surface is missing");
assert(client.includes('aria-atomic="true"'), "processing replacement must be announced as one atomic status");
assert(client.includes('const matched = OYI_MESSAGE_ACTIVITY.find'), "processing must select one honest request-domain label");
assert(client.includes('label: "Reviewing tasks…"') && client.includes('label: "Checking meetings…"'), "task and meeting processing mappings are missing");
assert(client.includes('label: "Reviewing lead activity…"'), "CRM processing mapping is missing");
assert(client.includes('return { label: "Working on that…", icon: "thinking" }'), "honest generic processing fallback is missing");
assert(client.includes('accept: "application/x-ndjson"'), "Office must request the real runtime-stage stream");
assert(client.includes("applyOyiRuntimeStage(event.stage)"), "runtime events must replace the canonical processing row in place");
assert(client.includes("renderResponseBlocks(normalized.cards)"), "canonical structured block renderer is not connected");
assert(client.includes("renderApprovalSurface(normalized.toolProposals)"), "governed proposal renderer is not connected");
assert(client.includes("apiTranscribeOyiVoice") && client.includes("openOyiVoiceChat"), "dictation and voice chat paths must remain distinct and real");
assert(html.includes('id="oyiRecordingStop"') && html.includes("Stop</button>"), "recording needs a distinct stop-for-review action");
assert(client.includes("finishOyiVoiceRecording({ sendImmediately = false } = {})"), "recording must support review and direct-send modes");
assert(client.includes("input.value = transcriptText"), "stop-for-review must put transcription into the canonical composer");
assert(client.includes("finishOyiVoiceRecording({ sendImmediately: true })"), "recording send must stop, transcribe, and submit canonically");

assert(gateway.includes("image_data_url") && gateway.includes("document_data_url"), "visual/file contracts are not forwarded to Backend");
assert(server.includes('/api/lead-agents/admin/office/intelligence/transcribe'), "authenticated Office transcription route is missing");
assert(server.includes('/api/lead-agents/admin/office/intelligence/speech'), "voice-chat speech route is missing");
assert(server.includes('authorizePermission(authContext, "office.intelligence")'), "Office intelligence routes must remain permission-gated");
assert(server.includes('type: "stage"') && server.includes('type: "result"'), "safe sequential runtime-stage contract is missing");

console.log("oyi interaction repositioning acceptance: PASS");
