const fs = require("fs");
const configPath = fs.existsSync("./config.js") ? "./config.js" : "./config.example.js";
const cfg = require(configPath);
const http = require("http");
const express = require("express");
const cookieParser = require("cookie-parser");

const port = process.env.PORT || cfg.port || 10800;
const app = express();

app.use(express.json());
app.use(cookieParser());

async function start() {
	const siteServer = new (require(cfg.server))(cfg, app);

	await siteServer.initialize();

	// Setup routes to static content
	app.use(express.static("site", {extensions: ['html']}));

	// 404
	app.get("*", function(req, res) {
		res.redirect("/404");
	});

	// Start listening
	const server = http.Server(app);
	server.listen(port, () => console.log(`Listening on: ${port}!`));
}

start().catch(error => {
	console.error("Failed to start server.", error);
	process.exit(1);
});