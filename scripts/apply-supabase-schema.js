require("dotenv").config({ path: ".env.lead-agents.local", override: true });

const fs = require("fs/promises");
const path = require("path");
const { Client } = require("pg");

async function main() {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error("Missing SUPABASE_DB_URL in .env.lead-agents.local");
  }

  const sqlPath = path.join(process.cwd(), "db", "lead-agents-schema.sql");
  const sql = await fs.readFile(sqlPath, "utf8");

  const client = new Client({
    connectionString,
    ssl: {
      rejectUnauthorized: false,
    },
  });

  await client.connect();
  try {
    await client.query(sql);
    console.log(JSON.stringify({ ok: true, schema: "applied" }));
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
