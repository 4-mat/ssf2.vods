
document.addEventListener("DOMContentLoaded", () => {
	let url = new URLSearchParams(location.search);
	let videoId = url.get("videoId")||null;
	new Editor(videoId);
});

function Editor(videoId) {
	const params = new URLSearchParams(location.search);
	this.candidatePrefill = [
		"candidateDate",
		"candidateTags",
		"candidateNetplay",
		"candidateNetcode",
		"candidateDateChanged",
		"candidateTagsChanged",
		"candidateNetplayChanged",
		"candidateNetcodeChanged",
		"candidateTitle"
	].some(key => params.has(key)) ? {
		date: params.has("candidateDate") ? params.get("candidateDate") : null,
		tags: params.has("candidateTags") ? params.get("candidateTags") : null,
		netplay: params.has("candidateNetplay") ? params.get("candidateNetplay") : null,
		netcode: params.has("candidateNetcode") ? params.get("candidateNetcode") : null,
		dateChanged: params.get("candidateDateChanged") === "1",
		tagsChanged: params.get("candidateTagsChanged") === "1",
		netplayChanged: params.get("candidateNetplayChanged") === "1",
		netcodeChanged: params.get("candidateNetcodeChanged") === "1",
		title: params.has("candidateTitle") ? params.get("candidateTitle") : null
	} : null;
	this.PlayerLoaderForm = document.getElementById("PlayerLoaderForm");
	this.VideoURLInput = document.getElementById("VideoURLInput");
	this.PlayerLoadButton = document.getElementById("PlayerLoadButton");
	this.VideoDataForm = document.getElementById("VideoDataForm");
	this.NewMatchForm = document.getElementById("NewMatchForm");
	this.ResultsList = document.getElementById("ResultsList");
	this.PlayPauseButton = document.getElementById("PlayPauseButton");
	this.EnterTokenButton = document.getElementById("EnterTokenButton");

	this.P1Char = document.getElementById("P1Char");
	this.P1Name = document.getElementById("P1Name");
	this.P1NameList = document.getElementById("p1name-list");
	this.P2Char = document.getElementById("P2Char");
	this.P2Name = document.getElementById("P2Name");
	this.P2NameList = document.getElementById("p2name-list");

	this.candidateMatchIndex = 0;
	this.candidateMatchup = this.candidatePrefill && this.candidatePrefill.title
		? this.parseCandidateMatchup(this.candidatePrefill.title)
		: null;
	this.VideoDate = document.getElementById("VideoDate");
	this.WinnerSelect = document.getElementById("WinnerSelect");
	this.VideoTags = document.getElementById("VideoTags");
	this.NetplaySelect = document.getElementById("NetplaySelect");
	this.NetcodeSelect = document.getElementById("NetcodeSelect");
	this.UpdateVideoDataButton = document.getElementById("UpdateVideoDataButton");
	this.ActionButton = document.getElementById("ActionButton");
	this.TimeRefreshButton = document.getElementById("TimeRefreshButton");
	this.ManualTimeInput = document.getElementById("ManualTimeInput");
	this.CancelEditButton = document.getElementById("CancelEditButton");
	this.CancelEditContainer = document.getElementById("CancelEditContainer");
	this.EditorGuide = document.getElementById("EditorGuide");
	this.PlayerTip = document.getElementById("PlayerTip");

	this.time = 0;

	this.setupEvents();

	if(videoId) {
		window.addEventListener("load", () => {
			this.VideoURLInput.value = videoId;
			this.PlayerLoadButton.click();
		});
	}

	this._editingRow = null;
	this._editingOrderIndex = null;
	this._editingMatchId = null;
}

