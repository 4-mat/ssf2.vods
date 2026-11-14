const { Pool } = require("pg");

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined
});

async function initialize(initialData) {
    // Keep the original TSV row as a one-time backup. Never overwrite it.
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
        "SELECT COUNT(*)::INTEGER AS count FROM public.videos"
    );

    if(result.rows[0].count === 0) {
        throw new Error(
            "The normalized videos table is empty. Refusing to start without migrated video data."
        );
    }
}

async function loadMatchData() {
    const [videosResult, tagsResult, matchesResult] = await Promise.all([
        pool.query(`
            SELECT youtube_id, video_date, netplay, provisional_ip, netcode
            FROM public.videos
            ORDER BY source_order
        `),
        pool.query(`
            SELECT video_id, position, tag
            FROM public.video_tags
            ORDER BY video_id, position
        `),
        pool.query(`
            SELECT id, video_id, timestamp_seconds, p1_character, p1_name,
                   p2_character, p2_name, winner
            FROM public.matches
            ORDER BY video_id, timestamp_seconds, id
        `)
    ]);

    return {
        videos: videosResult.rows,
        tags: tagsResult.rows,
        matches: matchesResult.rows
    };
}

async function saveMatchData(data) {
    if(!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).length === 0) {
        throw new Error("Refusing to save an empty or invalid video collection.");
    }

    const videos = Object.entries(data);

    // Validate the complete payload before opening a transaction.
    for(const [videoId, video] of videos) {
        if(!video || typeof video !== "object" || !videoId) {
            throw new Error("Invalid video data; refusing to save.");
        }

        for(const match of (video.matches || [])) {
            const time = Number.parseInt(match.time, 10);
            const winner = Number.parseInt(match.winner, 10);

            if(!Number.isInteger(time) || time < 0) {
                throw new Error(`Invalid match timestamp for video ${videoId}.`);
            }
            if(winner !== 1 && winner !== 2) {
                throw new Error(
                    `Unsupported winner value "${match.winner}" for video ${videoId}. ` +
                    "The database currently permits only winner 1 or 2."
                );
            }
        }
    }

    const client = await pool.connect();
    const insertedIds = [];

    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(73521941)");

        const [videosResult, tagsResult, matchesResult] = await Promise.all([
            client.query(`
                SELECT youtube_id, video_date, netplay, provisional_ip, netcode, source_order
                FROM public.videos
                FOR UPDATE
            `),
            client.query(`
                SELECT video_id, position, tag
                FROM public.video_tags
                ORDER BY video_id, position
            `),
            client.query(`
                SELECT id, video_id, timestamp_seconds, p1_character, p1_name,
                       p2_character, p2_name, winner
                FROM public.matches
                FOR UPDATE
            `)
        ]);

        const existingVideos = new Map(
            videosResult.rows.map(row => [row.youtube_id, row])
        );
        const existingTags = new Map();
        const existingMatches = new Map(
            matchesResult.rows.map(row => [String(row.id), row])
        );
        const desiredVideoIds = new Set(videos.map(([id]) => id));
        const desiredMatchIds = new Set();
        const seenMatchIds = new Set();

        for(const row of tagsResult.rows) {
            if(!existingTags.has(row.video_id)) existingTags.set(row.video_id, []);
            existingTags.get(row.video_id).push(row.tag);
        }

        // Remove only videos no longer present. Their child rows cascade.
        for(const videoId of existingVideos.keys()) {
            if(!desiredVideoIds.has(videoId)) {
                await client.query(
                    "DELETE FROM public.videos WHERE youtube_id = $1",
                    [videoId]
                );
            }
        }

        for(let videoIndex = 0; videoIndex < videos.length; videoIndex++) {
            const [videoId, video] = videos[videoIndex];
            const date = video.date;
            const netplay = video.netplay;
            const provisionalIp = video.provIP || null;
            const netcode = video.netcode || "";
            const sourceOrder = videoIndex + 1;
            const oldVideo = existingVideos.get(videoId);

            if(!oldVideo) {
                await client.query(`
                    INSERT INTO public.videos
                        (youtube_id, video_date, netplay, provisional_ip, netcode, source_order)
                    VALUES ($1, $2, $3, $4, $5, $6)
                `, [videoId, date, netplay, provisionalIp, netcode, sourceOrder]);
            } else {
                const oldDate = oldVideo.video_date instanceof Date
                    ? oldVideo.video_date.toISOString().slice(0, 10)
                    : String(oldVideo.video_date).slice(0, 10);

                if(
                    oldDate !== String(date).slice(0, 10) ||
                    oldVideo.netplay !== netplay ||
                    oldVideo.provisional_ip !== provisionalIp ||
                    oldVideo.netcode !== netcode ||
                    Number(oldVideo.source_order) !== sourceOrder
                ) {
                    await client.query(`
                        UPDATE public.videos
                        SET video_date = $2,
                            netplay = $3,
                            provisional_ip = $4,
                            netcode = $5,
                            source_order = $6
                        WHERE youtube_id = $1
                    `, [videoId, date, netplay, provisionalIp, netcode, sourceOrder]);
                }
            }

            // Replace tags only when this video's tag list actually changed.
            const newTags = (video.tags || []).map(tag => String(tag).trim());
            const oldTags = existingTags.get(videoId) || [];
            const tagsChanged = oldTags.length !== newTags.length ||
                oldTags.some((tag, index) => tag !== newTags[index]);

            if(tagsChanged) {
                await client.query(
                    "DELETE FROM public.video_tags WHERE video_id = $1",
                    [videoId]
                );

                for(let i = 0; i < newTags.length; i++) {
                    await client.query(`
                        INSERT INTO public.video_tags (video_id, position, tag)
                        VALUES ($1, $2, $3)
                    `, [videoId, i + 1, newTags[i]]);
                }
            }

            for(const match of (video.matches || [])) {
                const values = [
                    Number.parseInt(match.time, 10),
                    match.p1char,
                    match.p1name,
                    match.p2char,
                    match.p2name,
                    Number.parseInt(match.winner, 10)
                ];

                if(match.id !== undefined && match.id !== null && match.id !== "") {
                    const matchId = String(match.id);
                    const oldMatch = existingMatches.get(matchId);

                    if(!oldMatch) {
                        throw new Error(
                            `Match ID ${matchId} for video ${videoId} no longer exists. Reload before saving.`
                        );
                    }
                    if(oldMatch.video_id !== videoId) {
                        throw new Error(
                            `Match ID ${matchId} does not belong to video ${videoId}.`
                        );
                    }
                    if(seenMatchIds.has(matchId)) {
                        throw new Error(`Duplicate match ID ${matchId} in save data.`);
                    }

                    seenMatchIds.add(matchId);
                    desiredMatchIds.add(matchId);

                    if(
                        Number(oldMatch.timestamp_seconds) !== values[0] ||
                        oldMatch.p1_character !== values[1] ||
                        oldMatch.p1_name !== values[2] ||
                        oldMatch.p2_character !== values[3] ||
                        oldMatch.p2_name !== values[4] ||
                        Number(oldMatch.winner) !== values[5]
                    ) {
                        await client.query(`
                            UPDATE public.matches
                            SET timestamp_seconds = $2,
                                p1_character = $3,
                                p1_name = $4,
                                p2_character = $5,
                                p2_name = $6,
                                winner = $7
                            WHERE id = $1 AND video_id = $8
                        `, [matchId, ...values, videoId]);
                    }
                } else {
                    const result = await client.query(`
                        INSERT INTO public.matches
                            (video_id, timestamp_seconds, p1_character, p1_name,
                             p2_character, p2_name, winner)
                        VALUES ($1, $2, $3, $4, $5, $6, $7)
                        RETURNING id
                    `, [videoId, ...values]);

                    insertedIds.push({
                        match,
                        id: String(result.rows[0].id)
                    });
                }
            }
        }

        // Delete only removed matches belonging to videos still in the app.
        for(const [matchId, oldMatch] of existingMatches) {
            if(
                desiredVideoIds.has(oldMatch.video_id) &&
                !desiredMatchIds.has(matchId)
            ) {
                await client.query(
                    "DELETE FROM public.matches WHERE id = $1",
                    [matchId]
                );
            }
        }

        await client.query("COMMIT");

        // Assign generated IDs only after the transaction succeeds.
        for(const item of insertedIds) {
            item.match.id = item.id;
        }
    } catch(error) {
        try {
            await client.query("ROLLBACK");
        } catch(rollbackError) {
            error.rollbackError = rollbackError;
        }
        throw error;
    } finally {
        client.release();
    }
}


async function loadAppData(key, fallback = null) {
    const result = await pool.query(
        "SELECT value FROM app_data WHERE key = $1",
        [key]
    );

    if(result.rows.length === 0) return fallback;

    try {
        return JSON.parse(result.rows[0].value);
    } catch(error) {
        throw new Error("Stored app data is invalid JSON for key: " + key);
    }
}

async function saveAppData(key, value) {
    await pool.query(
        `INSERT INTO app_data (key, value)
         VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, JSON.stringify(value)]
    );
}

module.exports = { initialize, loadMatchData, saveMatchData, loadAppData, saveAppData };
