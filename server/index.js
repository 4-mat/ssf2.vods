const fs = require("fs");
const TemplateManager = require("./templateManager.js");
const VideoDataManager = require("./videoDataManager.js");
const StatisticsManager = require("./statisticsManager.js");
const SearchManager = require("./searchManager.js");
const MatchManager = require("./matchManager.js");
const Logger = require("./logger.js");
const charIdMap = require("./charIdMap.js");
const YouTubeDiscoveryManager = require("./youtubeDiscoveryManager.js");

function Server(cfg, app) {
	this.charMap = charIdMap;
	this.cfg = cfg;
	this.app = app;
	this.templateManager = new TemplateManager(this);
	this.videoDataManager = new VideoDataManager(this.cfg);
	this.searchManager = new SearchManager(this.cfg);
	this.statisticsManager = new StatisticsManager(this);
	this.matchManager = new MatchManager(this);
	this.logger = new Logger(this.cfg);
	this.youtubeDiscoveryManager = new YouTubeDiscoveryManager(this);
}
Server.prototype.initialize = async function() {
	this.games = await this.videoDataManager.loadJSON();
	try {
		await this.youtubeDiscoveryManager.load();
	} catch(error) {
		this.logger.log("YouTube discovery could not load: " + error.message, null, "YouTube discovery");
	}
	this.setupRoutes();
};
Server.prototype.getRandomCharId = function() {
	let chars = Object.values(this.charMap);
	return chars[Math.floor(Math.random() * chars.length)].id;
};

Server.prototype.getRandomPortrait = function() {
	return "img/chars/" + this.getRandomCharId() + ".png";
};

Server.prototype.authCheck = function(req) {
	if(!req.cookies.token) return false;

	for(let user of this.cfg.contributors) {
		if(user.token && user.token === req.cookies.token) {
			return user.name;
		}
	}

	return false;
};

Server.prototype.approveCheck = function(auth, req) {
	if(!auth) return false;
	if(!req.cookies.token) return false;

	for(let user of this.cfg.contributors) {
		if(user.token && user.token === req.cookies.token) {
			return !user.noApprove;
		}
	}

	return false;
};