Editor.prototype.setupEvents = function() {
	this.PlayerLoadButton.addEventListener("click", () => this.loadYoutubePlayer());
	
	let TimeChangeButtons = document.getElementsByClassName("timechange-button");
	for(let elem of TimeChangeButtons) {
		elem.addEventListener("click", () => {
			this.changeTime(parseInt(elem.dataset.timeshift));
		});
	}

	this.TimeRefreshButton.addEventListener("click", () => {
		const manualTime = this.ManualTimeInput.value.trim();

		if(manualTime) {
			let seconds;

			if(/^\d+$/.test(manualTime)) {
				seconds = Number(manualTime);
			} else {
				const parts = manualTime.split(":");

				if(parts.length === 2 &&
					/^\d+$/.test(parts[0]) &&
					/^\d{1,2}$/.test(parts[1]) &&
					Number(parts[1]) < 60) {
					seconds = Number(parts[0]) * 60 + Number(parts[1]);
				} else if(parts.length === 3 &&
					parts.every(part => /^\d+$/.test(part)) &&
					Number(parts[1]) < 60 &&
					Number(parts[2]) < 60) {
					seconds = Number(parts[0]) * 3600 +
						Number(parts[1]) * 60 +
						Number(parts[2]);
				}
			}

			if(!Number.isSafeInteger(seconds) || seconds < 0) {
				alert("Enter a valid timestamp: seconds, m:ss, or h:mm:ss.");
				return;
			}

			this.onTimeChange(seconds);
			return;
		}

		if(this.YoutubePlayer && this.YoutubePlayer.getCurrentTime) {
			this.onTimeChange(Math.floor(this.YoutubePlayer.getCurrentTime()));
		} else {
			this.onTimeChange(0);
		}
	});

	this.PlayPauseButton.addEventListener("click", () => {
		let currentState = this.YoutubePlayer.getPlayerState();
		if(currentState === YT.PlayerState.PLAYING) {
			this.YoutubePlayer.pauseVideo();
		} else {
			this.YoutubePlayer.playVideo();
		}
	});

	this.UpdateVideoDataButton.addEventListener("click", () => {
		let obj = {
			vid: this.YoutubePlayer.getVideoData().video_id,
			date: this.VideoDate.value,
			netplay: this.NetplaySelect.value,
			netcode: this.NetcodeSelect.value,
			tags: this.VideoTags.value.trim()
		};

		fetch("/editVideo", {
			method: "PUT",
			headers: {
				"Content-Type": "application/json"
			},
			body: JSON.stringify(obj)
		}).then(r => {
			if(r.status !== 200) {
				r.text().then(alert);
			} else {
				this.updateMatchList();
			}
		});
	});

	this.ActionButton.addEventListener("click", () => {
		if(this.ActionButton.innerText === "Add") {
			this.addMatch();
		} else {
			this.editMatch();
		}
	});

	this.CancelEditButton.addEventListener("click", () => {
		this.CancelEditContainer.setAttribute("hidden", 1);
		this.ActionButton.innerText = "Add";
		if(this._editingRow) {
			this._editingRow.classList.remove("editing");
			this._editingRow = null;
		}
		this._editingMatchId = null;
		this._editingOrderIndex = null;
	});

	this.EnterTokenButton.addEventListener("click", () => {
		var token = prompt("Enter your token:");
		document.cookie = "token=" + token;
		location.reload()
	});

	document.addEventListener("keydown", (e) => {
		if((e.key === "Control" || e.key === "Shift") && e.shiftKey && e.ctrlKey) {
			if(this.YoutubePlayer && this.YoutubePlayer.getCurrentTime) {
				this.onTimeChange(Math.floor(this.YoutubePlayer.getCurrentTime()));
			}
		}
	});
};

Editor.prototype.onTimeChange = function(time) {
	this.time = time;
	this.ActionButton.dataset.time = ConvertSecondsToReadable(this.time);
};

