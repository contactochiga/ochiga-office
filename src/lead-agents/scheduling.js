const MONTHS = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

const WEEKDAYS = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const TIMEZONE_ALIASES = {
  nigeria: "Africa/Lagos",
  lagos: "Africa/Lagos",
  abuja: "Africa/Lagos",
  wat: "Africa/Lagos",
  "west africa time": "Africa/Lagos",
  "africa/lagos": "Africa/Lagos",
};

const TIMEZONE_OFFSETS = {
  "Africa/Lagos": "+01:00",
  UTC: "+00:00",
};

function pad(value) {
  return String(value).padStart(2, "0");
}

function normalizeTimezone(value, fallback = "") {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  const lowered = raw.toLowerCase();
  return TIMEZONE_ALIASES[lowered] || raw;
}

function extractTimezone(text, fallback = "") {
  const lowered = String(text || "").toLowerCase();
  for (const key of Object.keys(TIMEZONE_ALIASES)) {
    if (lowered.includes(key)) {
      return TIMEZONE_ALIASES[key];
    }
  }
  return normalizeTimezone(fallback, fallback);
}

function parseTimeParts(text) {
  const match = String(text || "").match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || "0");
  const meridiem = String(match[3] || "").toLowerCase();

  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;

  return { hour, minute };
}

function parseDateParts(text, now = new Date()) {
  const value = String(text || "").toLowerCase();
  const weekdayMatch = value.match(
    /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/
  );
  const monthNames = Object.keys(MONTHS).join("|");
  const explicitDateMatch = value.match(
    new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthNames})(?:\\s+(\\d{4}))?`, "i")
  );

  if (explicitDateMatch) {
    const day = Number(explicitDateMatch[1]);
    const month = MONTHS[String(explicitDateMatch[2] || "").toLowerCase()];
    let year = Number(explicitDateMatch[3] || now.getFullYear());
    let candidate = new Date(Date.UTC(year, month, day));
    if (candidate.getTime() < now.getTime() - 24 * 60 * 60 * 1000) {
      year += 1;
      candidate = new Date(Date.UTC(year, month, day));
    }
    return {
      year,
      month,
      day,
      weekday: weekdayMatch ? WEEKDAYS[String(weekdayMatch[1]).toLowerCase()] : null,
    };
  }

  if (weekdayMatch) {
    const weekday = WEEKDAYS[String(weekdayMatch[1]).toLowerCase()];
    const candidate = new Date(now);
    const currentWeekday = candidate.getDay();
    let delta = weekday - currentWeekday;
    if (delta < 0) delta += 7;
    candidate.setDate(candidate.getDate() + delta);
    return {
      year: candidate.getFullYear(),
      month: candidate.getMonth(),
      day: candidate.getDate(),
      weekday,
    };
  }

  if (value.includes("tomorrow")) {
    const candidate = new Date(now);
    candidate.setDate(candidate.getDate() + 1);
    return {
      year: candidate.getFullYear(),
      month: candidate.getMonth(),
      day: candidate.getDate(),
      weekday: candidate.getDay(),
    };
  }

  if (value.includes("today")) {
    return {
      year: now.getFullYear(),
      month: now.getMonth(),
      day: now.getDate(),
      weekday: now.getDay(),
    };
  }

  return null;
}

function toIsoWithOffset(parts, timezone) {
  const offset = TIMEZONE_OFFSETS[timezone] || "+00:00";
  return `${parts.year}-${pad(parts.month + 1)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(
    parts.minute
  )}:00${offset}`;
}

function formatScheduleDisplay(isoString, timezone, preferredText) {
  if (!isoString) {
    return preferredText || "Preferred time noted";
  }
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return preferredText || isoString;
  }
  const formatted = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone || "UTC",
    timeZoneName: "short",
  }).format(date);
  return formatted;
}

function buildCalendarLinks({ title, description, location, startIso, timezone }) {
  if (!startIso) {
    return {};
  }
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) {
    return {};
  }
  const end = new Date(start.getTime() + 45 * 60 * 1000);
  const compact = (date) =>
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(
      date.getUTCHours()
    )}${pad(date.getUTCMinutes())}00Z`;

  const safeTitle = encodeURIComponent(title || "Ochiga Discovery Demo");
  const safeDescription = encodeURIComponent(description || "");
  const safeLocation = encodeURIComponent(location || "");

  return {
    google: `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${safeTitle}&dates=${compact(
      start
    )}/${compact(end)}&details=${safeDescription}&location=${safeLocation}`,
    outlook: `https://outlook.live.com/calendar/0/deeplink/compose?path=/calendar/action/compose&rru=addevent&subject=${safeTitle}&startdt=${encodeURIComponent(
      startIso
    )}&enddt=${encodeURIComponent(end.toISOString())}&body=${safeDescription}&location=${safeLocation}`,
    timezone: timezone || "UTC",
  };
}

function parsePreferredSchedule({ text, timezoneHint = "", now = new Date() }) {
  const preferredText = String(text || "").trim();
  const timezone = extractTimezone(preferredText, timezoneHint || "Africa/Lagos") || "Africa/Lagos";
  const dateParts = parseDateParts(preferredText, now);
  const timeParts = parseTimeParts(preferredText);

  if (!dateParts || !timeParts) {
    return {
      preferred_text: preferredText,
      timezone,
      scheduled_for: null,
      display_text: preferredText,
      parsed: false,
    };
  }

  const scheduled_for = toIsoWithOffset(
    {
      year: dateParts.year,
      month: dateParts.month,
      day: dateParts.day,
      hour: timeParts.hour,
      minute: timeParts.minute,
    },
    timezone
  );

  return {
    preferred_text: preferredText,
    timezone,
    scheduled_for,
    display_text: formatScheduleDisplay(scheduled_for, timezone, preferredText),
    parsed: true,
  };
}

module.exports = {
  buildCalendarLinks,
  extractTimezone,
  formatScheduleDisplay,
  normalizeTimezone,
  parsePreferredSchedule,
};
