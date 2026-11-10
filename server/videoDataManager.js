const fs = require("fs");
const utils = require("./functions/timeUtils.js");
const database = require("./database.js");

function VideoDataManager(cfg) {
    this.filename = cfg.matchData;
    this.printCloseTimedMatches = false;
}

VideoDataManager.prototype.parseData = function(data) {
    const output = {};
    let currentVideoId = null;

    for(let line of data.split(/\r?\n/)) {
        line = line.trim();

        if(line.length === 0) {
            currentVideoId = null;
            continue;
        }

        if(!currentVideoId) {
            let split = line.split("\t").map(x => x.trim());
            currentVideoId = split[0];

            output[currentVideoId] = {
                id: currentVideoId,
                date: split[1],
                netplay: split[2],
                tags: split[3] ? split[3].split("|") : [],
                netcode: split[5] || "",
                provIP: split[4] ? split[4] : null,
                matches: []
            };
        } else {
            let split = line.split("\t").map(x => x.trim());

            output[currentVideoId].matches.push({
                orderIndex: output[currentVideoId].matches.length + 1,
                time: parseInt(split[0]),
                readableTime: utils.convertSecondsToReadable(split[0]),
                p1char: split[1],
                p1name: split[2],
                p2char: split[3],
                p2name: split[4],
                winner: split[5],
                videoData: output[currentVideoId]
            });
        }
    }

    for(let vid in output) {
        output[vid].matches.sort((a, b) => a.time - b.time);
    }

    return output;
};

VideoDataManager.prototype.getJSON = function() {
    return this.parseData(fs.readFileSync(this.filename, "utf8"));
};

VideoDataManager.prototype.loadJSON = async function() {
    if(!process.env.DATABASE_URL) {
        return this.getJSON();
    }

    const initialData = fs.readFileSync(this.filename, "utf8");
    await database.initialize(initialData);

    const rows = await database.loadMatchData();
    const output = {};
    const tagsByVideo = new Map();
    const matchesByVideo = new Map();

    rows.tags.forEach(row => {
        if(!tagsByVideo.has(row.video_id)) {
            tagsByVideo.set(row.video_id, []);
        }
        tagsByVideo.get(row.video_id).push(row.tag);
    });

    rows.matches.forEach(row => {
        if(!matchesByVideo.has(row.video_id)) {
            matchesByVideo.set(row.video_id, []);
        }
        matchesByVideo.get(row.video_id).push(row);
    });

    rows.videos.forEach(row => {
        const video = {
            id: row.youtube_id,
            date: row.video_date instanceof Date
                ? row.video_date.toISOString().slice(0, 10)
                : String(row.video_date).slice(0, 10),
            netplay: row.netplay,
            tags: tagsByVideo.get(row.youtube_id) || [],
            netcode: row.netcode || "",
            provIP: row.provisional_ip || null,
            matches: []
        };

        (matchesByVideo.get(row.youtube_id) || []).forEach(match => {
            video.matches.push({
                id: String(match.id),
                orderIndex: video.matches.length + 1,
                time: match.timestamp_seconds,
                readableTime: utils.convertSecondsToReadable(match.timestamp_seconds),
                p1char: match.p1_character,
                p1name: match.p1_name,
                p2char: match.p2_character,
                p2name: match.p2_name,
                winner: String(match.winner),
                videoData: video
            });
        });

        output[video.id] = video;
    });

    return output;
};

VideoDataManager.prototype.serializeData = function(json) {
    let str = "";

    for(let vid in json) {
        if(str.length !== 0) str += "\n";

        let data = json[vid];
        str += `${vid}\t${data.date}\t${data.netplay}\t${data.tags.map(t => t.trim()).join("|")}\t${data.provIP || ""}\t${data.netcode || ""}\n`;

        data.matches.sort((a, b) => a.time - b.time);

        data.matches.forEach(m => {
            str += `${m.time}\t${m.p1char}\t${m.p1name}\t`;
            str += `${m.p2char}\t${m.p2name}\t${m.winner}\n`;
        });
    }

    return str;
};

VideoDataManager.prototype.saveData = async function(json) {
    if(process.env.DATABASE_URL) {
        await database.saveMatchData(json);
    } else {
        const data = this.serializeData(json);
        fs.writeFileSync(this.filename, data);
    }
};

module.exports = VideoDataManager;