Editor.prototype.updatePlayerTipContent = function() {
	let unique = {};
	let table = document.getElementById("ResultsTable");
	if(!table) return;

	let tbody = table.tBodies[0];
	while(this.PlayerTip.children.length > 0) {
		this.PlayerTip.removeChild(this.PlayerTip.firstChild);
	}

	for(let row of tbody.rows) {
		let p1name = row.querySelector(".player-1 span").innerText.trim();
		if(p1name.length > 0) {
			let p1char = row.querySelector(".player-1 img").dataset.char;
			unique[p1char+p1name] = {name: p1name, char: p1char};
		}
		let p2name = row.querySelector(".player-2 span").innerText.trim();
		if(p2name.length > 0) {
			let p2char = row.querySelector(".player-2 img").dataset.char;
			unique[p2char+p2name] = {name: p2name, char: p2char};
		}
	}

	let arr = Object.values(unique);
	for(let obj of arr) {
		this.PlayerTip.appendChild(this.buildTipEntry(obj.char, obj.name));
	}
};

Editor.prototype.buildTipEntry = function(char, name) {
	let container = document.createElement("div");
	
	let p1button = document.createElement("button");
	p1button.innerText = "P1";
	p1button.classList = "ms-small ms-info";
	let p2button = document.createElement("button");
	p2button.innerText = "P2";
	p2button.classList = "ms-small ms-info";
	p1button.onclick = () => {
		this.P1Name.value = name;
		this.P1Char.value = char;
	};
	p2button.onclick = () => {
		this.P2Name.value = name;
		this.P2Char.value = char;
	};
	container.appendChild(p1button);
	container.appendChild(p2button);

	let charImg = document.createElement("img");
	charImg.src = `img/chars/${char}.png`;
	let playerName = document.createElement("span");
	playerName.innerText = name;
	container.appendChild(charImg);
	container.appendChild(playerName);
	
	return container;
};


Editor.prototype.parseCandidateMatchup = function(title) {
	const normalize = value => String(value || "")
		.replace(/&amp;/gi, "&")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "");

	const buildCharacterLookup = select => {
		const lookup = new Map();

		for(const option of select.options) {
			if(!option.value) continue;
			lookup.set(normalize(option.value), option.value);
			lookup.set(normalize(option.textContent), option.value);
		}

		const aliases = {
			"c falcon": "Falcon",
			"captain falcon": "Falcon",
			"puff": "Jigglypuff",
			"pikachu": "Pikachu",
			"donkey kong": "Donkey Kong",
			"gnw": "Mr. Game & Watch",
			"game and watch": "Mr. Game & Watch",
			"king dedede": "King Dedede",
			"megaman": "Mega Man",
			"meta knight": "Meta Knight",
			"pacman": "Pac-Man",
			"rayman": "Rayman",
			"chibi robo": "Chibi-Robo",
			"ganondorf": "Ganondorf",
			"jigglypuff": "Jigglypuff",
			"zero suit samus": "Zero Suit Samus",
			"bandana dee": "Bandana Dee",
			"bdee": "Bandana Dee",
			"bomberman": "Bomberman",
			"black mage": "Black Mage",
			"sandbag": "Sandbag",
			"multiple": "",
			"rock": ""
		};

		for(const [alias, displayName] of Object.entries(aliases)) {
			if(!displayName) continue;
			const value = lookup.get(normalize(displayName));
			if(value) lookup.set(normalize(alias), value);
		}

		return lookup;
	};

	const p1Lookup = buildCharacterLookup(this.P1Char);
	const p2Lookup = buildCharacterLookup(this.P2Char);

	const resolveCharacter = (name, lookup) => {
		return lookup.get(normalize(name)) || "";
	};

	const cleanSide = (side, lookup, isLeft) => {
		side = String(side || "").trim();

		// Player 1 may have tournament/round text before the matchup.
		if(isLeft) {
			const lastSeparator = side.lastIndexOf(" - ");
			if(lastSeparator !== -1) {
				side = side.slice(lastSeparator + 3).trim();
			}
		} else {
			// Player 2 may have tournament/round text after the matchup.
			const suffix = side.indexOf(" - ");
			if(suffix !== -1) {
				side = side.slice(0, suffix).trim();
			}
		}

		side = side
			.replace(/^SSF2\s+Replay\s*:\s*/i, "")
			.replace(/^\[[^\]]+\]\s*\d*\s*-\s*/i, "")
			.replace(/^#\s*/, "")
			.trim();

		const match = side.match(/^(.*?)\s*\(([^()]*)\)\s*$/);

		if(match) {
			const outside = match[1].trim();
			const inside = match[2].trim();

			const characters = inside.split(",")
				.map(item => resolveCharacter(item.trim(), lookup))
				.filter(Boolean);

			if(characters.length) {
				return {
					name: outside,
					characters
				};
			}

			// Also accept reversed titles such as "Sheik (Pho)".
			const leadingCharacter = resolveCharacter(outside, lookup);
			if(leadingCharacter && inside) {
				return {
					name: inside,
					characters: [leadingCharacter]
				};
			}

			// Parentheses containing only a player name are not a character.
			return {
				name: outside || inside,
				characters: []
			};
		}

		return {
			name: side,
			characters: []
		};
	};

	const cleanedTitle = String(title || "")
		.replace(/&amp;/gi, "&")
		.replace(/\s+/g, " ")
		.trim();

	const separator = cleanedTitle.match(/\s+(?:vs\.?|versus)\s+/i);
	if(!separator) return null;

	const index = cleanedTitle.search(/\s+(?:vs\.?|versus)\s+/i);
	const left = cleanedTitle.slice(0, index);
	const right = cleanedTitle.slice(index + separator[0].length);

	const p1 = cleanSide(left, p1Lookup, true);
	const p2 = cleanSide(right, p2Lookup, false);

	if(!p1.name && !p2.name) return null;

	return {
		p1,
		p2
	};
};

