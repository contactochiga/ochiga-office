const crypto = require("crypto");

function credentialPayloadForUser(user) {
  return JSON.stringify({
    system: "ochiga-office",
    type: "staff-credential",
    id: user.id || "",
    email: user.email || "",
    role: user.role || "viewer",
  });
}

function qrSvg(value, options = {}) {
  const size = Number(options.size || 144);
  const cells = Number(options.cells || 29);
  const margin = 4;
  const cell = size / (cells + margin * 2);
  const hash = crypto.createHash("sha256").update(String(value || "")).digest();
  const isDark = (x, y) => {
    const marker =
      (x < 7 && y < 7) ||
      (x >= cells - 7 && y < 7) ||
      (x < 7 && y >= cells - 7);
    if (marker) {
      const localX = x < 7 ? x : x - (cells - 7);
      const localY = y < 7 ? y : y - (cells - 7);
      return (
        localX === 0 ||
        localX === 6 ||
        localY === 0 ||
        localY === 6 ||
        (localX >= 2 && localX <= 4 && localY >= 2 && localY <= 4)
      );
    }
    const byte = hash[(x * 7 + y * 13 + x * y) % hash.length];
    return ((byte + x * 3 + y * 5) % 5) < 2;
  };
  const rects = [];
  for (let y = 0; y < cells; y += 1) {
    for (let x = 0; x < cells; x += 1) {
      if (!isDark(x, y)) continue;
      rects.push(
        `<rect x="${((x + margin) * cell).toFixed(2)}" y="${((y + margin) * cell).toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}" rx="${(cell * 0.08).toFixed(2)}"/>`
      );
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img"><rect width="100%" height="100%" fill="#fff"/><g fill="#0d5c46">${rects.join("")}</g></svg>`;
}

module.exports = {
  credentialPayloadForUser,
  qrSvg,
};
