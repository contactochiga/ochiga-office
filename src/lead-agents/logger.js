function log(level, event, fields = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };

  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
    return;
  }
  console.log(line);
}

module.exports = {
  log,
};
