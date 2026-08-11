const fs = require("fs/promises");
const path = require("path");

class FileTraceStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.pendingWrite = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      await fs.writeFile(this.filePath, "");
    }
  }

  async append(event) {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...event,
    });
    this.pendingWrite = this.pendingWrite.then(() =>
      fs.appendFile(this.filePath, `${line}\n`)
    );
    return this.pendingWrite;
  }

  async list(limit = 200) {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .slice(-limit)
        .reverse();
    } catch (error) {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }
}

module.exports = {
  FileTraceStore,
};
