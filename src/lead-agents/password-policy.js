"use strict";

// Settings S7.1: fixed, server-enforced password policy. Contract: docs/settings-domain/20_S7_1_PASSWORD_POLICY_CONTRACT.md
// Length in Unicode code points, no composition rules, no trimming or normalisation (the exact string is hashed, as login verifies it).
// The compromised-password check is entirely local; a password never leaves the process. Results carry a code only, never password material.

const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 128;

// Common passwords at least MIN length (shorter ones are already rejected by length). Compared lower-cased, and again with a trailing digit/symbol run stripped.
const COMMON_PASSWORDS = new Set([
  "password1234", "password12345", "password123456", "password1234567", "passw0rd1234", "p@ssw0rd1234", "p@ssword1234", "password!234", "passwordpassword",
  "123456789012", "1234567890123", "12345678901234", "123456123456", "123123123123", "111111111111", "000000000000", "012345678901", "987654321098", "098765432109",
  "qwertyuiop12", "qwertyuiopas", "qwertyuiop123", "qwertyuiopasdf", "qwertyuiop[]", "asdfghjkl123", "asdfghjklqwe", "zxcvbnm12345", "1qaz2wsx3edc", "1q2w3e4r5t6y", "qazwsxedcrfv", "zaq12wsxcde3", "1qazxsw23edc",
  "qwerty123456", "qwerty1234567", "qwertyqwerty", "abcdefghijkl", "abcdefg12345", "abcd12345678", "iloveyou1234", "iloveyouiloveyou", "iloveyou12345", "letmein123456", "letmeinletmein",
  "welcome12345", "welcome123456", "welcome1234567", "administrator", "administrator1", "administrator123", "admin1234567", "admin123456789", "adminadmin123", "adminpassword", "adminpassword1",
  "changeme1234", "changeme12345", "changemechangeme", "changemenow123", "defaultpassword", "defaultpassword1", "temporary1234", "temppassword123", "newpassword123", "newpassword1234",
  "monkey123456", "dragon123456", "football1234", "baseball1234", "superman1234", "trustno1trustno1", "sunshine1234", "princess1234", "mustang12345", "shadow123456", "master123456", "michael123456",
  "ochiga123456", "ochiga1234567", "ochigaoffice123", "ochigaoffice1234", "ochiga@123456", "office1234567", "officepassword", "office123456789", "oyi123456789", "oyipassword123",
  "lagos1234567", "nigeria12345", "nigeria123456", "naija1234567", "company12345", "company123456", "business12345", "summer2024!!", "winter2024!!!", "spring2024!!!", "autumn2024!!!",
  "thequickbrownfox", "correcthorsebatterystaple", "letmeinplease", "opensesame123", "opensesame1234", "passphrase1234", "mypassword1234", "mypassword123", "mypassword12345", "thisismypassword",
  "iamthebest1234", "123qwe123qwe", "qwe123qwe123", "aaaaaaaaaaaa", "q1w2e3r4t5y6", "1234qwer1234", "qwer1234qwer", "asdf1234asdf", "zxcv1234zxcv", "password-1234", "password_1234",
]);

const KEYBOARD_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm", "1234567890", "0987654321", "poiuytrewq", "lkjhgfdsa", "mnbvcxz"];
const COMMON_BASES = ["password", "passw0rd", "p@ssword", "p@ssw0rd", "qwerty", "letmein", "welcome", "admin", "administrator", "changeme", "iloveyou", "ochiga", "oyi", "office", "monkey", "dragon", "football", "baseball", "sunshine", "princess", "master", "login", "secret", "default"];

function codePoints(value) { return Array.from(value); }

function isRepeatedUnit(chars) {
  for (let unit = 1; unit <= 4; unit += 1) {
    if (chars.length % unit !== 0 && chars.length < unit * 3) continue;
    let repeated = true;
    for (let i = unit; i < chars.length; i += 1) if (chars[i] !== chars[i % unit]) { repeated = false; break; }
    if (repeated) return true;
  }
  return false;
}

function isSequentialRun(lower) {
  // whole value is a contiguous ascending/descending run of letters or digits, or a slice of a keyboard row
  if (lower.length < 6) return false;
  const codes = Array.from(lower).map((c) => c.codePointAt(0));
  let step = codes[1] - codes[0];
  if (Math.abs(step) === 1) {
    let all = true; for (let i = 1; i < codes.length; i += 1) if (codes[i] - codes[i - 1] !== step) { all = false; break; }
    if (all) return true;
  }
  return KEYBOARD_ROWS.some((row) => row.includes(lower));
}

function isCommon(password) {
  const lower = password.toLowerCase().normalize("NFKC");
  const chars = codePoints(lower);
  if (COMMON_PASSWORDS.has(lower)) return true;
  if (isRepeatedUnit(chars)) return true;
  if (isSequentialRun(lower)) return true;
  // common word (optionally doubled) followed only by digits/symbols, e.g. "Password2024!!!"
  const stripped = lower.replace(/[\d\s!@#$%^&*()_+=.,?\-]+$/u, "");
  if (stripped !== lower && COMMON_PASSWORDS.has(stripped)) return true;
  const leetless = stripped.replace(/0/g, "o").replace(/@/g, "a").replace(/\$/g, "s").replace(/1/g, "l").replace(/3/g, "e");
  for (const base of COMMON_BASES) {
    const b = base.replace(/0/g, "o").replace(/@/g, "a");
    if (leetless === b || leetless === b + b) return true;
    if (stripped === base || stripped === base + base) return true;
  }
  // leading common base + only digits/symbols (>= 12 total is already enforced)
  for (const base of COMMON_BASES) {
    if (lower.startsWith(base) && /^[\d\s!@#$%^&*()_+=.,?\-]*$/u.test(lower.slice(base.length)) && lower.length - base.length <= 8) return true;
  }
  return false;
}

/** Returns { valid: true } or { valid: false, code }. Never includes password material. */
function validatePassword(password) {
  if (typeof password !== "string" || password.length === 0) return { valid: false, code: "password_required" };
  if (/[\p{Cc}\p{Cs}]/u.test(password.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")) ) return { valid: false, code: "password_invalid_characters" };
  const length = codePoints(password).length;
  if (length > MAX_PASSWORD_LENGTH) return { valid: false, code: "password_too_long" };
  if (!password.trim()) return { valid: false, code: "password_blank" };
  if (length < MIN_PASSWORD_LENGTH) return { valid: false, code: "password_too_short" };
  if (isCommon(password)) return { valid: false, code: "password_too_common" };
  return { valid: true };
}

const MESSAGES = {
  password_required: "A password is required.",
  password_too_short: `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`,
  password_too_long: `Use a password of at most ${MAX_PASSWORD_LENGTH} characters.`,
  password_blank: "The password cannot be blank.",
  password_invalid_characters: "The password contains characters that are not allowed.",
  password_too_common: "That password is too common or easy to guess. Choose a longer, less predictable passphrase.",
};

/** Shared HTTP error payload for a failed policy check. */
function passwordPolicyError(code) {
  return {
    error: "password_policy_violation",
    code,
    message: MESSAGES[code] || "The password does not meet the policy.",
    policy: { min_length: MIN_PASSWORD_LENGTH, max_length: MAX_PASSWORD_LENGTH },
  };
}

module.exports = { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH, validatePassword, passwordPolicyError };