Editor.prototype.applyCandidateMatch = function() {
	if(!this.candidateMatchup) return;

	const index = this.candidateMatchIndex;
	const characterAt = (characters, position) => {
		if(!characters.length) return "";
		if(characters.length === 1) return characters[0];
		return characters[position] || "";
	};

	this.P1Name.value = this.candidateMatchup.p1.name;
	this.P2Name.value = this.candidateMatchup.p2.name;
	this.P1Char.value = characterAt(
		this.candidateMatchup.p1.characters, index
	);
	this.P2Char.value = characterAt(
		this.candidateMatchup.p2.characters, index
	);
};

Editor.prototype.advanceCandidateMatch = function() {
	if(!this.candidateMatchup) return;
	this.candidateMatchIndex++;
	this.applyCandidateMatch();
};

Editor.prototype.updateMatchList = function(vid, prefill) {
	if(!vid) {
		vid = this.YoutubePlayer.getVideoData().video_id;
	}

	fetch("/videoMatches?vid=" + vid)
	.then((r) => {
		r.json().then(json => {
			this.ResultsList.innerHTML = json.html || "";
			this.VideoDate.value = json.date || "";
			this.NetplaySelect.value = json.netplay || "";
			this.NetcodeSelect.value = json.netcode || "";
			this.VideoTags.value = json.tags ? json.tags.join("|") : "";

			// Candidate values fill missing saved data unless explicitly edited.
			if(prefill) {
				if(prefill.date !== null &&
					(prefill.dateChanged || !this.VideoDate.value)) {
					this.VideoDate.value = prefill.date;
				}
				if(prefill.tags !== null &&
					(prefill.tagsChanged || !this.VideoTags.value)) {
					this.VideoTags.value = prefill.tags;
				}
				if(prefill.netplay !== null &&
					(prefill.netplayChanged || !this.NetplaySelect.value)) {
					this.NetplaySelect.value = prefill.netplay;
				}
				if(prefill.netcode !== null &&
					(prefill.netcodeChanged || !this.NetcodeSelect.value)) {
					this.NetcodeSelect.value = prefill.netcode;
				}

				if(this.candidateMatchup &&
					!this.ResultsList.querySelector(".edit-button")) {
					this.applyCandidateMatch();
				}
			}

			// Delay-based is the default only when no saved or supplied netcode exists.
			if(!this.NetcodeSelect.value) {
				this.NetcodeSelect.value = "D";
			}

			//Go To buttons events
			let gotoButtons = document.getElementsByClassName("goto-button");
			for(let btn of gotoButtons) {
				btn.onclick = () => {
					this.goToTime(parseInt(btn.dataset.time));
				};
			}
			//Edit buttons
			let editButtons = document.getElementsByClassName("edit-button");
			for(let btn of editButtons) {
				btn.onclick = () => {
					this.editButtonPress(
						btn,
						parseInt(btn.dataset.idx),
						btn.dataset.p1char,
						btn.dataset.p1name,
						btn.dataset.p2char,
						btn.dataset.p2name,
						btn.dataset.winner,
						parseInt(btn.dataset.time),
						btn.dataset.seek === "1",
						btn.dataset.matchId
					);
				};
			}
			//Delete buttons
			let deleteButtons = document.getElementsByClassName("delete-button");
			for(let btn of deleteButtons) {
				btn.onclick = () => {
					this.deleteMatch(parseInt(btn.dataset.time), btn.dataset.matchId);
				};
			}

			this.updatePlayerTipContent();
		});
	});
};

