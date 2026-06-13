'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');
const zlib = require('zlib');
const youtubedl = require('youtube-dl-exec');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Set cache directory for yt-dlp
process.env.XDG_CACHE_HOME = path.join(__dirname, '.cache');

// Health Check
app.get('/health', (req, res) => res.status(200).json({ ok: true, port: PORT, build: 'pot-provider-2' }));

// Get system yt-dlp path if available
let systemYtDlp = 'yt-dlp';
try {
    systemYtDlp = execSync('which yt-dlp', { encoding: 'utf8' }).trim() || 'yt-dlp';
} catch (e) {
    // Falls back to search in PATH
}

// Always use the system yt-dlp (has the PO token plugin) instead of the
// binary bundled with youtube-dl-exec.
const ytdlp = (systemYtDlp && systemYtDlp !== 'yt-dlp')
    ? youtubedl.create(systemYtDlp)
    : youtubedl;

// Save cookies from browser
app.post('/api/cookies', express.text({ type: '*/*', limit: '4mb' }), (req, res) => {
    const content = req.body;
    if (!content || typeof content !== 'string' || content.trim().length < 10) {
        return res.status(400).json({ error: 'Cookie content appears empty or invalid.' });
    }
    try {
        fs.writeFileSync(path.join(__dirname, 'cookies.txt'), content.trim() + '\n');
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to save cookies: ' + e.message });
    }
});

// Check if cookies are already configured
app.get('/api/cookies/status', (req, res) => {
    const cookiePath = path.join(__dirname, 'cookies.txt');
    try {
        if (!fs.existsSync(cookiePath)) return res.json({ hasCookies: false, entries: 0, reason: 'no file' });
        const content = fs.readFileSync(cookiePath, 'utf8');
        const entries = content.split('\n').filter(l => l && !l.startsWith('#')).length;
        res.json({ hasCookies: entries > 0, entries, sizeBytes: content.length });
    } catch (e) {
        res.json({ hasCookies: false, entries: 0, reason: e.message });
    }
});

// Diag Route
app.get('/api/diag', async (req, res) => {
    const results = {
        path: process.env.PATH,
        node: process.version,
        platform: process.platform,
        cwd: process.cwd(),
        systemYtDlp,
        proxyConfigured: Boolean(process.env.PROXY_URL),
        potProvider: 'unreachable',
        bins: {}
    };
    try {
        const ping = await fetch('http://127.0.0.1:4416/ping', { signal: AbortSignal.timeout(3000) });
        results.potProvider = ping.ok ? 'running' : `status ${ping.status}`;
    } catch (e) { /* provider not running */ }
    const checkBins = ['yt-dlp', 'ffmpeg', 'python3', 'python'];
    for (const b of checkBins) {
        try {
            results.bins[b] = execSync(`which ${b}`, { encoding: 'utf8' }).trim();
        } catch (e) {
            results.bins[b] = 'NOT_FOUND';
        }
    }
    res.json(results);
});

// Helper for common yt-dlp options
function getYtDlpOptions(url, extra = {}) {
    const isInstagram = url.includes('instagram.com');
    const isYoutube = url.includes('youtube.com') || url.includes('youtu.be');
    let domain = new URL(url).hostname.replace('www.', '');
    if (domain === 'youtu.be') domain = 'youtube.com';
    
    // Modern mobile User-Agent for Instagram, Desktop for others
    const userAgent = isInstagram 
        ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

    const options = {
        noPlaylist: true,
        noCheckCertificates: true,
        geoBypass: true,
        // Route yt-dlp through a proxy when the host's shared IP is
        // rate-limited (HTTP 429) by YouTube. Set PROXY_URL in Railway, e.g.
        // http://user:pass@host:port or socks5://host:port
        ...(process.env.PROXY_URL ? { proxy: process.env.PROXY_URL } : {}),
        addHeader: [
            `referer:https://www.${domain}/`,
            `user-agent:${userAgent}`,
            'accept-language:en-US,en;q=0.9',
        ],
        ...extra
    };

    // Instagram: slow down to avoid rate-limits
    if (isInstagram) {
        options.sleepRequests = 2;
        options.retries = 5;
        options.fragmentRetries = 5;
    }

    // YouTube specific improvements
    if (isYoutube) {
        options.retries = 5;
        options.fragmentRetries = 5;
        // Allow yt-dlp to download JS challenge solvers from GitHub (uses Deno, already installed)
        options.remoteComponents = 'ejs:github';

        if (process.env.YOUTUBE_OAUTH_TOKEN) {
            options.username = 'oauth2';
        }

        if (process.env.PO_TOKEN) {
            const visitorData = process.env.VISITOR_DATA || '';
            options.extractorArgs = `youtube:po_token=web+${process.env.PO_TOKEN}${visitorData ? ';visitor_data=' + visitorData : ''}`;
        }
    }

    const cookiePath = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(cookiePath) && fs.statSync(cookiePath).size > 20) {
        options.cookies = cookiePath;
    }
    return options;
}

