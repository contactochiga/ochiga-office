const fs = require("fs/promises");
const path = require("path");

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

class FileKnowledgeBase {
  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir);
    this.documents = [];
  }

  async init() {
    await fs.mkdir(this.rootDir, { recursive: true });
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);

    const docs = [];
    for (const fileName of files) {
      const fullPath = path.join(this.rootDir, fileName);
      const raw = await fs.readFile(fullPath, "utf8");
      docs.push(...this.chunkDocument(fileName, raw));
    }

    this.documents = docs;
  }

  chunkDocument(fileName, raw) {
    return raw
      .split(/\n\s*\n/)
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .map((chunk, index) => ({
        id: `${fileName}:${index + 1}`,
        file: fileName,
        text: chunk,
        terms: tokenize(chunk),
      }));
  }

  search(query, limit = 6) {
    const terms = tokenize(query);
    if (terms.length === 0) {
      return [];
    }

    return this.documents
      .map((doc) => ({
        ...doc,
        score: terms.reduce(
          (sum, term) => sum + (doc.terms.includes(term) ? 1 : 0),
          0
        ),
      }))
      .filter((doc) => doc.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((doc) => ({
        id: doc.id,
        file: doc.file,
        score: doc.score,
        text: doc.text,
      }));
  }

  serializeForPrompt(results) {
    if (!results || results.length === 0) {
      return "No relevant knowledge snippets found.";
    }

    return results
      .map(
        (item) =>
          `[${item.file}] ${item.text.replace(/\s+/g, " ").trim()}`
      )
      .join("\n");
  }
}

module.exports = {
  FileKnowledgeBase,
};
