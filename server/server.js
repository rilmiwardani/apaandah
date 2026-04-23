const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { WebcastPushConnection } = require('tiktok-live-connector');
const ytSearch = require('yt-search');
const path = require('path');
const { spawn } = require('child_process');


// --- CONFIG ---
const PORT = 3000;
const TIKTOK_USERNAME = process.argv[2];


if (!TIKTOK_USERNAME) {
    console.error('\n❌ Masukkan username TikTok!');
    console.log('💡 node server.js username\n');
    process.exit(1);
}


const MAX_QUEUE = 10;
const REQUEST_COOLDOWN = 10000; // 10 detik


// --- SERVER ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });


app.use(express.static(path.join(__dirname, '/')));


// --- STATE ---
let musicQueue = [];
let isPlaying = false;
let currentTrack = null;
let isProcessing = false;


const userCooldown = new Map();


// -------------------------------------------------------
// STREAM ENDPOINT — proxy audio via yt-dlp
// Frontend cukup set: <audio src="/stream/VIDEO_ID">
// -------------------------------------------------------
app.get('/stream/:videoId', (req, res) => {
    const videoId = req.params.videoId;
    const url = `https://www.youtube.com/watch?v=${videoId}`;

    // Argumen yt-dlp: ambil audio terbaik, output ke stdout
    const args = [
        '-f', 'bestaudio',
        '--no-playlist',
        '-o', '-',             // output ke stdout
        '--quiet',
        '--no-warnings',
        url
    ];

    // Jika punya cookies YouTube (opsional, bantu bypass pembatasan lebih lanjut)
    // taruh file cookies.txt di folder yang sama, uncomment baris di bawah:
    // args.unshift('--cookies', path.join(__dirname, 'cookies.txt'));

    const ytdlp = spawn('yt-dlp', args);

    // Set header sebelum data mengalir
    res.setHeader('Content-Type', 'audio/webm');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');

    // Pipe stdout yt-dlp langsung ke response
    ytdlp.stdout.pipe(res);

    ytdlp.stderr.on('data', (data) => {
        // Hanya log error yang penting, abaikan progress normal
        const msg = data.toString();
        if (msg.includes('ERROR') || msg.includes('error')) {
            console.error(`[yt-dlp ERROR] ${msg.trim()}`);
        }
    });

    ytdlp.on('error', (err) => {
        console.error(`❌ yt-dlp tidak ditemukan: ${err.message}`);
        console.error('💡 Install dengan: pip install yt-dlp  atau  pip3 install yt-dlp');
        if (!res.headersSent) {
            res.status(500).json({ error: 'yt-dlp tidak terinstall' });
        }
    });

    ytdlp.on('close', (code) => {
        if (code !== 0 && code !== null) {
            console.warn(`[yt-dlp] Proses selesai dengan kode: ${code}`);
        }
    });

    // Jika client disconnect, kill proses yt-dlp agar tidak bocor
    req.on('close', () => {
        ytdlp.kill('SIGTERM');
    });

    res.on('error', () => {
        ytdlp.kill('SIGTERM');
    });
});


// --- TIKTOK ---
const tiktokLiveConnection = new WebcastPushConnection(TIKTOK_USERNAME);


// reconnect loop
async function connectTikTok() {
    try {
        const state = await tiktokLiveConnection.connect();
        console.log(`✅ Terhubung ke TikTok @${state.roomId}`);
    } catch (err) {
        console.error('❌ Gagal konek, retry 5 detik...');
        setTimeout(connectTikTok, 5000);
    }
}
connectTikTok();


tiktokLiveConnection.on('connected', () => {
    console.log('🟢 CONNECTED');
});


tiktokLiveConnection.on('disconnected', () => {
    console.log('🔌 DISCONNECTED');
});


tiktokLiveConnection.on('error', (err) => {
    console.error('❌ ERROR:', err);
});


// --- UTIL ---
function canRequest(userId) {
    const now = Date.now();
    const last = userCooldown.get(userId) || 0;


    if (now - last < REQUEST_COOLDOWN) return false;


    userCooldown.set(userId, now);
    return true;
}


