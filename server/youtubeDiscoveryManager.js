const fs = require("fs");
const path = require("path");
const database = require("./database.js");

const STORAGE_KEY = "youtube_discovery_candidates";
const ROTATION_STORAGE_KEY = "youtube_discovery_rotation";
const DISCOVERED_PLAYERS_STORAGE_KEY = "youtube_discovery_players";
const CHALLONGE_CACHE_STORAGE_KEY = "youtube_discovery_challonge_cache";
const DEFAULT_PLAYER_BATCH_SIZE = 3;
const DEFAULT_DATE_BATCH_SIZE = 30;

function YouTubeDiscoveryManager(server) {
	this.server = server;
	this.filename = path.join("data", "youtube-discovery.json");
	this.rotationFilename = path.join("data", "youtube-discovery-state.json");
	this.discoveredPlayersFilename = path.join("data", "youtube-discovery-players.json");
	this.seedsFilename = path.join("data", "youtube-discovery-seeds.json");
	this.challongeCacheFilename = path.join("data", "youtube-discovery-challonge-cache.json");
	this.challongeCache = {};

	this.apiKeys = [
		...(process.env.YOUTUBE_API_KEYS || "").split(/[,\n]/),
		process.env.YOUTUBE_API_KEY || ""
	].map(key => key.trim()).filter((key, index, keys) => key && keys.indexOf(key) === index);

	this.apiKey = this.apiKeys[0] || "";
	this.activeKeyIndex = 0;

	this.interval = Number(
		process.env.YOUTUBE_DISCOVERY_INTERVAL_MS ||
		server.cfg.youtubeDiscoveryIntervalMs ||
		6 * 60 * 60 * 1000
	);

	this.playerBatchSize = Number(
		process.env.YOUTUBE_DISCOVERY_PLAYER_BATCH_SIZE ||
		server.cfg.youtubeDiscoveryPlayerBatchSize ||
		DEFAULT_PLAYER_BATCH_SIZE
	);

	if(!Number.isInteger(this.playerBatchSize) || this.playerBatchSize < 1) {
		this.playerBatchSize = DEFAULT_PLAYER_BATCH_SIZE;
	}
	this.playerBatchSize = Math.min(this.playerBatchSize, 10);

	this.candidates = {};
	this.seeds = null;
	this.players = [];
	this.seedPlayers = [];
	this.discoveredPlayers = [];
	this.rotation = { cursor: 0 };
	this.timer = null;
	this.scanning = false;
}

YouTubeDiscoveryManager.prototype.load = async function() {
	if(process.env.DATABASE_URL) {
		this.candidates = await database.loadAppData(STORAGE_KEY, {});
		this.rotation = await database.loadAppData(
			ROTATION_STORAGE_KEY,
			{ cursor: 0 }
		);
		this.challongeCache = await database.loadAppData(
			CHALLONGE_CACHE_STORAGE_KEY,
			{}
		);
	} else {
		if(fs.existsSync(this.filename)) {
			this.candidates = JSON.parse(fs.readFileSync(this.filename, "utf8"));
		} else {
			this.candidates = {};
		}

		if(fs.existsSync(this.rotationFilename)) {
			this.rotation = JSON.parse(
				fs.readFileSync(this.rotationFilename, "utf8")
			);
		}
		if(fs.existsSync(this.challongeCacheFilename)) {
			this.challongeCache = JSON.parse(
				fs.readFileSync(this.challongeCacheFilename, "utf8")
			);
		}
	}

	if(!this.challongeCache ||
		typeof this.challongeCache !== "object" ||
		Array.isArray(this.challongeCache)) {
		this.challongeCache = {};
	}

	if(!this.candidates ||
		typeof this.candidates !== "object" ||
		Array.isArray(this.candidates)) {
		throw new Error("YouTube discovery storage must contain a JSON object.");
	}

	if(!this.rotation ||
		typeof this.rotation !== "object" ||
		!Number.isInteger(this.rotation.cursor) ||
		this.rotation.cursor < 0) {
		this.rotation = { cursor: 0 };
	}

	// Date processing has independent cursors for recent and older uploads.
	if(!Number.isInteger(this.rotation.dateCursor) ||
		this.rotation.dateCursor < 0) {
		this.rotation.dateCursor = 0;
	}

	if(!Number.isInteger(this.rotation.date2026Cursor) ||
		this.rotation.date2026Cursor < 0) {
		this.rotation.date2026Cursor = 0;
	}

	if(!fs.existsSync(this.seedsFilename)) {
		throw new Error("YouTube discovery ranking seed file was not found.");
	}

	this.seeds = JSON.parse(fs.readFileSync(this.seedsFilename, "utf8"));

	if(!Array.isArray(this.seeds.players)) {
		throw new Error("YouTube discovery ranking seed file has no players array.");
	}

	this.seedPlayers = this.seeds.players
		.filter(player => player && typeof player.name === "string" && player.name.trim())
		.map(player => ({
			name: player.name.trim(),
			aliases: Array.isArray(player.aliases)
				? player.aliases.filter(alias => typeof alias === "string" && alias.trim()).map(alias => alias.trim())
				: []
		}));

	if(process.env.DATABASE_URL) {
		this.discoveredPlayers = await database.loadAppData(
			DISCOVERED_PLAYERS_STORAGE_KEY,
			[]
		);
	} else if(fs.existsSync(this.discoveredPlayersFilename)) {
		this.discoveredPlayers = JSON.parse(
			fs.readFileSync(this.discoveredPlayersFilename, "utf8")
		);
	} else {
		this.discoveredPlayers = [];
	}

	if(!Array.isArray(this.discoveredPlayers)) {
		throw new Error("Discovered-player storage must contain an array.");
	}

	this.discoveredPlayers = this.discoveredPlayers
		.filter(player => player && typeof player.name === "string" && player.name.trim())
		.map(player => ({
			name: player.name.trim(),
			aliases: Array.isArray(player.aliases)
				? player.aliases.filter(alias => typeof alias === "string" && alias.trim()).map(alias => alias.trim())
				: []
		}));

	const knownNames = new Set();
	this.players = [];

	for(const player of [...this.seedPlayers, ...this.discoveredPlayers]) {
		const names = [player.name, ...player.aliases]
			.map(name => name.toLowerCase());

		if(names.some(name => knownNames.has(name))) continue;

		names.forEach(name => knownNames.add(name));
		this.players.push(player);
	}

	if(this.players.length) {
		this.rotation.cursor %= this.players.length;
	}
};