// ── Routes ───────────────────────────────────────────────────────────────────

// Stale/rotated cookies don't just fail — they actively trigger YouTube's
// bot check, so a bot-check error is also a reason to retry without cookies.
const INVALID_COOKIE_SIGNALS = [
    'no longer valid', 'cookies have been rotated', 'cookies are invalid',
    'not a bot', 'sign in to confirm',
];

function cookiesInvalid(msg) {
    return INVALID_COOKIE_SIGNALS.some(s => msg.toLowerCase().includes(s));
}

async function runInfo(url, useCookies = true) {
    const opts = getYtDlpOptions(url, { dumpJson: true });
    if (!useCookies) delete opts.cookies;
    return ytdlp(url, opts);
}

app.post('/api/info', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    try {
        console.log(`[info] Fetching: ${url}`);

        let info;
        try {
            info = await runInfo(url, true);
        } catch (firstErr) {
            if (cookiesInvalid(firstErr.message || '')) {
                console.warn('[info] Cookies invalid — retrying without cookies...');
                info = await runInfo(url, false);
            } else {
                throw firstErr;
            }
        }

        const formats = [];
        formats.push({ id: 'bestvideo+bestaudio/best', label: '🏆 Best Quality (auto)', ext: 'mp4' });

        const availableHeights = [
            ...new Set(
                (info.formats || [])
                    .filter(f => f.height && f.vcodec !== 'none')
                    .map(f => f.height)
            ),
        ].sort((a, b) => b - a);

        for (const h of availableHeights) {
            formats.push({
                // Fallback to best[height<=h] (combined stream) so audio is always present
                id: `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`,
                label: `${h}p`,
                ext: 'mp4',
            });
        }

        formats.push({ id: 'bestaudio/best', label: '🎵 Audio only (MP3)', ext: 'mp3' });

        res.json({
            title: info.title,
            thumbnail: info.thumbnail,
            duration: info.duration,
            uploader: info.uploader || info.channel || '',
            platform: info.extractor_key || '',
            viewCount: info.view_count || 0,
            likeCount: info.like_count || 0,
            formats,
        });
    } catch (err) {
        console.error('[/api/info] Error:', err.message);
        
        const msg = err.message || '';
        let errorMessage = 'Failed to fetch video info.';
        let needsCookies = false;

        if (msg.includes('429') || msg.includes('rate-limit') || msg.includes('rate limit')) {
            errorMessage = 'Rate-limited by the platform (Error 429). Try again in a moment.';
            needsCookies = true;
        } else if (msg.includes('login required') || msg.includes('login page') || msg.includes('cookies')) {
            errorMessage = 'Login or cookies required to access this content.';
            needsCookies = true;
        } else if (msg.toLowerCase().includes('not a bot') || msg.includes('Sign in to confirm')) {
            errorMessage = 'YouTube bot detection triggered. Your saved cookies may have expired — please upload fresh cookies.';
            needsCookies = true;
        } else if (msg.includes('Video unavailable') || msg.includes('not available')) {
            errorMessage = 'This video is unavailable or private.';
        } else if (msg.includes('Premiere') || msg.includes('upcoming')) {
            errorMessage = 'This video is a scheduled premiere and not yet available.';
        }

        res.status(500).json({
            error: errorMessage,
            details: msg,
            needsCookies,
        });
    }
});

