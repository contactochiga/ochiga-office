async function sendOfficeEmail(config, message) {
  const provider = String(config.officeEmailProvider || "").toLowerCase();
  const to = String(message.to || "").trim();
  if (!to) {
    return { delivered: false, skipped: true, reason: "missing_recipient" };
  }
  if (provider === "resend" && config.resendApiKey) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.resendApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: config.officeEmailFrom,
        to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.message || "email_delivery_failed");
      error.statusCode = 502;
      throw error;
    }
    return { delivered: true, provider, payload };
  }
  return {
    delivered: false,
    skipped: true,
    reason: "email_provider_not_configured",
    provider: provider || "none",
  };
}

function staffInviteEmail({ displayName, inviteUrl, role }) {
  const name = displayName || "there";
  return {
    subject: "Your Ochiga Office staff invite",
    text: [
      `Hello ${name},`,
      "",
      `You have been invited to Ochiga Office with the ${role || "viewer"} role.`,
      `Open this link to set your password and complete your account: ${inviteUrl}`,
      "",
      "If you did not expect this invite, ignore this message.",
    ].join("\n"),
    html: `<p>Hello ${name},</p><p>You have been invited to <strong>Ochiga Office</strong> with the <strong>${role || "viewer"}</strong> role.</p><p><a href="${inviteUrl}">Set up your account</a></p><p>If you did not expect this invite, ignore this message.</p>`,
  };
}

function facilityOwnerInviteEmail({ estateName, inviteUrl, expiresAt }) {
  const name = estateName || "your new Oyi Facility deployment";
  const expiry = expiresAt ? new Date(expiresAt).toUTCString() : "the expiry shown in your setup link";
  return {
    subject: `Activate ${name} on Oyi Facility`,
    text: [
      `Hello,`,
      "",
      `Ochiga has provisioned "${name}" as a new Oyi Facility deployment and needs you to activate it as the facility owner/administrator.`,
      `Open this link to set up your account and take ownership: ${inviteUrl}`,
      `This link expires ${expiry}.`,
      "",
      "If you were not expecting this, ignore this message.",
    ].join("\n"),
    html: `<p>Hello,</p><p>Ochiga has provisioned <strong>${name}</strong> as a new Oyi Facility deployment and needs you to activate it as the facility owner/administrator.</p><p><a href="${inviteUrl}">Activate your Facility</a></p><p style="color:#64748b;font-size:12px;">This link expires ${expiry}. If you were not expecting this, ignore this message.</p>`,
  };
}

function passwordResetEmail({ displayName, resetUrl }) {
  const name = displayName || "there";
  return {
    subject: "Reset your Ochiga Office password",
    text: [
      `Hello ${name},`,
      "",
      `Use this link to reset your Ochiga Office password: ${resetUrl}`,
      "",
      "If you did not request this reset, ignore this message.",
    ].join("\n"),
    html: `<p>Hello ${name},</p><p>Use this link to reset your Ochiga Office password:</p><p><a href="${resetUrl}">Reset password</a></p><p>If you did not request this reset, ignore this message.</p>`,
  };
}

// Settings S7.5.4: security notices about second-factor changes. Plain, generic wording: they name WHAT happened and WHEN, never a secret, code, token or hash.
const MFA_EVENT_TEXT = {
  enrolled: { subject: "Two-step verification was turned on", line: "Two-step verification was turned on for your Ochiga Office account." },
  factor_replaced: { subject: "Your two-step verification device was replaced", line: "The authenticator device on your Ochiga Office account was replaced." },
  factor_removed: { subject: "A two-step verification method was removed", line: "A two-step verification method was removed from your Ochiga Office account." },
  recovery_codes_regenerated: { subject: "Your recovery codes were regenerated", line: "Your Ochiga Office recovery codes were regenerated. Any earlier codes no longer work." },
  recovery_code_used: { subject: "A recovery code was used to sign in", line: "A recovery code was used to sign in to your Ochiga Office account. All your other sessions were signed out." },
};
function mfaSecurityEmail({ displayName, event, at }) {
  const name = displayName || "there"; const t = MFA_EVENT_TEXT[event] || { subject: "Security change on your account", line: "A security setting on your Ochiga Office account changed." };
  const when = at ? new Date(at).toUTCString() : "just now";
  return {
    subject: `Ochiga Office security: ${t.subject}`,
    text: [`Hello ${name},`, "", t.line, `When: ${when}`, "", "If this was you, no action is needed. If it was not you, change your password now and contact your Office administrator."].join("\n"),
    html: `<p>Hello ${name},</p><p>${t.line}</p><p>When: ${when}</p><p>If this was you, no action is needed. If it was not you, change your password now and contact your Office administrator.</p>`,
  };
}
function mfaMailboxCodeEmail({ displayName, code, minutes }) {
  const name = displayName || "there";
  return {
    subject: "Your Ochiga Office verification code",
    text: [`Hello ${name},`, "", `Your verification code for setting up two-step verification is: ${code}`, `It expires in ${minutes} minutes. Do not share it with anyone.`, "", "If you did not start this, ignore this message and tell your Office administrator."].join("\n"),
    html: `<p>Hello ${name},</p><p>Your verification code for setting up two-step verification is: <strong>${code}</strong></p><p>It expires in ${minutes} minutes. Do not share it with anyone.</p><p>If you did not start this, ignore this message and tell your Office administrator.</p>`,
  };
}

module.exports = {
  mfaMailboxCodeEmail,
  mfaSecurityEmail,
  facilityOwnerInviteEmail,
  passwordResetEmail,
  sendOfficeEmail,
  staffInviteEmail,
};
