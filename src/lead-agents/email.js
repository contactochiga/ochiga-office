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

module.exports = {
  facilityOwnerInviteEmail,
  passwordResetEmail,
  sendOfficeEmail,
  staffInviteEmail,
};
