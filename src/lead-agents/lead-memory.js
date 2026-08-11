const fs = require("fs/promises");
const path = require("path");

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

function unique(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function detectNeeds(text) {
  const value = String(text || "").toLowerCase();
  const pairs = [
    ["demo", ["demo", "call", "discovery"]],
    ["pricing", ["pricing", "price", "cost", "quote"]],
    ["proposal", ["proposal", "scope", "rfp"]],
    ["deployment", ["deployment", "implementation", "rollout"]],
    ["access control", ["access", "gate", "visitor"]],
    ["monitoring", ["monitoring", "surveillance", "cctv"]],
    ["facility management", ["facility", "maintenance", "operations"]],
    ["resident experience", ["resident", "tenant", "community"]],
  ];

  return pairs
    .filter(([, keywords]) => keywords.some((keyword) => value.includes(keyword)))
    .map(([label]) => label);
}

class FileLeadMemoryStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.state = {
      byLeadId: {},
    };
    this.pendingWrite = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.state = {
        byLeadId: parsed && parsed.byLeadId ? parsed.byLeadId : {},
      };
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  persist() {
    this.pendingWrite = this.pendingWrite.then(() =>
      fs.writeFile(this.filePath, JSON.stringify(this.state, null, 2))
    );
    return this.pendingWrite;
  }

  async get(leadId) {
    return this.state.byLeadId[leadId] || null;
  }

  buildOpenQuestions(lead) {
    const questions = [];
    if (!lead.company || lead.company === "unknown") {
      questions.push("Confirm company");
    }
    if (!lead.role || lead.role === "unknown") {
      questions.push("Confirm role");
    }
    if (!lead.location || lead.location === "unknown") {
      questions.push("Confirm location");
    }
    if (!lead.next_action) {
      questions.push("Define next action");
    }
    return questions;
  }

  async updateFromTurn({ lead, userMessage, assistantMessage, toolCalls }) {
    const current = this.state.byLeadId[lead.id] || {
      lead_id: lead.id,
      known_fields: {},
      need_signals: [],
      open_questions: [],
      keywords: [],
      last_user_message: "",
      last_agent_message: "",
      last_status: "",
      last_owner: "",
      last_summary: "",
      updated_at: "",
    };

    const next = {
      ...current,
      known_fields: {
        name: lead.name || current.known_fields.name || "",
        company: lead.company || current.known_fields.company || "",
        role: lead.role || current.known_fields.role || "",
        email: lead.email || current.known_fields.email || "",
        phone: lead.phone || current.known_fields.phone || "",
        location: lead.location || current.known_fields.location || "",
        source: lead.source || current.known_fields.source || "",
      },
      need_signals: unique([
        ...(current.need_signals || []),
        ...detectNeeds(userMessage),
      ]),
      open_questions: this.buildOpenQuestions(lead),
      keywords: unique([
        ...(current.keywords || []),
        ...tokenize(userMessage).slice(0, 12),
      ]).slice(-20),
      last_user_message: userMessage || current.last_user_message,
      last_agent_message: assistantMessage || current.last_agent_message,
      last_status: lead.status || current.last_status,
      last_owner: lead.owner || current.last_owner,
      last_summary: lead.summary || current.last_summary,
      tool_calls: (toolCalls || []).map((item) => item.name),
      updated_at: new Date().toISOString(),
    };

    this.state.byLeadId[lead.id] = next;
    await this.persist();
    return next;
  }

  serializeForPrompt(memory) {
    if (!memory) {
      return "No lead memory stored yet.";
    }

    return [
      `Known fields: ${JSON.stringify(memory.known_fields || {})}`,
      `Need signals: ${(memory.need_signals || []).join(", ") || "none"}`,
      `Open questions: ${(memory.open_questions || []).join(", ") || "none"}`,
      `Keywords: ${(memory.keywords || []).join(", ") || "none"}`,
      `Last status: ${memory.last_status || "unknown"}`,
      `Last owner: ${memory.last_owner || "unknown"}`,
      `Last summary: ${memory.last_summary || "none"}`,
      `Last user message: ${memory.last_user_message || "none"}`,
      `Last agent message: ${memory.last_agent_message || "none"}`,
    ].join("\n");
  }
}

module.exports = {
  FileLeadMemoryStore,
};