Editor.prototype.editButtonPress = function(btn, idx, p1char, p1name, p2char, p2name, winner, time, seek, matchId) {
	this.ActionButton.innerText = "Edit";

	if(seek) {
		this.goToTime(time);
	}
	this.onTimeChange(time);

	this.P1Char.value = p1char;
	this.P1Name.value = p1name;
	this.P2Char.value = p2char;
	this.P2Name.value = p2name;
	this.WinnerSelect.value = winner;

	if(this._editingRow) {
		this._editingRow.classList.remove("editing");
	}
	this._editingRow = btn.closest("tr");
	this._editingRow.classList.add("editing");
	this.CancelEditContainer.removeAttribute("hidden");
	this._editingOrderIndex = idx;
	this._editingMatchId = matchId || null;
	this.YoutubePlayer.getIframe().scrollIntoView();
};

Editor.prototype.editMatch = function() {
	const matchId = this._editingMatchId;
	const orderIndex = this._editingOrderIndex;
	this.CancelEditButton.click();
	let obj = {
		vid: this.YoutubePlayer.getVideoData().video_id,
		date: this.VideoDate.value,
		time: this.time,
		netplay: this.NetplaySelect.value,
			netcode: this.NetcodeSelect.value,
		orderIndex,
		matchId,
		p1char: this.P1Char.value,
		p1name: this.P1Name.value.trim(),
		p2char: this.P2Char.value,
		p2name: this.P2Name.value.trim(),
		winner: this.WinnerSelect.value,
		tags: this.VideoTags.value.trim()
	};
	fetch("/editMatch", {
		method: "PUT",
		headers: {
			"Content-Type": "application/json"
		},
		body: JSON.stringify(obj)
	}).then(r => {
		if(r.status !== 200) {
			r.text().then(alert);
		} else {
			this.updateMatchList();
		}
	});
};

Editor.prototype.deleteMatch = function(time, matchId) {
	let sure = confirm("You sure?");
	if(sure) {
		this.CancelEditButton.click();
		let vid = this.YoutubePlayer.getVideoData().video_id;
		let obj = {
			vid,
			time,
			matchId
		};
		fetch("/deleteMatch", {
			method: "DELETE",
			headers: {
				"Content-Type": "application/json"
			},
			body: JSON.stringify(obj)
		}).then(r => {
			if(r.status !== 200) {
				r.text().then(alert);
			} else {
				this.updateMatchList();
			}
		});
	}
};

Editor.prototype.goToTime = function(seconds) {
	this.YoutubePlayer.seekTo(seconds);
};