YouTubeDiscoveryManager.prototype.save = async function() {
	if(process.env.DATABASE_URL) {
		await database.saveAppData(STORAGE_KEY, this.candidates);
		return;
	}

	fs.mkdirSync(path.dirname(this.filename), { recursive: true });

	const temporaryFile = this.filename + ".tmp";
	fs.writeFileSync(temporaryFile, JSON.stringify(this.candidates, null, 2));
	fs.renameSync(temporaryFile, this.filename);
};

YouTubeDiscoveryManager.prototype.saveChallongeCache = async function() {
	if(process.env.DATABASE_URL) {
		await database.saveAppData(CHALLONGE_CACHE_STORAGE_KEY, this.challongeCache);
		return;
	}
	fs.mkdirSync(path.dirname(this.challongeCacheFilename), { recursive: true });
	const temporaryFile = this.challongeCacheFilename + ".tmp";
	fs.writeFileSync(temporaryFile, JSON.stringify(this.challongeCache, null, 2));
	fs.renameSync(temporaryFile, this.challongeCacheFilename);
};

YouTubeDiscoveryManager.prototype.saveRotation = async function() {
	if(process.env.DATABASE_URL) {
		await database.saveAppData(ROTATION_STORAGE_KEY, this.rotation);
		return;
	}

	fs.mkdirSync(path.dirname(this.rotationFilename), { recursive: true });

	const temporaryFile = this.rotationFilename + ".tmp";
	fs.writeFileSync(temporaryFile, JSON.stringify(this.rotation, null, 2));
	fs.renameSync(temporaryFile, this.rotationFilename);
};

YouTubeDiscoveryManager.prototype.resetDiscovery = async function() {
	if(this.scanning) {
		throw new Error("A discovery scan is currently running.");
	}

	this.scanning = true;

	const previousCandidates = this.candidates;
	const previousRotation = this.rotation;

	try {
		this.candidates = {};
		this.rotation = {
			...this.rotation,
			cursor: 0,
			dateCursor: 0,
			date2026Cursor: 0
		};

		await this.save();
		await this.saveRotation();

		return { cleared: true };
	} catch(error) {
		this.candidates = previousCandidates;
		this.rotation = previousRotation;

		const rollback = await Promise.allSettled([
			this.save(),
			this.saveRotation()
		]);
		const rollbackErrors = rollback
			.filter(result => result.status === "rejected")
			.map(result => result.reason.message);

		if(rollbackErrors.length) {
			throw new Error(
				"Reset failed: " + error.message +
				"; restoring previous data also failed: " +
				rollbackErrors.join("; ")
			);
		}

		throw error;
	} finally {
		this.scanning = false;
	}
};

YouTubeDiscoveryManager.prototype.saveDiscoveredPlayers = async function() {
	if(process.env.DATABASE_URL) {
		await database.saveAppData(
			DISCOVERED_PLAYERS_STORAGE_KEY,
			this.discoveredPlayers
		);
		return;
	}

	fs.mkdirSync(path.dirname(this.discoveredPlayersFilename), { recursive: true });

	const temporaryFile = this.discoveredPlayersFilename + ".tmp";
	fs.writeFileSync(temporaryFile, JSON.stringify(this.discoveredPlayers, null, 2));
	fs.renameSync(temporaryFile, this.discoveredPlayersFilename);
};

YouTubeDiscoveryManager.prototype.addDiscoveredPlayer = function(name) {
	if(typeof name !== "string" || !name.trim()) return false;

	const normalized = name.trim().toLowerCase();

	for(const player of this.players) {
		const names = [player.name, ...(player.aliases || [])];
		if(names.some(known =>
			typeof known === "string" && known.trim().toLowerCase() === normalized
		)) return false;
	}

	const player = { name: name.trim(), aliases: [] };
	this.discoveredPlayers.push(player);
	this.players.push(player);
	return true;
};

