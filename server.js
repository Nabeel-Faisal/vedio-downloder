'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');
const { Readable } = require('stream');
const zlib = require('zlib');
const youtubedl = require('youtube-dl-exec');

const RAPIDAPI_HOST = 'youtube-media-downloader.p.rapidapi.com';
const RAPIDAPI_SOCIAL_HOST = 'social-media-video-downloader.p.rapidapi.com';
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';

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
        rapidApiConfigured: Boolean(RAPIDAPI_KEY),
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
    const isTiktok = url.includes('tiktok.com');
    const isYoutube = url.includes('youtube.com') || url.includes('youtu.be');
    let domain = new URL(url).hostname.replace('www.', '');
    if (domain === 'youtu.be') domain = 'youtube.com';

    // Modern mobile User-Agent for Instagram, Desktop for others
    const userAgent = isInstagram
        ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

    // Proxy: only use it where it actually helps. Webshare datacenter IPs are
    // flagged by TikTok the same way they are by YouTube, so routing TikTok
    // through the proxy breaks downloads. Default: no proxy for TikTok.
    // Set FORCE_PROXY=1 to override.
    const useProxy = process.env.PROXY_URL && (process.env.FORCE_PROXY === '1' || !isTiktok);

    const options = {
        noPlaylist: true,
        noCheckCertificates: true,
        geoBypass: true,
        ...(useProxy ? { proxy: process.env.PROXY_URL } : {}),
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

// ── YouTube URL helpers ──────────────────────────────────────────────────────

function isYoutubeUrl(url) {
    return /youtube\.com|youtu\.be/i.test(url);
}

function extractYoutubeId(url) {
    const m =
        url.match(/youtu\.be\/([\w-]{6,})/) ||
        url.match(/[?&]v=([\w-]{6,})/) ||
        url.match(/\/shorts\/([\w-]{6,})/) ||
        url.match(/\/embed\/([\w-]{6,})/);
    return m ? m[1] : null;
}

// Legacy DataFanatic YouTube API — kept as fallback via LEGACY_YOUTUBE_HOST env.
// Emmanuel David's Social Media Video Downloader is the primary path now
// (see fetchYoutubeMetaSocial below).
async function fetchYoutubeMeta(videoId) {
    if (!RAPIDAPI_KEY) throw new Error('RAPIDAPI_KEY not set');
    const url = `https://${RAPIDAPI_HOST}/v2/video/details?videoId=${encodeURIComponent(videoId)}&urlAccess=normal&videos=auto&audios=auto`;
    const resp = await fetch(url, {
        headers: {
            'x-rapidapi-host': RAPIDAPI_HOST,
            'x-rapidapi-key': RAPIDAPI_KEY,
        },
    });
    if (!resp.ok) throw new Error(`RapidAPI HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.errorId && data.errorId !== 'Success') throw new Error(`RapidAPI: ${data.errorId}`);
    return data;
}

function pickOriginalAudio(items) {
    if (!items || !items.length) return null;
    const original = items.find(a => !/dubbed-auto/.test(a.url));
    return original || items[0];
}

function pickVideoStream(items, formatId) {
    const mp4s = items.filter(v => v.extension === 'mp4');
    if (formatId === 'rapid:best') {
        const qOrder = ['1080p', '720p', '480p', '360p', '240p', '144p'];
        for (const q of qOrder) {
            const m = mp4s.find(v => v.quality === q);
            if (m) return m;
        }
        return mp4s[0];
    }
    const q = formatId.replace('rapid:', '');
    return mp4s.find(v => v.quality === q) || null;
}

function buildYoutubeFormats(data) {
    const formats = [{ id: 'rapid:best', label: '🏆 Best Quality (auto)', ext: 'mp4' }];
    const videos = (data.videos && data.videos.items) || [];
    const seen = new Set();
    for (const q of ['1080p', '720p', '480p', '360p', '240p', '144p']) {
        const m = videos.find(v => v.quality === q && v.extension === 'mp4');
        if (m && !seen.has(q)) {
            seen.add(q);
            formats.push({ id: `rapid:${q}`, label: q, ext: 'mp4', filesize: m.size });
        }
    }
    const audio = pickOriginalAudio((data.audios && data.audios.items) || []);
    formats.push({ id: 'rapid:audio', label: '🎵 Audio only (MP3)', ext: 'mp3', filesize: audio ? audio.size : undefined });
    return formats;
}

async function pipeUpstreamToResponse(url, res) {
    const upstream = await fetch(url);
    if (!upstream.ok || !upstream.body) throw new Error(`Upstream ${upstream.status}`);
    const len = upstream.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);
    Readable.fromWeb(upstream.body).pipe(res);
}

function spawnFfmpegMerge(videoUrl, audioUrl) {
    return spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-i', videoUrl,
        '-i', audioUrl,
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
        '-f', 'mp4',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        'pipe:1',
    ]);
}

function spawnFfmpegMp3(audioUrl) {
    return spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-i', audioUrl,
        '-vn', '-c:a', 'libmp3lame', '-q:a', '2',
        '-f', 'mp3',
        'pipe:1',
    ]);
}

function attachFfmpegToResponse(ff, res) {
    ff.stdout.pipe(res);
    ff.stderr.on('data', d => console.error('[ffmpeg]', d.toString().trim()));
    res.on('close', () => { try { ff.kill('SIGKILL'); } catch {} });
    ff.on('error', err => {
        console.error('[ffmpeg] spawn error:', err.message);
        if (!res.headersSent) res.status(500).end();
    });
}

// ── RapidAPI (Instagram / TikTok — Social Media Video Downloader) ───────────

function isInstagramUrl(url) {
    return /instagram\.com/i.test(url);
}

function isTiktokUrl(url) {
    return /tiktok\.com/i.test(url);
}

function extractInstagramShortcode(url) {
    const m =
        url.match(/instagram\.com\/reel\/([^/?#]+)/) ||
        url.match(/instagram\.com\/p\/([^/?#]+)/) ||
        url.match(/instagram\.com\/tv\/([^/?#]+)/);
    return m ? m[1] : null;
}

function extractTiktokPostId(url) {
    const m =
        url.match(/tiktok\.com\/[^/]+\/video\/(\d+)/) ||
        url.match(/tiktok\.com\/v\/(\d+)/) ||
        url.match(/vm\.tiktok\.com\/(\w+)/);
    return m ? m[1] : null;
}

function normalizeTiktokUrl(url) {
    // Strip tracking params so the API sees a clean URL.
    try {
        const u = new URL(url);
        return `${u.origin}${u.pathname}`;
    } catch {
        return url;
    }
}

async function fetchSocialMedia(pathAndQuery) {
    if (!RAPIDAPI_KEY) throw new Error('RAPIDAPI_KEY not set');
    const url = `https://${RAPIDAPI_SOCIAL_HOST}${pathAndQuery}`;
    const resp = await fetch(url, {
        headers: {
            'x-rapidapi-host': RAPIDAPI_SOCIAL_HOST,
            'x-rapidapi-key': RAPIDAPI_KEY,
        },
    });
    if (!resp.ok) throw new Error(`RapidAPI HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.error) throw new Error(`RapidAPI: ${data.error.message || data.error}`);
    return data;
}

async function fetchInstagramMeta(shortcode) {
    return fetchSocialMedia(`/instagram/v3/media/post/details?shortcode=${encodeURIComponent(shortcode)}&renderableFormats=720p%2Chighres`);
}

async function fetchYoutubeMetaSocial(videoId) {
    // renderableFormats=all asks the API for every quality it can serve
    return fetchSocialMedia(`/youtube/v3/video/details?videoId=${encodeURIComponent(videoId)}&urlAccess=normal&renderableFormats=all&getTranscript=false`);
}

// YouTube oEmbed: free, no key required. Gives us title, uploader, thumbnail
// for any public video — the Social API's YouTube endpoint doesn't include them.
async function fetchYoutubeOembed(videoId) {
    try {
        const resp = await fetch(`https://www.youtube.com/oembed?url=https://youtu.be/${encodeURIComponent(videoId)}&format=json`);
        if (!resp.ok) return null;
        return await resp.json();
    } catch {
        return null;
    }
}

// TikTok oEmbed: also free and public.
async function fetchTiktokOembed(tiktokUrl) {
    try {
        const clean = normalizeTiktokUrl(tiktokUrl);
        const resp = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(clean)}`);
        if (!resp.ok) return null;
        return await resp.json();
    } catch {
        return null;
    }
}

// Instagram doesn't have a working public oEmbed anymore. Try scraping OG
// tags from a few URL variants using a Meta-crawler user-agent, which
// Instagram is friendlier to than a generic browser UA.
async function fetchInstagramOgTags(igUrl) {
    const pick = (html, prop) => {
        const m = html.match(new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i')) ||
                  html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${prop}["']`, 'i'));
        return m ? m[1] : '';
    };

    const clean = igUrl.split('?')[0].replace(/\/?$/, '/');
    const candidates = [
        `${clean}embed/`,
        clean,
    ];
    const userAgents = [
        'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        'Mozilla/5.0 (compatible; Bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    ];

    for (const url of candidates) {
        for (const ua of userAgents) {
            try {
                const resp = await fetch(url, { headers: { 'user-agent': ua, 'accept-language': 'en-US,en;q=0.9' } });
                if (!resp.ok) continue;
                const html = await resp.text();
                const title = pick(html, 'og:title');
                const thumbnail_url = pick(html, 'og:image');
                const description = pick(html, 'og:description');
                if (title || thumbnail_url) {
                    return { title, thumbnail_url, description };
                }
            } catch { /* try next */ }
        }
    }
    return null;
}

