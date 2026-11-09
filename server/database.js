const { Pool } = require("pg");

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined
});

async function initialize(initialData) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS app_data (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    `);

    await pool.query(
        `INSERT INTO app_data (key, value)
         VALUES ($1, $2)
         ON CONFLICT (key) DO NOTHING`,
        ["match_data", initialData]
    );

    const result = await pool.query(
        "SELECT value FROM app_data WHERE key = $1",
        ["match_data"]
    );

    return result.rows[0].value;
}

async function saveMatchData(data) {
    await pool.query(
        `INSERT INTO app_data (key, value)
         VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        ["match_data", data]
    );
}

module.exports = { initialize, saveMatchData };