// --- CHAT EVENT ---
tiktokLiveConnection.on('chat', async (data) => {
    const msg = data.comment.trim();


    const isHost = data.uniqueId === TIKTOK_USERNAME;
    const isMod = data.isModerator;
    const isFollower = data.followRole >= 1;


    let role = "NON-FOLLOWER";
    if (isHost) role = "HOST";
    else if (isMod) role = "MOD";
    else if (isFollower) role = "FOLLOWER";


    console.log(`[${role}] ${data.nickname}: ${msg}`);


    if (!isHost && !isMod && !isFollower) {
        console.log(`[BLOCKED] ${data.nickname}`);
        return;
    }


    broadcast('chat', { ...data, role });


    // --- PLAY COMMAND ---
    if (msg.toLowerCase().startsWith('!play ')) {
        if (!canRequest(data.uniqueId)) {
            console.log(`[COOLDOWN] ${data.nickname}`);
            return;
        }

        if (musicQueue.length >= MAX_QUEUE) {
            console.log(`[QUEUE FULL]`);
            return;
        }

        const query = msg.substring(6).trim();
        if (query.length > 0) {
            handlePlayRequest(query, data);
        }
    }


    // --- SKIP COMMAND ---
    if (msg.toLowerCase() === '!skip') {
        if (isHost || isMod) {
            console.log(`[SKIP] oleh ${data.nickname}`);
            playNext();
        }
    }
});


// --- GIFT EVENT ---
tiktokLiveConnection.on('gift', (data) => {
    console.log(`🎁 ${data.nickname} kirim ${data.giftName}`);
    broadcast('gift', data);
});


// --- MUSIC ---
async function handlePlayRequest(query, userData) {
    try {
        console.log(`🔎 Cari: ${query}`);


        const result = await ytSearch(query);


        if (!result || result.videos.length === 0) {
            console.log(`❌ Tidak ditemukan: ${query}`);
            return;
        }


        const video = result.videos[0];


        const track = {
            id: video.videoId,
            title: video.title,
            artist: video.author.name,
            thumbnail: video.thumbnail,
            duration: video.duration.timestamp,
            // URL stream langsung dari backend — tidak ada masalah copyright di browser
            streamUrl: `/stream/${video.videoId}`,
            requester: {
                nickname: userData.nickname,
                uniqueId: userData.uniqueId
            }
        };


        musicQueue.push(track);


        console.log(`➕ Queue: ${track.title}`);


        broadcast('queue_update', musicQueue);


        processQueue();


    } catch (e) {
        console.error("❌ Error YouTube:", e.message);
    }
}


function processQueue() {
    if (isProcessing || isPlaying) return;


    isProcessing = true;
    playNext();
    isProcessing = false;
}


function playNext() {
    if (musicQueue.length > 0) {
        isPlaying = true;
        currentTrack = musicQueue.shift();


        console.log(`▶️ Play: ${currentTrack.title}`);


        broadcast('play_track', currentTrack);
        broadcast('queue_update', musicQueue);


    } else {
        isPlaying = false;
        currentTrack = null;


        console.log(`⏹ Queue kosong`);


        broadcast('player_stop', {});
    }
}


// --- WEBSOCKET ---
function broadcast(type, data) {
    wss.clients.forEach(client => {
        if (client.readyState !== WebSocket.OPEN) {
            client.terminate();
            return;
        }


        try {
            client.send(JSON.stringify({ event: type, data }));
        } catch (e) {
            console.error("WS error:", e.message);
        }
    });
}


// --- CLIENT ---
wss.on('connection', (ws) => {
    console.log('🌐 Frontend terhubung');


    if (currentTrack) {
        ws.send(JSON.stringify({ event: 'play_track', data: currentTrack }));
    }


    ws.send(JSON.stringify({ event: 'queue_update', data: musicQueue }));


    ws.on('message', (message) => {
        try {
            const parsed = JSON.parse(message);


            if (parsed.type === 'track_finished') {
                playNext();
            }


            if (parsed.type === 'simulate_chat') {
                const data = parsed.data;
                const msg = data.comment.trim();


                console.log(`[SIMULASI] ${msg}`);


                if (msg.toLowerCase().startsWith('!play ')) {
                    handlePlayRequest(msg.substring(6), data);
                }


                if (msg.toLowerCase() === '!skip') {
                    playNext();
                }
            }


        } catch (e) {
            console.error("❌ Parse error:", e.message);
        }
    });
});


// --- START ---
server.listen(PORT, () => {
    console.log(`\n🚀 Server: http://localhost:${PORT}`);
    console.log(`🎯 TikTok: @${TIKTOK_USERNAME}`);
    console.log(`🎵 Stream: http://localhost:${PORT}/stream/<videoId>\n`);
});