async function fetchTiktokMeta(url) {
    const clean = normalizeTiktokUrl(url);
    return fetchSocialMedia(`/tiktok/v3/post/details?url=${encodeURIComponent(clean)}&renderableFormats=720p%2Chighres`);
}

// Walk an object recursively looking for the first non-empty value matching
// one of the candidate field names. Handles arbitrary API response shapes.
function deepFindString(obj, names, maxDepth = 4) {
    if (!obj || maxDepth < 0) return '';
    if (typeof obj === 'string') return '';
    if (Array.isArray(obj)) {
        for (const el of obj) {
            const v = deepFindString(el, names, maxDepth - 1);
            if (v) return v;
        }
        return '';
    }
    if (typeof obj !== 'object') return '';
    for (const name of names) {
        const v = obj[name];
        if (typeof v === 'string' && v.trim()) return v.trim();
    }
    for (const key of Object.keys(obj)) {
        if (key === 'videos' || key === 'audios' || key === 'formats') continue;
        const v = deepFindString(obj[key], names, maxDepth - 1);
        if (v) return v;
    }
    return '';
}

function extractSocialContent(data) {
    const item = (data.contents && data.contents[0]) || {};
    const pickFirst = (...vals) => vals.find(v => v !== undefined && v !== null && v !== '');
    const videos = pickFirst(item.videos, item.items, data.videos, data.items) || [];
    const audios = pickFirst(item.audios, item.audio, data.audios, data.audio) || [];

    const title = deepFindString(data, ['title', 'caption', 'description', 'desc', 'text', 'name', 'headline']) || 'video';
    const thumbnail = deepFindString(data, ['thumbnail_url', 'thumbnailUrl', 'thumbnail', 'cover', 'coverUrl', 'cover_url', 'image', 'display_url', 'displayUrl', 'imageUrl', 'poster']) || '';
    const uploader = deepFindString(data, ['author_name', 'authorName', 'username', 'uploader', 'channel', 'creator', 'ownerUsername', 'displayName']) || '';
    const duration = pickFirst(item.durationSeconds, data.durationSeconds, item.lengthSeconds, data.lengthSeconds, item.duration, data.duration) || 0;
    return { videos, audios, title, thumbnail, uploader, duration };
}

