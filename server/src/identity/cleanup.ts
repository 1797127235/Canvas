import type { Pool } from "pg";

import { withTransaction } from "../db.js";

export async function clearExpiredIdentityData(database: Pool) {
    await withTransaction(database, async (client) => {
        await client.query("DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP");
        await client.query("DELETE FROM identity_rate_limits WHERE expire IS NOT NULL AND expire <= $1", [Date.now()]);
    });
}