Server.prototype.setupRoutes = function() {
	this.app.get("/", async (req, res) => {
		let searchResult = null;
		
		if(Object.keys(req.query).length > 0) {
			searchResult = this.searchManager.search(this.games, req.query);
		}

		res.send(this.templateManager.renderTemplate("index.html", {
			search: searchResult
		}));
	});

	this.app.get("/faq", async (req, res) => {
		res.send(this.templateManager.renderTemplate("faq.html"));
	});

	this.app.get("/statistics", async (req, res) => {
		let type = "all-players";

		if(req.query.chars) {
			type = "chars";
		}
		if(req.query.player) {
			type = "player";
		}
		if(req.query.character) {
			type = "matchup";
		}

		res.send(this.templateManager.renderTemplate("statistics.html", {
			type,
			player: req.query.player,
			character: this.charMap[req.query.character]
		}));
	});

	this.app.get("/contributors", async (req, res) => {
		res.send(this.templateManager.renderTemplate("contributors.html"));
	});

	this.app.get("/characters", async (req, res) => {
		res.send(this.templateManager.renderTemplate("characters.html"));
	});

	this.app.get("/editor", async (req, res) => {
		let auth = this.authCheck(req);
		res.send(this.templateManager.renderTemplate("editor.html", {
			auth,
			canApprove: this.approveCheck(auth, req)
		}));
	});

	this.app.get("/provisional", async (req, res) => {
		let auth = this.authCheck(req);
		if(!auth || !this.approveCheck(auth, req)) {
			return res.status(403).send("No!");
		}
		res.send(this.templateManager.renderTemplate("provisional.html"));
	});


	this.app.get("/youtubeDiscoveryCandidates", async (req, res) => {
		let auth = this.authCheck(req);
		if(!auth || !this.approveCheck(auth, req)) {
			return res.status(403).send("No!");
		}

		const candidates = Object.values(this.youtubeDiscoveryManager.candidates)
			.filter(candidate => !this.games[candidate.id])
			.map(candidate => ({
				...candidate,
				suggestedTags: this.youtubeDiscoveryManager.suggestTags(candidate)
			}));

		res.json({
			candidates,
			configured: this.youtubeDiscoveryManager.apiKeys.length > 0,
			scanning: this.youtubeDiscoveryManager.scanning
		});
	});

	this.app.post("/youtubeDiscoveryReset", async (req, res) => {
		let auth = this.authCheck(req);
		if(!auth || !this.approveCheck(auth, req)) {
			return res.status(403).send("No!");
		}

		try {
			const result = await this.youtubeDiscoveryManager.resetDiscovery();
			this.logger.log(
				"Reset YouTube discovery candidates and scan cursors.",
				req.connection.remoteAddress,
				auth
			);
			res.json(result);
		} catch(error) {
			const status = error.message === "A discovery scan is currently running."
				? 409
				: 500;
			this.logger.log(
				"YouTube discovery reset failed: " + error.message,
				req.connection.remoteAddress,
				auth
			);
			res.status(status).send(error.message);
		}
	});

	this.app.post("/youtubeDiscoveryScan", async (req, res) => {
		let auth = this.authCheck(req);
		if(!auth || !this.approveCheck(auth, req)) {
			return res.status(403).send("No!");
		}

		try {
			const summary = await this.youtubeDiscoveryManager.scan();
			res.json(summary);
		} catch(error) {
			this.logger.log("Manual YouTube discovery scan failed: " + error.message, req.connection.remoteAddress, auth);
			res.status(502).send("YouTube discovery scan failed: " + error.message);
		}
	});

	this.app.post("/youtubeDiscoveryPromote", async (req, res) => {
		let auth = this.authCheck(req);
		if(!auth || !this.approveCheck(auth, req)) {
			return res.status(403).send("No!");
		}

		const form = req.body || {};
		const vid = form.vid;

		if(typeof vid !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(vid)) {
			return res.status(400).send("Invalid YouTube video ID.");
		}

		const candidate = this.youtubeDiscoveryManager.candidates[vid];
		if(!candidate) return res.status(404).send("Discovery candidate not found.");
		if(this.games[vid]) return res.status(409).send("This video is already in the replay database.");

		if(typeof form.date !== "string" ||
			!/^\d{4}-\d{2}-\d{2}$/.test(form.date) ||
			!Number.isFinite(Date.parse(form.date)) ||
			new Date(form.date).toISOString().slice(0, 10) !== form.date) {
			return res.status(400).send("Enter a valid video date in YYYY-MM-DD format.");
		}

		if(form.netplay !== "L" && form.netplay !== "N") {
			return res.status(400).send("Select Locals or Netplay.");
		}

		if(form.netcode !== "D" && form.netcode !== "R") {
			return res.status(400).send("Select Delay-based or Rollback netcode.");
		}

		let tags;
		if(Array.isArray(form.tags)) {
			tags = form.tags;
		} else if(typeof form.tags === "string") {
			tags = form.tags.replace(/\|+/g, "|").split("|");
		} else {
			tags = [];
		}

		tags = tags.map(tag => String(tag).trim()).filter(Boolean);
		if(tags.some(tag => /[\t\r\n]/.test(tag))) {
			return res.status(400).send("Tags cannot contain tabs or line breaks.");
		}

		this.games[vid] = {
			id: vid,
			date: form.date,
			netplay: form.netplay,
			tags,
			netcode: form.netcode,
			provIP: null,
			matches: []
		};

		try {
			await this.videoDataManager.saveData(this.games);
		} catch(error) {
			delete this.games[vid];
			this.logger.log("YouTube candidate promotion failed for " + vid + ": " + error.message, req.connection.remoteAddress, auth);
			return res.status(500).send("Could not save the promoted video.");
		}

		delete this.youtubeDiscoveryManager.candidates[vid];

		let candidateCleanupFailed = false;
		try {
			await this.youtubeDiscoveryManager.save();
		} catch(error) {
			this.youtubeDiscoveryManager.candidates[vid] = candidate;
			candidateCleanupFailed = true;
			this.logger.log("Promoted video " + vid + " but candidate cleanup failed: " + error.message, req.connection.remoteAddress, auth);
		}

		this.logger.log("Promoted YouTube discovery candidate: " + vid, req.connection.remoteAddress, auth);
		res.json({ promoted: true, candidateCleanupFailed });
	});

	this.app.post("/youtubeDiscoveryReject", async (req, res) => {
		let auth = this.authCheck(req);
		if(!auth || !this.approveCheck(auth, req)) {
			return res.status(403).send("No!");
		}

		const vid = req.body && req.body.vid;
		if(typeof vid !== "string" || !this.youtubeDiscoveryManager.candidates[vid]) {
			return res.status(404).send("Discovery candidate not found.");
		}

		const candidate = this.youtubeDiscoveryManager.candidates[vid];
		delete this.youtubeDiscoveryManager.candidates[vid];

		try {
			await this.youtubeDiscoveryManager.save();
		} catch(error) {
			this.youtubeDiscoveryManager.candidates[vid] = candidate;
			this.logger.log("Could not reject YouTube candidate " + vid + ": " + error.message, req.connection.remoteAddress, auth);
			return res.status(500).send("Could not save the rejection.");
		}

		this.logger.log("Rejected YouTube discovery candidate: " + vid, req.connection.remoteAddress, auth);
		res.sendStatus(200);
	});

	this.app.post("/approveVideo", async (req, res) => {
		let auth = this.authCheck(req);
		if(!auth || !this.approveCheck(auth, req)) {
			return res.status(403).send("No!");
		}
		let ip = req.connection.remoteAddress;

		if(req.body && req.body.vid) {
			let videoData = this.games[req.body.vid];
			if(videoData) {
				videoData.provIP = null;
				await this.videoDataManager.saveData(this.games);
				this.logger.log("Approved provisional video: " + req.body.vid, ip, auth);
				res.sendStatus(200);
			} else {
				res.status(400).send("Couldn't find the video.");
			}
		} else {
			res.status(400).send("Couldn't get the video id.");
		}
	});

	this.app.post("/deleteProvVideo", async (req, res) => {
		let auth = this.authCheck(req);
		if(!auth || !this.approveCheck(auth, req)) {
			return res.status(403).send("No!");
		}
		let ip = req.connection.remoteAddress;

		if(req.body && req.body.vid) {
			let videoData = this.games[req.body.vid];
			if(videoData && videoData.provIP) {
				delete this.games[req.body.vid];
				await this.videoDataManager.saveData(this.games);
				this.logger.log("Deleted provisional video: " + req.body.vid, ip, auth);
				res.sendStatus(200);
			} else {
				res.status(400).send("Couldn't find the video.");
			}
		} else {
			res.status(400).send("Couldn't get the video id.");
		}
	});

	this.app.post("/addMatch", async (req, res) => {
		let ip = req.connection.remoteAddress;
		let error = this.matchManager.addMatch(req.body, ip, this.authCheck(req));
		if(error) {
			if(error.duplicate) {
				res.status(409).json(error);
			} else {
				res.status(400).send(error);
			}
		} else {
			await this.videoDataManager.saveData(this.games);
			res.sendStatus(200);
		}
	});

	this.app.put("/editMatch", async (req, res) => {
		let ip = req.connection.remoteAddress;
		let error = this.matchManager.editMatch(req.body, ip, this.authCheck(req));
		if(error) {
			res.status(400).send(error);
		} else {
			await this.videoDataManager.saveData(this.games);
			res.sendStatus(200);
		}
	});

	this.app.put("/editVideo", async (req, res) => {
		let ip = req.connection.remoteAddress;
		let error = this.matchManager.editVideo(req.body, ip, this.authCheck(req));
		if(error) {
			res.status(400).send(error);
		} else {
			await this.videoDataManager.saveData(this.games);
			res.sendStatus(200);
		}
	});

	this.app.delete("/deleteMatch", async (req, res) => {
		let ip = req.connection.remoteAddress;
		let error = this.matchManager.deleteMatch(req.body, ip, this.authCheck(req));
		if(error) {
			res.status(400).send(error);
		} else {
			await this.videoDataManager.saveData(this.games);
			res.sendStatus(200);
		}
	});

	this.app.get("/videoMatches", async (req, res) => {
		let vid = req.query.vid;
		if(!vid) {
			res.sendStatus(400);
		} else {
			let json = {
				html: this.templateManager.renderTemplate("editorVideoMatches.html", {
					vid
				}),
				date: this.games[vid] && this.games[vid].date,
				netplay: this.games[vid] && this.games[vid].netplay,
				netcode: this.games[vid] && this.games[vid].netcode,
				tags: this.games[vid] && this.games[vid].tags,
			}
			res.send(JSON.stringify(json));
		}
	});

	this.app.get("/404", async (req, res) => {
		res.send(this.templateManager.renderTemplate("404.html"));
	});

	this.app.post("/report", async (req, res) => {
		if(req.body && req.body.vid) {
			let line = "";
			line += "Video: " + (req.body.vid).padEnd(15);
			line += "Order: " + (req.body.idx||"???").padEnd(6);
			line += "Time: " + (req.body.time||"???").padEnd(9);
			line += "Reason: " + (req.body.reason||"???");
			line += " IP: " + req.connection.remoteAddress;

			fs.appendFileSync(this.cfg.reportsFilename, line + "\n");
		} else {
			res.sendStatus(400);
		}
		res.sendStatus(200);
	});

	this.app.get("/charInfo", async (req, res) => {
		res.send({
			charData: this.charMap[req.query.char],
			charPlayers: this.templateManager.renderTemplate("characterPlayerStatistics.html", {
				char: req.query.char
			})
		});
	});
};

module.exports = Server;