// Read metadata off a video item — the Social API's YouTube endpoint nests
// most fields inside metadata; Instagram/TikTok put them at the top level.
function videoQualityLabel(v) {
    return (v.metadata && v.metadata.quality_label) || v.label || v.quality || '';
}
function videoMimeType(v) {
    return (v.metadata && v.metadata.mime_type) || v.mimeType || v.mime_type || '';
}
function videoHasAudio(v) {
    if (v.metadata && typeof v.metadata.has_audio === 'boolean') return v.metadata.has_audio;
    if (typeof v.hasAudio === 'boolean') return v.hasAudio;
    // Instagram/TikTok Reels are single-file with audio baked in
    return true;
}
function videoSize(v) {
    return (v.metadata && v.metadata.content_length) || v.size || 0;
}
function isMp4Video(v) {
    return /mp4/i.test(videoMimeType(v)) || /avc1/i.test(videoMimeType(v));
}

function buildSocialFormats(videos) {
    const formats = [{ id: 'social:best', label: '🏆 Best Quality (auto)', ext: 'mp4' }];
    const mp4s = videos.filter(isMp4Video);
    const pool = mp4s.length ? mp4s : videos;
    const seen = new Set();
    const sorted = [...pool].sort((a, b) => (parseInt(videoQualityLabel(b)) || 0) - (parseInt(videoQualityLabel(a)) || 0));
    for (const v of sorted) {
        const q = videoQualityLabel(v);
        if (!q || seen.has(q)) continue;
        seen.add(q);
        formats.push({ id: `social:${q}`, label: q, ext: 'mp4', filesize: videoSize(v) });
    }
    formats.push({ id: 'social:audio', label: '🎵 Audio only (MP3)', ext: 'mp3' });
    return formats;
}