app.post('/api/download', async (req, res) => {
    const { url, formatId, title, ext } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const safeTitle = (title || 'video').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_') || 'video';
    const filename = `${safeTitle}.${ext === 'mp3' ? 'mp3' : 'mp4'}`;
    const tmpDir = os.tmpdir();
    const tmpBase = path.join(tmpDir, `vg_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    const tmpOut = `${tmpBase}.%(ext)s`;

    try {
        console.log(`[download] Starting: ${url} (Format: ${formatId})`);

        const dlOptions = getYtDlpOptions(url, {
            mergeOutputFormat: 'mp4',
            output: tmpOut
        });

        if (formatId === 'bestaudio/best') {
            dlOptions.format = 'bestaudio/best';
            dlOptions.extractAudio = true;
            dlOptions.audioFormat = 'mp3';
        } else {
            dlOptions.format = formatId || 'bestvideo+bestaudio/best';
        }

        try {
            await ytdlp(url, dlOptions);
        } catch (firstErr) {
            if (cookiesInvalid(firstErr.message || '') && dlOptions.cookies) {
                console.warn('[download] Cookies rejected — retrying without cookies...');
                delete dlOptions.cookies;
                await ytdlp(url, dlOptions);
            } else {
                throw firstErr;
            }
        }

        const pattern = `${path.basename(tmpBase)}`;
        const written = fs.readdirSync(tmpDir).find(f => f.startsWith(pattern));
        if (!written) throw new Error('Download failed: Output file not found');

        const filePath = path.join(tmpDir, written);
        const stat = fs.statSync(filePath);

        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', stat.size);

        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
        stream.on('close', () => {
            fs.unlink(filePath, () => { });
        });

    } catch (err) {
        console.error('[/api/download] Error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Download failed. Please try a different format.' });
    }
});

// ── Helpers ───────────────────────────────────────────────────────────────

function runYtDlp(args) {
    return new Promise((resolve, reject) => {
        const bin = systemYtDlp || 'yt-dlp';
        console.log(`[runYtDlp] Executing: ${bin} ${args.join(' ')}`);
        const proc = spawn(bin, args);
        let out = '', err = '';
        proc.stdout.on('data', d => (out += d));
        proc.stderr.on('data', d => (err += d));
        proc.on('close', code => code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`)));
        proc.on('error', (err) => {
            console.error(`[runYtDlp] Error:`, err);
            reject(new Error(`yt-dlp execution failed: ${err.message}`));
        });
    });
}

// ── Initialization ──────────────────────────────────────────────────────────

async function initCookies() {
    const cookiePath = path.join(__dirname, 'cookies.txt');

    if (process.env.COOKIES_B64) {
        try {
            const raw = Buffer.from(process.env.COOKIES_B64, 'base64');
            let content;
            try {
                content = zlib.gunzipSync(raw).toString('utf8');
            } catch {
                content = raw.toString('utf8');
            }
            fs.writeFileSync(cookiePath, content);
            const lines = content.split('\n').filter(l => l && !l.startsWith('#')).length;
            console.log(`✅ Cookies loaded from COOKIES_B64 — ${lines} cookie entries, ${content.length} chars.`);
            if (lines === 0) console.warn('⚠️  WARNING: cookies.txt has 0 entries — COOKIES_B64 may be empty or invalid!');
        } catch (e) {
            console.error('❌ Failed to decode COOKIES_B64:', e.message);
        }
        return;
    }

    if (fs.existsSync(cookiePath) && fs.statSync(cookiePath).size > 20) {
        console.log('✅ Using existing cookies.txt.');
    } else {
        console.log('⚠️  No cookies configured — Instagram/YouTube may rate-limit.');
    }
}

async function initOAuth() {
    if (process.env.YOUTUBE_OAUTH_TOKEN) {
        console.log('🔄 Injecting YouTube OAuth2 Token from environment...');
        const cacheDir = path.join(process.env.XDG_CACHE_HOME, 'yt-dlp');
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

        try {
            // We expect a Base64 encoded JSON string
            const decoded = Buffer.from(process.env.YOUTUBE_OAUTH_TOKEN, 'base64').toString();
            const tokenData = JSON.parse(decoded);
            
            // yt-dlp saves tokens in youtube.cache as a binary/JSON hybrid, 
            // but we can just write the cache file it expects.
            // Specifically, for oauth2, it saves to youtube-oauth2.cache or similar depending on version.
            // The most robust way is to just write the file.
            const cachePath = path.join(cacheDir, 'youtube.cache');
            fs.writeFileSync(cachePath, JSON.stringify(tokenData));
            console.log('✅ OAuth2 Cache injected successfully.');
        } catch (e) {
            console.error('❌ Failed to inject OAuth2 token:', e.message);
        }
    }
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async (err) => {
    if (err) {
        console.error('❌ Failed to start server:', err);
        process.exit(1);
    }
    await initCookies();
    await initOAuth();
    console.log(`🎬 Server is LIVE on port ${PORT}`);
    console.log(`🔍 yt-dlp path: ${systemYtDlp}`);
});