Editor.prototype.addMatch = function() {
	let obj = {
		vid: this.YoutubePlayer.getVideoData().video_id,
		date: this.VideoDate.value,
		time: this.time,
		readableTime: ConvertSecondsToReadable(this.time),
		netplay: this.NetplaySelect.value,
			netcode: this.NetcodeSelect.value,
		p1char: this.P1Char.value,
		p1name: this.P1Name.value.trim(),
		p2char: this.P2Char.value,
		p2name: this.P2Name.value.trim(),
		winner: this.WinnerSelect.value,
		tags: this.VideoTags.value.trim()
	};

	//Add names to the list, if they arent there yet
	this.addNameToLists(this.P1Name.value);
	this.addNameToLists(this.P2Name.value);

	const submitMatch = () => fetch("/addMatch", {
		method: "POST",
		headers: {
			"Content-Type": "application/json"
		},
		body: JSON.stringify(obj)
	});

	submitMatch().then(async r => {
		if(r.status === 409) {
			const result = await r.json();
			if(confirm(result.message)) {
				obj.allowDuplicate = "true";
				const retry = await submitMatch();
				if(retry.status !== 200) {
					alert(await retry.text());
				} else {
					this.advanceCandidateMatch();
					this.updateMatchList();
				}
			}
		} else if(r.status !== 200) {
			alert(await r.text());
		} else {
			this.advanceCandidateMatch();
			this.updateMatchList();
		}
	}).catch(error => alert(error.message));
};

Editor.prototype.addNameToLists = function(name) {
	//Only using p1 list to find if already exists
	let options = this.P1NameList.options;
	for(let i = 0; i < options.length; i++) {
		if(name.toLowerCase() === options[i].value.toLowerCase()) {
			return; //Already exists
		}
	}

	let p1Option = document.createElement("option");
	p1Option.value = name;
	this.P1NameList.appendChild(p1Option);
	let p2Option = document.createElement("option");
	p2Option.value = name;
	this.P2NameList.appendChild(p2Option);
};

Editor.prototype.loadYoutubePlayer = function() {
	let id = GetVideoId(this.VideoURLInput.value);

	if(id.length !== 11) {
		return alert("Bad video URL.");
	}

	this.PlayerLoaderForm.setAttribute("hidden", 1);
	this.EditorGuide.setAttribute("hidden", 1);
	this.VideoDataForm.removeAttribute("hidden");
	this.NewMatchForm.removeAttribute("hidden");
	this.ResultsList.removeAttribute("hidden");

	this.YoutubePlayer = new YT.Player("YoutubePlayer", {
		height: "450",
		width: "1000",
		autoplay: true,
		rel: 0,
		videoId: id,
		events: {
			onReady: () => {
				this.YoutubePlayer.setVolume(10);
			}
		}
	});

	const candidatePrefill = this.candidatePrefill;
	this.candidatePrefill = null;
	this.updateMatchList(id, candidatePrefill);
	window.history.pushState("","","?videoId=" + id);
};

Editor.prototype.changeTime = function(amount) {
	if(this.YoutubePlayer && this.YoutubePlayer.getCurrentTime) {
		let time = parseInt(this.YoutubePlayer.getCurrentTime());
		let newTime = time + amount;
		this.YoutubePlayer.seekTo(newTime);
	}
};

function GetVideoId(url) {
	let ID = null;

	if(url.length === 11) {
		url = "v=" + url;
	}

	url = url.replace(/(>|<)/gi, "").split(/(vi\/|v=|\/v\/|youtu\.be\/|\/embed\/)/);

	if(url[2] !== undefined) {
		ID = url[2].split(/[^0-9a-z_\-]/i);
		ID = ID[0];
	} else {
		ID = url;
	}

	return ID;
}

function ConvertSecondsToReadable(time) {
	time = parseInt(time, 10);

	if(time === 0) {
		return "0s";
	}

	let hours = 0;
	let minutes = 0;
	let seconds = 0;

	while(true) {
		if(time >= 3600) {
			hours++;
			time -= 3600;
			continue;
		}
		if(time >= 60) {
			minutes++;
			time -= 60;
			continue;
		}
		seconds = time;
		break;
	}

	let str = "";
	if(hours > 0 || (minutes === 0 && seconds === 0)) {
		str += `${hours}h`;
	}
	if(minutes > 0 || (hours === 0 && seconds === 0)) {
		str += `${minutes}m`;
	}
	if(seconds > 0 || (minutes === 0 && hours === 0)) {
		str += `${seconds}s`;
	}

	return str;
}