YouTubeDiscoveryManager.prototype.getPlayerQuery = function(player) {
	const names = [player.name, ...(player.aliases || [])]
		.filter(name => typeof name === "string" && name.trim())
		.map(name => name.trim())
		.filter((name, index, all) =>
			all.findIndex(other => other.toLowerCase() === name.toLowerCase()) === index
		);

	const quotedNames = names.map(name =>
		'"' + name.replace(/["\\]/g, "\\$&") + '"'
	);

	return "SSF2 " + quotedNames.join("|");
};

YouTubeDiscoveryManager.prototype.getNextPlayerBatch = function() {
	if(!this.players.length) return [];

	const count = Math.min(this.playerBatchSize, this.players.length);
	const batch = [];

	for(let offset = 0; offset < count; offset++) {
		const index = (this.rotation.cursor + offset) % this.players.length;
		batch.push({
			player: this.players[index],
			index,
			query: this.getPlayerQuery(this.players[index])
		});
	}

	return batch;
};

YouTubeDiscoveryManager.prototype.extractOpponentName = function(title, player) {
	if(!player || !player.name) return null;

	const text = String(title || "");
	const match = text.match(/\b(?:vs\.?|versus)\b/i);

	if(!match || match.index === undefined) return null;

	const left = text.slice(0, match.index);
	const right = text.slice(match.index + match[0].length);

	const containsName = (side, name) => {
		const haystack = String(side || "").toLowerCase();
		const needle = String(name || "").trim().toLowerCase();

		if(!needle) return false;

		let index = haystack.indexOf(needle);

		while(index !== -1) {
			const before = index > 0 ? haystack[index - 1] : "";
			const afterIndex = index + needle.length;
			const after = afterIndex < haystack.length ? haystack[afterIndex] : "";

			const beforeIsWord = before && /[a-z0-9]/i.test(before);
			const afterIsWord = after && /[a-z0-9]/i.test(after);

			if(!beforeIsWord && !afterIsWord) return true;
			index = haystack.indexOf(needle, index + 1);
		}

		return false;
	};

	const names = [player.name].concat(
		Array.isArray(player.aliases) ? player.aliases : []
	);

	const onLeft = names.some(name => containsName(left, name));
	const onRight = names.some(name => containsName(right, name));

	if(onLeft === onRight) return null;

	let opponentSide = onLeft ? right : left;

	// Remove the searched player's own name, including aliases.
	for(const name of names) {
		if(typeof name !== "string" || !name.trim()) continue;

		const needle = name.trim().toLowerCase();
		let lowerSide = opponentSide.toLowerCase();
		let index = lowerSide.indexOf(needle);

		while(index !== -1) {
			const before = index > 0 ? lowerSide[index - 1] : "";
			const afterIndex = index + needle.length;
			const after = afterIndex < lowerSide.length ? lowerSide[afterIndex] : "";
			const beforeIsWord = before && /[a-z0-9]/i.test(before);
			const afterIsWord = after && /[a-z0-9]/i.test(after);

			if(!beforeIsWord && !afterIsWord) {
				opponentSide =
					opponentSide.slice(0, index) +
					" " +
					opponentSide.slice(afterIndex);
				lowerSide = opponentSide.toLowerCase();
				index = lowerSide.indexOf(needle);
			} else {
				index = lowerSide.indexOf(needle, index + 1);
			}
		}
	}

	opponentSide = opponentSide
		.replace(/\s+(?:-|\||–|—)\s+.+$/, " ")
		.replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
		.replace(/\b(super smash flash 2|ssf2|replay|match|tournament|grand finals|winners finals|losers finals|top 8|set|gameplay|highlights|commentary|vod|full game)\b/gi, " ")
		.replace(/&amp;/gi, " ")
		.replace(/#[\w-]+/g, " ")
		.replace(/[^a-z0-9_. -]/gi, " ")
		.replace(/\s+/g, " ")
		.trim();

	if(!opponentSide || opponentSide.length > 40) return null;

	const tokens = opponentSide.split(" ");
	const noise = new Set([
		"the", "and", "vs", "versus", "game", "player",
		"unknown", "cpu", "computer", "gameplay", "replay",
		"winner", "loser", "finals", "tournament", "highlights",
		"commentary", "vod", "top", "set"
	]);

	if(tokens.length > 3) return null;

	if(!tokens.every(token =>
		/^[a-z0-9][a-z0-9_.-]{1,23}$/i.test(token) &&
		!noise.has(token.toLowerCase())
	)) return null;

	return opponentSide;
};

YouTubeDiscoveryManager.prototype.hasNamedMatchup = function(title, player) {
	return Boolean(this.extractOpponentName(title, player));
};

YouTubeDiscoveryManager.prototype.classify = function(title, description, player) {

    const text = String(title || "") + " " + String(description || "");

    const excluded = /\b(soundtrack|official audio|ost|tier list|character showcase|mod(?:s|ding)?|mod showcase|reaction video|review of the game|how to install|installation guide|potd|picture of the day|remaster|recreation|stage showcase|build showcase)\b/i;

    if(excluded.test(text)) return null;

    const mentionsGame = /\b(ssf2|super smash flash 2)\b/i.test(text);

    const mentionsMatch = /\b(replay|match|versus|vs\.?|tournament|bracket|grand finals|winners finals|losers finals|top 8|sets?)\b/i.test(text);

    if(!mentionsGame || !mentionsMatch) return "review";

    // Only a ranked-player search can produce an automatic classification.
    if(this.hasNamedMatchup(title, player)) return "automatic";

    return "review";
};

YouTubeDiscoveryManager.prototype.search = async function(term) {
	if(!this.apiKeys.length) {
		throw new Error("No YouTube API keys are configured.");
	}

	const invalidKeyReasons = new Set([
		"keyInvalid",
		"apiKeyNotValid",
		"ipRefererBlocked",
		"refererNotAllowed",
		"accessNotConfigured"
	]);

	for(let offset = 0; offset < this.apiKeys.length; offset++) {
		const index = (this.activeKeyIndex + offset) % this.apiKeys.length;
		const params = new URLSearchParams({
			part: "snippet",
			type: "video",
			maxResults: "25",
			order: "date",
			q: term,
			key: this.apiKeys[index]
		});

		const response = await fetch(
			["https:", "", "www.googleapis.com", "youtube", "v3", "search"].join("/") +
			"?" + params.toString()
		);

		let result;
		try {
			result = await response.json();
		} catch(error) {
			throw new Error("YouTube returned an unreadable API response.");
		}

		const reasons = result.error && Array.isArray(result.error.errors)
			? result.error.errors.map(error => error.reason)
			: [];

		if(reasons.some(reason =>
			reason === "quotaExceeded" || reason === "dailyLimitExceeded"
		)) {
			throw new Error(
				"YouTube API quota is exhausted. Discovery has stopped; retry after the quota reset."
			);
		}

		if(reasons.some(reason => invalidKeyReasons.has(reason))) {
			continue;
		}

		if(!response.ok || result.error) {
			const error = new Error(
				"YouTube search request failed with HTTP " + response.status + "."
			);
			error.status = response.status;
			throw error;
		}

		this.activeKeyIndex = index;
		return result.items || [];
	}

	throw new Error("All configured YouTube API keys are invalid or misconfigured.");
};


function youtubeDurationSeconds(value) {
	const match = String(value || "").match(
		/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i
	);
	if(!match) return null;

	return Number(match[1] || 0) * 86400 +
		Number(match[2] || 0) * 3600 +
		Number(match[3] || 0) * 60 +
		Number(match[4] || 0);
}

YouTubeDiscoveryManager.prototype.fetchVideoDetails = async function(videoIds) {
	if(!this.apiKeys.length) {
		throw new Error("No YouTube API keys are configured.");
	}

	const ids = [...new Set(videoIds)].slice(0, 50);
	if(!ids.length) return [];

	const invalidKeyReasons = new Set([
		"keyInvalid", "apiKeyNotValid", "ipRefererBlocked",
		"refererNotAllowed", "accessNotConfigured"
	]);

	for(let offset = 0; offset < this.apiKeys.length; offset++) {
		const index = (this.activeKeyIndex + offset) % this.apiKeys.length;
		const params = new URLSearchParams({
			part: "snippet,contentDetails,liveStreamingDetails",
			id: ids.join(","),
			key: this.apiKeys[index]
		});

		const response = await fetch(
			["https:", "", "www.googleapis.com", "youtube", "v3", "videos"].join("/") +
			"?" + params.toString()
		);

		let result;
		try {
			result = await response.json();
		} catch(error) {
			throw new Error("YouTube returned an unreadable video metadata response.");
		}

		const reasons = result.error && Array.isArray(result.error.errors)
			? result.error.errors.map(error => error.reason)
			: [];

		if(reasons.some(reason =>
			reason === "quotaExceeded" || reason === "dailyLimitExceeded"
		)) {
			throw new Error(
				"YouTube API quota is exhausted. Discovery has stopped; retry after the quota reset."
			);
		}

		if(reasons.some(reason => invalidKeyReasons.has(reason))) continue;

		if(!response.ok || result.error) {
			throw new Error(
				"YouTube video metadata request failed with HTTP " + response.status + "."
			);
		}

		this.activeKeyIndex = index;
		return Array.isArray(result.items) ? result.items : [];
	}

	throw new Error("All configured YouTube API keys are invalid or misconfigured.");
};

YouTubeDiscoveryManager.prototype.enrichCandidates = async function(limit = 50) {
	const pending = Object.values(this.candidates)
		.filter(candidate => candidate && !candidate.enrichment)
		.slice(0, Math.min(50, Math.max(1, limit)));

	if(!pending.length) {
		return {
			enrichmentChecked: 0,
			enrichmentAvailable: 0,
			enrichmentUnavailable: 0,
			enrichmentRemaining: 0
		};
	}

	const items = await this.fetchVideoDetails(pending.map(candidate => candidate.id));
	const found = new Map(items.map(item => [item.id, item]));
	const retrievedAt = new Date().toISOString();

	let available = 0;
	let unavailable = 0;

	for(const candidate of pending) {
		const item = found.get(candidate.id);

		if(!item) {
			candidate.enrichment = {
				version: 1,
				status: "unavailable",
				retrievedAt
			};
			unavailable++;
			continue;
		}

		const snippet = item.snippet || {};
		const details = item.contentDetails || {};
		const live = item.liveStreamingDetails || {};

		candidate.enrichment = {
			version: 1,
			status: "available",
			retrievedAt,
			duration: details.duration || null,
			durationSeconds: youtubeDurationSeconds(details.duration),
			tags: Array.isArray(snippet.tags) ? snippet.tags : [],
			categoryId: snippet.categoryId || null,
			liveBroadcastContent: snippet.liveBroadcastContent || "none",
			captionAvailable: details.caption === "true",
			dimension: details.dimension || null,
			definition: details.definition || null,
			projection: details.projection || null,
			defaultLanguage: snippet.defaultLanguage || null,
			defaultAudioLanguage: snippet.defaultAudioLanguage || null,
			scheduledStartTime: live.scheduledStartTime || null,
			actualStartTime: live.actualStartTime || null,
			actualEndTime: live.actualEndTime || null
		};

		available++;
	}

	return {
		enrichmentChecked: pending.length,
		enrichmentAvailable: available,
		enrichmentUnavailable: unavailable,
		enrichmentRemaining: Object.values(this.candidates)
			.filter(candidate => candidate && !candidate.enrichment).length
	};
};

YouTubeDiscoveryManager.prototype.addSearchResults = function(items, term, summary, player) {
	const addedIds = [];

	for(const item of items) {
		summary.resultsChecked++;

		const videoId = item.id && item.id.videoId;
		const snippet = item.snippet || {};

		if(!videoId || this.server.games[videoId] || this.candidates[videoId]) {
			summary.duplicates++;
			continue;
		}

		const status = this.classify(snippet.title, snippet.description, player);
		const opponentName = status === "automatic" && player
			? this.extractOpponentName(snippet.title, player)
			: null;
		if(!status) {
			summary.excluded++;
			continue;
		}

		this.candidates[videoId] = {
			id: videoId,
			title: snippet.title || "",
			description: snippet.description || "",
			channelTitle: snippet.channelTitle || "",
			channelId: snippet.channelId || "",
			publishedAt: snippet.publishedAt || null,
			thumbnail: snippet.thumbnails && (
				snippet.thumbnails.medium ||
				snippet.thumbnails.default
			) ? (
				snippet.thumbnails.medium || snippet.thumbnails.default
			).url : "",
			searchTerm: term,
			matchedPlayer: player ? player.name : null,
			opponentName,
			status,
			discoveredAt: new Date().toISOString()
		};

		addedIds.push(videoId);
		summary[status]++;
		if(opponentName && this.addDiscoveredPlayer(opponentName)) {
			summary.opponentsDiscovered++;
		}
	}

	return addedIds;
};

function cleanDiscoveryText(value) {
	return String(value || "")
		.replace(/<[^>]*>/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&#x27;|&#39;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&nbsp;/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function tournamentWords(value) {
	return String(value || "").toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.split(/\s+/)
		.filter(word => word.length > 2 && ![
			"super", "smash", "flash", "tournament", "challonge",
			"ssf2", "replay", "vod", "match", "gameplay", "series",
			"event", "bracket", "weekly", "biweekly", "monthly",
			"round", "rounds", "winners", "winner", "losers",
			"loser", "finals", "final", "semis", "quarters",
			"pools", "pool", "top", "grand", "ssf"
		].includes(word));
}

function identifyTournament(candidate) {
	const title = cleanDiscoveryText(candidate.title || "");
	const description = cleanDiscoveryText(candidate.description || "");
	const combined = title + "\n" + description;

	const direct = combined.match(
		/https?:\/\/(?:www\.)?(?:[a-z0-9-]+\.)?challonge\.com\/((?:cs\/)?[a-z0-9_-]+)/i
	);

	const segments = title
		.replace(/#\w+/g, " ")
		.replace(/^ssf2\s*[-:|]+\s*/i, "")
		.split(/\s+(?:\||-)\s+/)
		.map(segment => segment.trim())
		.filter(Boolean);

	const isMatchOrRound = segment =>
		/\bvs\.?\b|\bround\s*\d|\b(winners?|losers?|grand finals?|semis|quarters|pools?|top\s*\d+)\b/i.test(segment) ||
		/\([^)]*\)/.test(segment);

	let name = "";

	// Prefer the last clean title segment that is not a matchup or round label.
	for(let i = segments.length - 1; i >= 0; i--) {
		const segment = segments[i]
			.replace(/\bssf2\b/ig, "")
			.replace(/#\w+/g, "")
			.trim();

		if(!isMatchOrRound(segment) && tournamentWords(segment).length >= 1) {
			name = segment;
			break;
		}
	}

	// Use an explicit Challonge URL even when the tournament name cannot be identified.
	if(!name && direct) {
		const slugWords = direct[1]
			.replace(/([a-z])([A-Z])/g, "$1 $2")
			.replace(/[_-]+/g, " ")
			.trim();

		if(tournamentWords(slugWords).length >= 1) {
			name = slugWords;
		}
	}

	// Only use a description label if it is a short, standalone value.
	if(!name) {
		const labeled = description.match(
			/(?:tournament(?:\s+name)?|event(?:\s+name)?|series|bracket)\s*[:=-]\s*([^\r\n|]{3,90})/i
		);

		if(labeled) {
			const value = labeled[1]
				.replace(/https?:\/\/\S+/ig, "")
				.replace(/\s+(?:tournament\s+)?discord\s*:.*$/i, "")
				.replace(/\s+/g, " ")
				.trim();

			if(value.length >= 4 && tournamentWords(value).length >= 1) {
				name = value;
			}
		}
	}

	name = name
		.replace(/^ssf2\s*[-:|]+\s*/i, "")
		.replace(/\btournament\b/ig, "")
		.replace(/\bde\s+(?=\d+\b)/ig, "")
		.replace(/[|•]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	const words = tournamentWords(name);
	const usableName = name.length >= 4 && words.length >= 1;

	return {
		name: usableName ? name : "",
		words,
		slug: direct ? direct[1] : ""
	};
}


function versionForMatchDate(date) {
	if(typeof date !== "string" ||
		!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		return "Unknown";
	}

	const parsed = new Date(date + "T00:00:00Z");
	if(!Number.isFinite(parsed.getTime()) ||
		parsed.toISOString().slice(0, 10) !== date) {
		return "Unknown";
	}

	if(date < "2020-12-20") return "Unknown";
	if(date < "2021-08-12") return "1.3";
	if(date < "2021-08-18") return "1.3.1";
	if(date < "2022-02-14") return "1.3.1.1";
	if(date < "2025-05-09") return "1.3.1.2";
	return "1.4";
}

function normalizeTournamentKey(value) {
	return String(value || "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.replace(/\s+/g, " ");
}

YouTubeDiscoveryManager.prototype.suggestTags = function(candidate) {
	candidate = candidate || {};

	const identity = identifyTournament(candidate);
	const tournament = String(
		candidate.tournamentTitle || identity.name || ""
	).trim() || "Unknown";

	const allowedRegions = new Set([
		"LATAM", "WW", "EU", "NA", "ANZ", "Unknown"
	]);

	let region = "Unknown";
	const tournamentKey = normalizeTournamentKey(tournament);
	const matchingRegions = [];

	if(tournamentKey && tournamentKey !== "unknown") {
		for(const game of Object.values(this.server.games || {})) {
			if(!game || !Array.isArray(game.tags) || game.tags.length < 2) {
				continue;
			}

			if(normalizeTournamentKey(game.tags[0]) !== tournamentKey) {
				continue;
			}

			const savedRegion = String(game.tags[1] || "").trim();
			matchingRegions.push(
				allowedRegions.has(savedRegion) ? savedRegion : "Unknown"
			);
		}
	}

	if(matchingRegions.length) {
		const distinctRegions = new Set(matchingRegions);
		if(distinctRegions.size === 1 &&
			!distinctRegions.has("Unknown")) {
			region = matchingRegions[0];
		}
	}

	const permittedDateSources = new Set([
		"Challonge", "Google Sheet", "YouTube"
	]);
	const version = permittedDateSources.has(candidate.dateSource)
		? versionForMatchDate(candidate.estimatedDate)
		: "Unknown";

	return [tournament, region, version].join("|");
};


const GOOGLE_SHEET_TOURNAMENTS = [
	{ date: null, label: "GSRSS", path: "GoatedSeriesRevivedSS" },
	{ date: "2026-10-10", label: "PRW5", path: "cuhhbqk1" },
	{ date: "2026-10-03", label: "COD", path: "7l3lza67" },
	{ date: "2026-09-20", label: "GSRX3", path: "GoatedSeriesRevivedX3" },
	{ date: "2026-09-07", label: "PRW4", path: "553jgly4" },
	{ date: "2026-09-05", label: "GSRX2", path: "GoatedSeriesRevivedX2" },
	{ date: "2026-08-21", label: "PRW3", path: "cs/y1y5pqdk" },
	{ date: "2026-08-16", label: "GSRX1", path: "cs/GoatedSeriesRevivedX1" },
	{ date: "2026-08-14", label: "PRW2", path: "wai5o7dk" },
	{ date: "2026-08-02", label: "GSRX", path: "GoatedSeriesRevivedX" },
	{ date: "2026-07-31", label: "PRW1", path: "z1er54u7" },
	{ date: "2026-07-25", label: "FP3", path: "FP3NA" },
	{ date: "2026-05-02", label: "GSR8", path: "GoatedSeriesRevived8" },
	{ date: "2026-04-25", label: "GSR7", path: "GoatedSeriesRevived7" },
	{ date: "2026-04-16", label: "TTTBB", path: "TTTBB" },
	{ date: "2026-04-11", label: "DSGGs", path: "DontSayGGs" },
	{ date: "2026-03-22", label: "FNAB15", path: "cs/FNAB15" },
	{ date: "2026-03-08", label: "HOR8", path: "horizonviii" },
	{ date: "2026-02-07", label: "GSR6", path: "GoatedSeriesRevived6" },
	{ date: "2026-04-04", label: "FM2026", path: "BlastrMountain" },
	{ date: "2026-01-24", label: "GSR5", path: "GoatedSeriesRevived5" },
	{ date: "2026-01-10", label: "GSR4", path: "GoatedSeriesRevived4" },
	{ date: "2026-01-03", label: "BBD", path: "newyearatthebay" }
];

function normalizeChallongePath(value) {
	let pathname = String(value || "").trim()
		.replace(/^https?:\/\/(?:www\.)?(?:[a-z0-9-]+\.)?challonge\.com\//i, "")
		.replace(/^\/+|\/+$/g, "")
		.replace(/\/module\/?$/i, "");

	try {
		pathname = decodeURIComponent(pathname);
	} catch(error) {
		// Keep the original path if it contains malformed escaping.
	}

	const parts = pathname.split("/").filter(Boolean);
	if(parts.length > 1 && parts[0].toLowerCase() !== "cs") {
		return "";
	}

	return parts.join("/");
}

function challongeUrlFromPath(value) {
	const normalized = normalizeChallongePath(value);
	return normalized ? "https://challonge.com/" + normalized : "";
}

function findSheetTournament(candidate, directPath) {
	if(directPath) {
		const normalized = normalizeChallongePath(directPath);
		const byPath = GOOGLE_SHEET_TOURNAMENTS.find(entry =>
			normalizeChallongePath(entry.path).toLowerCase() === normalized.toLowerCase()
		);
		if(byPath) return byPath;
	}

	const text = [
		candidate.title || "",
		candidate.description || ""
	].join(" ");

	function tokenize(value) {
		return String(value || "")
			.replace(/([a-z])([A-Z])/g, "$1 $2")
			.replace(/([a-zA-Z])([0-9])/g, "$1 $2")
			.replace(/([0-9])([a-zA-Z])/g, "$1 $2")
			.replace(/[^a-z0-9]+/gi, " ")
			.toLowerCase()
			.trim()
			.split(/\s+/)
			.filter(Boolean);
	}

	function containsSequence(haystack, needle) {
		for(let i = 0; i <= haystack.length - needle.length; i++) {
			if(needle.every((word, index) =>
				haystack[i + index] === word
			)) {
				return true;
			}
		}

		return false;
	}

	const words = tokenize(text);

	// Preserve exact abbreviation matching as the first priority.
	for(const entry of GOOGLE_SHEET_TOURNAMENTS) {
		const labelWords = tokenize(entry.label);
		if(labelWords.length && containsSequence(words, labelWords)) {
			return entry;
		}
	}

	// Also recognize expanded tournament names from their Challonge paths.
	for(const entry of GOOGLE_SHEET_TOURNAMENTS) {
		const path = normalizeChallongePath(entry.path)
			.replace(/^cs\//i, "");
		const pathWords = tokenize(path);

		if(pathWords.length && containsSequence(words, pathWords)) {
			return entry;
		}
	}

	return null;
}

function decodeChallongeHtml(value) {
	return String(value || "")
		.replace(/&amp;/g, "&")
		.replace(/&#x27;|&#39;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&nbsp;/g, " ");
}

function getHtmlAttribute(tag, name) {
	const escapedName = name.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
	const match = tag.match(new RegExp(
		"\\b" + escapedName + "\\s*=\\s*([\"'])(.*?)\\1",
		"i"
	));
	return match ? decodeChallongeHtml(match[2]) : "";
}

function getMetaContent(html, property) {
	const tags = String(html || "").match(/<meta\b[^>]*>/gi) || [];

	for(const tag of tags) {
		const key = getHtmlAttribute(tag, "property") ||
			getHtmlAttribute(tag, "name");

		if(key.toLowerCase() === property.toLowerCase()) {
			return getHtmlAttribute(tag, "content");
		}
	}

	return "";
}

async function discoverChallongePath(identity) {
	if(!identity.name || identity.words.length < 2) return "";

	const query = 'site:challonge.com "' + identity.name + '"';
	const response = await fetch(
		"https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query),
		{
			headers: { "User-Agent": "Mozilla/5.0" },
			signal: AbortSignal.timeout(9000)
		}
	);

	if(!response.ok) return "";

	const html = await response.text();
	if(/anomaly|captcha|challenge/i.test(html)) return "";

	const tags = html.match(/<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*>/gi) || [];

	for(const tag of tags) {
		const target = getHtmlAttribute(tag, "href");
		if(!target) continue;

		let parsed;
		try {
			let url = target;
			if(url.startsWith("//")) url = "https:" + url;
			parsed = new URL(url);

			if(parsed.hostname.toLowerCase().includes("duckduckgo.com")) {
				const redirected = parsed.searchParams.get("uddg");
				if(!redirected) continue;
				parsed = new URL(redirected);
			}
		} catch(error) {
			continue;
		}

		if(!/(^|\.)challonge\.com$/i.test(parsed.hostname)) continue;

		const bracketPath = normalizeChallongePath(parsed.pathname);
		if(!bracketPath) continue;

		const title = cleanDiscoveryText(tag.replace(/<[^>]*>/g, " "));
		const titleWords = new Set(tournamentWords(title));

		if(!identity.words.every(word => titleWords.has(word))) continue;

		return bracketPath;
	}

	return "";
}

async function verifyChallongeBracket(bracketPath) {
	const normalizedPath = normalizeChallongePath(bracketPath);
	if(!normalizedPath) return null;

	const url = challongeUrlFromPath(normalizedPath) + "/module";

	try {
		const response = await fetch(url, {
			headers: { "User-Agent": "Mozilla/5.0" },
			redirect: "follow",
			signal: AbortSignal.timeout(12000)
		});

		if(!response.ok) return null;

		const html = await response.text();
		if(!html || /cloudflare|captcha|attention required|just a moment|anomaly/i.test(html)) {
			return null;
		}

		const finalUrl = new URL(response.url);
		if(!/(^|\.)challonge\.com$/i.test(finalUrl.hostname)) return null;

		const ogUrl = getMetaContent(html, "og:url");
		const ogTitle = getMetaContent(html, "og:title");

		if(!ogUrl || !ogTitle) return null;

		let metadataUrl;
		try {
			metadataUrl = new URL(ogUrl);
		} catch(error) {
			return null;
		}

		if(!/(^|\.)challonge\.com$/i.test(metadataUrl.hostname)) return null;

		const metadataPath = normalizeChallongePath(metadataUrl.pathname);
		if(metadataPath.toLowerCase() !== normalizedPath.toLowerCase()) return null;

		if(/not found|page unavailable|error|access denied/i.test(ogTitle)) return null;

		const storeMarker = "window._initialStoreState['TournamentStore']";
		const storeIndex = html.indexOf(storeMarker);
		if(storeIndex === -1) return null;

		const storeSection = html.slice(storeIndex, storeIndex + 100000);
		const tournamentMatch = storeSection.match(
			/"tournament"\s*:\s*\{[\s\S]{0,12000}?"id"\s*:\s*\d+/
		);

		if(!tournamentMatch) return null;

		return {
			verified: true,
			date: parseChallongeStartDate(html),
			title: cleanDiscoveryText(ogTitle),
			url: challongeUrlFromPath(normalizedPath),
			checkedAt: new Date().toISOString()
		};
	} catch(error) {
		return null;
	}
}


function parseChallongeStartDate(text) {
	const match = String(text || "").match(
		/\bStart(?:\s+Time)?\s*:?\s+([A-Z][a-z]+\s+\d{1,2},?\s+20\d{2})\b/i
	);
	if(!match) return null;

	const parts = match[1].match(/^([A-Z][a-z]+)\s+(\d{1,2}),?\s+(20\d{2})$/i);
	if(!parts) return null;

	const months = [
		"january", "february", "march", "april",
		"may", "june", "july", "august",
		"september", "october", "november", "december"
	];
	const month = months.indexOf(parts[1].toLowerCase());
	const day = Number(parts[2]);
	const year = Number(parts[3]);

	if(month === -1 || day < 1 || day > 31) return null;

	const date = new Date(Date.UTC(year, month, day));

	// Reject impossible dates instead of allowing JavaScript to roll them
	// into the following month.
	if(date.getUTCFullYear() !== year ||
		date.getUTCMonth() !== month ||
		date.getUTCDate() !== day) {
		return null;
	}

	return [
		year,
		String(month + 1).padStart(2, "0"),
		String(day).padStart(2, "0")
	].join("-");
}

YouTubeDiscoveryManager.prototype.estimateCandidateDate = async function(candidate, lookupState) {
	const identity = identifyTournament(candidate);
	const publishedDate = candidate.publishedAt &&
		/^20\d{2}-\d{2}-\d{2}/.test(candidate.publishedAt)
		? candidate.publishedAt.slice(0, 10)
		: null;

	const directPath = normalizeChallongePath(identity.slug);
	const sheetEntry = findSheetTournament(candidate, directPath);
	const knownPath = directPath ||
		(sheetEntry ? normalizeChallongePath(sheetEntry.path) : "");

	const cacheKey = knownPath
		? "slug:" + knownPath.toLowerCase()
		: "";

	let result = cacheKey ? this.challongeCache[cacheKey] : null;

	const cachedPath = result && result.url
		? normalizeChallongePath(result.url).toLowerCase()
		: "";
	const requestedPath = knownPath.toLowerCase();

	const fresh = result &&
		result.verified === true &&
		cachedPath &&
		(!requestedPath || cachedPath === requestedPath) &&
		result.checkedAt &&
		Number.isFinite(Date.parse(result.checkedAt)) &&
		Date.now() >= Date.parse(result.checkedAt) &&
		Date.now() - Date.parse(result.checkedAt) < 30 * 24 * 60 * 60 * 1000;

	if(!fresh) result = null;

	let lookupCompleted = Boolean(fresh);
	let verifiedUrl = result && result.url
		? result.url
		: challongeUrlFromPath(knownPath);

	if((knownPath || identity.name) && !fresh && lookupState.searches < 3) {
		lookupState.searches++;

		try {
			let bracketPath = knownPath;

			// Search results may discover a bracket URL, but never supply a date.
			if(!bracketPath) {
				bracketPath = await discoverChallongePath(identity);
			}

			if(bracketPath) {
				const verified = await verifyChallongeBracket(bracketPath);

				if(verified && verified.verified === true) {
					result = verified;
					lookupCompleted = true;
					verifiedUrl = verified.url;

					const verifiedKey = "slug:" +
						normalizeChallongePath(bracketPath).toLowerCase();

					this.challongeCache[verifiedKey] = verified;
					lookupState.cacheChanged = true;
				}
			}
		} catch(error) {
			// A failed lookup must not authorize the YouTube date fallback.
		}
	}

	const verifiedSheetEntry = Boolean(
		sheetEntry &&
		sheetEntry.date &&
		lookupCompleted &&
		result &&
		result.verified === true &&
		normalizeChallongePath(result.url).toLowerCase() ===
			normalizeChallongePath(sheetEntry.path).toLowerCase()
	);

	if(result && result.verified === true && result.date) {
		candidate.estimatedDate = result.date;
		candidate.dateSource = "Challonge";
		candidate.dateConfidence = "high";
		candidate.tournamentTitle = result.title || (sheetEntry && sheetEntry.label) || identity.name;
		candidate.challongeUrl = result.url || verifiedUrl;
	} else if(verifiedSheetEntry) {
		candidate.estimatedDate = sheetEntry.date;
		candidate.dateSource = "Google Sheet";
		candidate.dateConfidence = "high";
		candidate.tournamentTitle = sheetEntry.label;
		candidate.challongeUrl = challongeUrlFromPath(sheetEntry.path);
	} else if(lookupCompleted && publishedDate) {
		candidate.estimatedDate = publishedDate;
		candidate.dateSource = "YouTube";
		candidate.dateConfidence = "low";
		candidate.tournamentTitle = identity.name;
		candidate.challongeUrl = verifiedUrl;
	} else {
		candidate.estimatedDate = null;
		candidate.dateSource = "Unknown";
		candidate.dateConfidence = "none";
		candidate.tournamentTitle = (sheetEntry && sheetEntry.label) || identity.name;
		candidate.challongeUrl = verifiedUrl || challongeUrlFromPath(knownPath);
	}
};

YouTubeDiscoveryManager.prototype.scan = async function() {
	if(!this.apiKeys.length) {
		return { skipped: true, reason: "No YouTube API keys are configured." };
	}

	if(this.scanning) {
		return { skipped: true, reason: "A discovery scan is already running." };
	}

	this.scanning = true;

	const summary = {
		termsSearched: 0,
		playerSearches: 0,
		resultsChecked: 0,
		automatic: 0,
		review: 0,
		duplicates: 0,
		excluded: 0,
		opponentsDiscovered: 0
	};

	let candidatesChanged = false;
	const newlyAddedIds = new Set();
	const dateLookupState = { searches: 0, cacheChanged: false };

	try {
		// Search a small rotating batch of ranked players first.
		// Keep the starting count stable while discoveries append new players.
		const playerCountAtStart = this.players.length;
		const playerBatch = this.getNextPlayerBatch();

		for(const entry of playerBatch) {
			const items = await this.search(entry.query);
			summary.termsSearched++;
			summary.playerSearches++;

			for(const id of this.addSearchResults(
				items,
				"Ranked player: " + entry.player.name,
				summary,
				entry.player
			)) newlyAddedIds.add(id);

			if(items.length) await this.save();
			if(summary.opponentsDiscovered) await this.saveDiscoveredPlayers();
			candidatesChanged = candidatesChanged || items.length > 0;

			this.rotation.cursor = (entry.index + 1) % playerCountAtStart;
			await this.saveRotation();
		}

		// Prioritize newly discovered opponents in the next scan.
		if(this.players.length > playerCountAtStart && playerBatch.length) {
			this.rotation.cursor = playerCountAtStart;
			await this.saveRotation();
		}

		// Prioritize 2026 uploads while preserving rotation for older uploads.
		// YouTube upload dates determine priority only, never the actual match date.
		const recentDateCandidateIds = [];
		const olderDateCandidateIds = [];

		for(const id of Object.keys(this.candidates)) {
			const candidate = this.candidates[id];
			const publishedAt = candidate && candidate.publishedAt;
			const publishedTimestamp = typeof publishedAt === "string" &&
				/^2026-\d{2}-\d{2}T/.test(publishedAt)
				? Date.parse(publishedAt)
				: NaN;

			if(Number.isFinite(publishedTimestamp) &&
				new Date(publishedTimestamp).getUTCFullYear() === 2026) {
				recentDateCandidateIds.push(id);
			} else {
				olderDateCandidateIds.push(id);
			}
		}

		if(recentDateCandidateIds.length || olderDateCandidateIds.length) {
			const recentStart = recentDateCandidateIds.length
				? this.rotation.date2026Cursor % recentDateCandidateIds.length
				: 0;
			const olderStart = olderDateCandidateIds.length
				? this.rotation.dateCursor % olderDateCandidateIds.length
				: 0;

			// Interleave two 2026 uploads for every older upload.
			// If one group runs out, fill the remaining slots from the other.
			const dateQueue = [];
			let recentOffset = 0;
			let olderOffset = 0;

			while(dateQueue.length < DEFAULT_DATE_BATCH_SIZE &&
				(recentOffset < recentDateCandidateIds.length ||
				olderOffset < olderDateCandidateIds.length)) {

				const hasRecent = recentOffset < recentDateCandidateIds.length;
				const hasOlder = olderOffset < olderDateCandidateIds.length;
				const preferOlder = dateQueue.length % 3 === 2;
				const useOlder = hasOlder && (!hasRecent || preferOlder);

				if(useOlder) {
					dateQueue.push({
						id: olderDateCandidateIds[
							(olderStart + olderOffset) % olderDateCandidateIds.length
						],
						priority: "older"
					});
					olderOffset++;
				} else {
					dateQueue.push({
						id: recentDateCandidateIds[
							(recentStart + recentOffset) % recentDateCandidateIds.length
						],
						priority: "2026"
					});
					recentOffset++;
				}
			}

			let recentProcessedCount = 0;
			let olderProcessedCount = 0;

			for(const entry of dateQueue) {
				const candidate = this.candidates[entry.id];
				if(!candidate) continue;

				await this.estimateCandidateDate(candidate, dateLookupState);

				if(entry.priority === "2026") recentProcessedCount++;
				else olderProcessedCount++;

				if(candidate.dateSource === "Challonge") summary.challongeMatches =
					(summary.challongeMatches || 0) + 1;
				else if(candidate.dateSource === "YouTube") summary.youtubeDateFallbacks =
					(summary.youtubeDateFallbacks || 0) + 1;
				else summary.dateUnknown = (summary.dateUnknown || 0) + 1;

				summary.datesEstimated = (summary.datesEstimated || 0) + 1;

				// Keep the existing maximum of three Challonge searches per scan.
				if(dateLookupState.searches >= 3) break;
			}

			this.rotation.date2026Cursor = recentDateCandidateIds.length
				? (recentStart + recentProcessedCount) % recentDateCandidateIds.length
				: 0;

			this.rotation.dateCursor = olderDateCandidateIds.length
				? (olderStart + olderProcessedCount) % olderDateCandidateIds.length
				: 0;

			await this.saveRotation();
			candidatesChanged = true;
		}

		try {
			const enrichment = await this.enrichCandidates(50);
			Object.assign(summary, enrichment);
			if(enrichment.enrichmentChecked) candidatesChanged = true;
		} catch(error) {
			summary.enrichmentError = error.message;
		}

		if(dateLookupState.cacheChanged) await this.saveChallongeCache();
		if(candidatesChanged || newlyAddedIds.size) await this.save();

		if(this.server.logger) {
			this.server.logger.log(
				`YouTube discovery scan completed: ${JSON.stringify(summary)}`,
				null,
				"YouTube discovery"
			);
		}

		return summary;
	} finally {
		this.scanning = false;
	}
};

YouTubeDiscoveryManager.prototype.start = async function() {
	await this.load();

	if(!this.apiKeys.length) {
		return false;
	}

	if(this.timer) clearInterval(this.timer);

	this.scan().catch(error => {
		if(this.server.logger) {
			this.server.logger.log(
				"YouTube discovery scan failed: " + error.message,
				null,
				"YouTube discovery"
			);
		}
	});

	this.timer = setInterval(() => {
		this.scan().catch(error => {
			if(this.server.logger) {
				this.server.logger.log(
					"YouTube discovery scan failed: " + error.message,
					null,
					"YouTube discovery"
				);
			}
		});
	}, this.interval);

	if(this.timer.unref) this.timer.unref();
	return true;
};

YouTubeDiscoveryManager.prototype.stop = function() {
	if(this.timer) {
		clearInterval(this.timer);
		this.timer = null;
	}
};

module.exports = YouTubeDiscoveryManager;
