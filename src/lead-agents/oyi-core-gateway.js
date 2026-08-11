const axios = require("axios");

function text(value) {
  return String(value ?? "").trim();
}

function recordOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function oyiCoreConversationUrl(config = {}) {
  const base = text(config.officeBackendBaseUrl).replace(/\/+$/g, "");
  const path = text(config.officeBackendConversationPath || "/office/conversation/corporate");
  if (!base || !path) return "";
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function buildOyiCoreCorporateConversationRequest({ session, message, lead, body, requestId } = {}) {
  const safeSession = recordOf(session);
  const safeLead = recordOf(lead);
  const safeBody = recordOf(body);
  const source = recordOf(safeSession.source);

  return {
    request_id: text(requestId || safeBody.request_id),
    message: text(message || safeBody.message),
    public_session_id: text(safeSession.session_id || safeBody.public_session_id || safeBody.session_id),
    conversation_thread_id: text(
      safeSession.conversation_thread_id || safeBody.conversation_thread_id || safeBody.thread_id
    ),
    public_identity: text(safeSession.public_identity || "ochiga_intelligence"),
    agent_role: text(safeSession.active_agent_role || "oma"),
    business_unit: text(safeSession.business_unit || "corporate"),
    inquiry_type: text(safeSession.inquiry_type || "general_enquiry"),
    source: {
      source_site: text(source.source_site || safeBody.source_site || safeBody.source || "ochiga_website"),
      source_page: text(source.source_page || safeBody.source_page || safeBody.page),
      source_channel: text(source.source_channel || safeBody.source_channel || "website"),
      source_form: text(source.source_form || safeBody.source_form),
      campaign: recordOf(source.campaign || safeBody.campaign),
    },
    visitor_state: safeLead.id ? "known" : "anonymous",
    crm_context: safeLead.id
      ? {
          lead_ref: text(safeLead.id),
          contact_ref: text(safeSession.crm_contact_ref),
          opportunity_ref: text(safeSession.crm_opportunity_ref),
          safe_summary: text(safeLead.summary || safeLead.next_action),
          stage: text(safeLead.commercial_stage || safeLead.stage || safeLead.status),
        }
      : null,
    form_context_ref: text(safeSession.secure_form_context_ref || safeBody.form_context_ref),
    engagement_mode: text(safeSession.engagement_mode || safeBody.mode || "text_conversation"),
    handoff_state: text(safeSession.handoff_state || "none"),
    requested_capability: text(safeBody.requested_capability || "public_question_answer"),
    knowledge_context: Array.isArray(safeBody.knowledge_context) ? safeBody.knowledge_context : [],
    metadata: {
      crm_source_of_truth: "ochiga-office",
      intelligence_authority: "ochiga-backend",
      profile_present: Boolean(safeBody.profile && Object.keys(recordOf(safeBody.profile)).length),
      voice_state: text(safeSession.voice_state),
      proactive_prompt_state: text(safeSession.proactive_prompt_state),
    },
  };
}

function buildOyiCoreOfficeInternalRequest({ authContext, message, body, requestId } = {}) {
  const safeBody = recordOf(body);
  const page = recordOf(safeBody.page_context);
  const staff = recordOf(safeBody.staff);
  return {
    request_id: text(requestId || safeBody.request_id),
    message: text(message || safeBody.message),
    office_session_id: text(safeBody.office_session_id || safeBody.session_id || `office_session_${requestId || Date.now()}`),
    conversation_thread_id: text(safeBody.conversation_thread_id || safeBody.thread_id),
    staff: {
      staff_id: text(staff.staff_id || staff.id || authContext?.userId),
      email: text(staff.email || authContext?.email),
      role: text(staff.role || authContext?.role || "ochiga_staff"),
      permissions: Array.isArray(staff.permissions)
        ? staff.permissions
        : Array.isArray(authContext?.permissions)
        ? authContext.permissions
        : [],
    },
    page_context: {
      page: text(page.page || safeBody.page),
      selected_type: text(page.selected_type || safeBody.selected_type),
      selected_id: text(page.selected_id || safeBody.selected_id),
    },
    business_unit: text(safeBody.business_unit || "corporate"),
    capability_context: Array.isArray(safeBody.capability_context) ? safeBody.capability_context : [],
    crm_context: recordOf(safeBody.crm_context),
    portfolio_context: recordOf(safeBody.portfolio_context),
    support_context: recordOf(safeBody.support_context),
    requested_capability: text(safeBody.requested_capability || "office_internal_conversation"),
    knowledge_context: Array.isArray(safeBody.knowledge_context) ? safeBody.knowledge_context : [],
    metadata: {
      crm_source_of_truth: "ochiga-office",
      intelligence_authority: "ochiga-backend",
      surface: "office_internal",
      mode: text(safeBody.mode || "text_conversation"),
    },
  };
}

async function callOyiCoreCorporateConversation(config = {}, payload = {}, options = {}) {
  const url = oyiCoreConversationUrl(config);
  if (!url) {
    return { ok: false, unavailable: true, reason: "not_configured", status: 0 };
  }

  const headers = {
    "content-type": "application/json",
    "x-request-id": text(payload.request_id),
    "x-public-session-id": text(payload.public_session_id),
  };
  if (config.officeBackendApiKey) headers["x-office-api-key"] = config.officeBackendApiKey;
  if (config.officeBackendBearerToken) headers.authorization = `Bearer ${config.officeBackendBearerToken}`;

  const post = options.httpPost || ((targetUrl, body, requestConfig) => axios.post(targetUrl, body, requestConfig));
  try {
    const response = await post(url, payload, {
      timeout: config.officeBackendEventTimeoutMs || 10_000,
      headers,
      validateStatus: () => true,
    });
    const status = Number(response && response.status) || 0;
    const body = recordOf(response && response.data);
    if (status >= 200 && status < 300 && body.ok !== false) {
      return { ok: true, unavailable: false, status, response: body };
    }
    return {
      ok: false,
      unavailable: true,
      status,
      reason: text(body.error || body.reason || "backend_rejected"),
      response: body,
    };
  } catch (error) {
    return {
      ok: false,
      unavailable: true,
      status: 0,
      reason: "network_error",
      error: error && error.code ? String(error.code) : "request_failed",
    };
  }
}

async function callOyiCoreOfficeInternalConversation(config = {}, payload = {}, options = {}) {
  const path = config.officeBackendInternalConversationPath || "/office/conversation/internal";
  return callOyiCoreCorporateConversation(
    { ...config, officeBackendConversationPath: path },
    payload,
    options
  );
}

module.exports = {
  buildOyiCoreCorporateConversationRequest,
  buildOyiCoreOfficeInternalRequest,
  callOyiCoreCorporateConversation,
  callOyiCoreOfficeInternalConversation,
  oyiCoreConversationUrl,
};