function pickSocialVideo(videos, formatId) {
    if (!videos || !videos.length) return null;
    const mp4s = videos.filter(isMp4Video);
    const pool = mp4s.length ? mp4s : videos;
    const sorted = [...pool].sort((a, b) => (parseInt(videoQualityLabel(b)) || 0) - (parseInt(videoQualityLabel(a)) || 0));
    if (formatId === 'social:best') return sorted[0];
    const q = formatId.replace('social:', '');
    return sorted.find(v => videoQualityLabel(v) === q) || sorted[0];
}

function pickSocialAudio(audios) {
    if (!audios || !audios.length) return null;
    // Prefer m4a/mp4 audio (works well with ffmpeg copy) over webm
    const m4a = audios.find(a => /mp4|m4a/i.test((a.metadata && a.metadata.mime_type) || a.mimeType || a.extension || ''));
    return m4a || audios[0];
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
    const debug = req.query.debug === '1' || req.body.debug === true;

    if ((isInstagramUrl(url) || isTiktokUrl(url) || isYoutubeUrl(url)) && RAPIDAPI_KEY) {
        try {
            let data, platform, oembed;
            if (isInstagramUrl(url)) {
                const sc = extractInstagramShortcode(url);
                if (!sc) return res.status(400).json({ error: 'Could not extract Instagram shortcode' });
                platform = 'Instagram';
                console.log(`[info] Instagram via RapidAPI: ${sc}`);
                const [socialData, ogTags] = await Promise.all([
                    fetchInstagramMeta(sc),
                    fetchInstagramOgTags(url),
                ]);
                data = socialData;
                oembed = ogTags;
            } else if (isTiktokUrl(url)) {
                platform = 'TikTok';
                console.log(`[info] TikTok via RapidAPI: ${url}`);
                const [socialData, tkOembed] = await Promise.all([
                    fetchTiktokMeta(url),
                    fetchTiktokOembed(url),
                ]);
                data = socialData;
                oembed = tkOembed;
            } else {
                const vid = extractYoutubeId(url);
                if (!vid) return res.status(400).json({ error: 'Could not extract YouTube video ID' });
                platform = 'YouTube';
                console.log(`[info] YouTube via Social RapidAPI: ${vid}`);
                const [socialData, ytOembed] = await Promise.all([
                    fetchYoutubeMetaSocial(vid),
                    fetchYoutubeOembed(vid),
                ]);
                data = socialData;
                oembed = ytOembed;
            }
            const content = extractSocialContent(data);
            try {
                const topKeys = Object.keys(data || {});
                const itemKeys = data && data.contents && data.contents[0] ? Object.keys(data.contents[0]) : [];
                console.log(`[info] ${platform} response keys — top: [${topKeys.join(',')}], contents[0]: [${itemKeys.join(',')}]`);
                console.log(`[info] ${platform} oembed:`, oembed ? Object.keys(oembed).join(',') : 'null');
                console.log(`[info] ${platform} extracted: title="${content.title}", thumb="${content.thumbnail ? 'yes' : 'no'}", uploader="${content.uploader}"`);
            } catch {}
            const response = {
                title: (oembed && oembed.title) || content.title,
                thumbnail: (oembed && oembed.thumbnail_url) || content.thumbnail,
                duration: content.duration,
                uploader: (oembed && oembed.author_name) || content.uploader,
                platform,
                viewCount: 0,
                likeCount: 0,
                formats: buildSocialFormats(content.videos),
            };
            if (debug) {
                const topKeys = Object.keys(data || {});
                const itemKeys = data && data.contents && data.contents[0] ? Object.keys(data.contents[0]) : [];
                response._debug = {
                    topKeys,
                    itemKeys,
                    oembed: oembed || null,
                    extractedTitle: content.title,
                    extractedThumbnail: content.thumbnail,
                    extractedUploader: content.uploader,
                };
            }
            return res.json(response);
        } catch (err) {
            console.error(`[info] Social RapidAPI failed: ${err.message}`);
            return res.status(500).json({
                error: 'Failed to fetch video info.',
                details: err.message,
            });
        }
    }

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

    if ((isInstagramUrl(url) || isTiktokUrl(url) || isYoutubeUrl(url)) && RAPIDAPI_KEY && typeof formatId === 'string' && formatId.startsWith('social:')) {
        try {
            let data;
            if (isInstagramUrl(url)) {
                const sc = extractInstagramShortcode(url);
                if (!sc) return res.status(400).json({ error: 'Could not extract Instagram shortcode' });
                console.log(`[download] Instagram via RapidAPI: ${sc} (${formatId})`);
                data = await fetchInstagramMeta(sc);
            } else if (isTiktokUrl(url)) {
                console.log(`[download] TikTok via RapidAPI: ${url} (${formatId})`);
                data = await fetchTiktokMeta(url);
            } else {
                const vid = extractYoutubeId(url);
                if (!vid) return res.status(400).json({ error: 'Could not extract YouTube video ID' });
                console.log(`[download] YouTube via Social RapidAPI: ${vid} (${formatId})`);
                data = await fetchYoutubeMetaSocial(vid);
            }
            const { videos, audios } = extractSocialContent(data);
            if (!videos.length) return res.status(500).json({ error: 'No downloadable video streams available' });
            const audio = pickSocialAudio(audios);

            if (formatId === 'social:audio') {
                const audioUrl = (audio && audio.url) || (videos[0] && videos[0].url);
                if (!audioUrl) return res.status(500).json({ error: 'No audio stream available' });
                res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
                res.setHeader('Content-Type', 'audio/mpeg');
                const ff = spawnFfmpegMp3(audioUrl);
                attachFfmpegToResponse(ff, res);
                return;
            }

            const chosen = pickSocialVideo(videos, formatId);
            if (!chosen || !chosen.url) return res.status(500).json({ error: 'Requested quality not available' });

            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.setHeader('Content-Type', 'video/mp4');

            if (videoHasAudio(chosen)) {
                await pipeUpstreamToResponse(chosen.url, res);
                return;
            }

            if (!audio || !audio.url) {
                return res.status(500).json({ error: 'Video-only stream but no audio stream available for merge' });
            }
            const ff = spawnFfmpegMerge(chosen.url, audio.url);
            attachFfmpegToResponse(ff, res);
            return;
        } catch (err) {
            console.error(`[download] Social RapidAPI failed: ${err.message}`);
            if (!res.headersSent) res.status(500).json({ error: 'Download failed.', details: err.message });
            return;
        }
    }

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
        if (!res.headersSent) {
            const msg = (err.message || '').toLowerCase();
            let userMsg = 'Download failed. Please try a different format.';
            if (msg.includes('ffmpeg')) userMsg = 'Audio conversion failed. Try downloading as MP4 instead of MP3.';
            else if (msg.includes('unavailable') || msg.includes('private')) userMsg = 'This video is unavailable or private.';
            else if (msg.includes('rate') || msg.includes('429')) userMsg = 'Rate-limited by the platform. Try again in a moment.';
            else if (msg.includes('login') || msg.includes('cookies')) userMsg = 'This content requires a login. Try a public video.';
            res.status(500).json({ error: userMsg, details: err.message });
        }
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
