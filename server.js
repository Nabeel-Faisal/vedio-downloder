'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');
const youtubedl = require('youtube-dl-exec');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health Check
app.get('/health', (req, res) => res.status(200).json({ ok: true, port: PORT }));

// Get system yt-dlp path if available
let systemYtDlp = 'yt-dlp';
try {
    systemYtDlp = execSync('which yt-dlp', { encoding: 'utf8' }).trim() || 'yt-dlp';
} catch (e) {
    // Falls back to search in PATH
}

// Diag Route
app.get('/api/diag', (req, res) => {
    const results = {
        path: process.env.PATH,
        node: process.version,
        platform: process.platform,
        cwd: process.cwd(),
        systemYtDlp,
        bins: {}
    };
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

// ── Routes ───────────────────────────────────────────────────────────────────

app.post('/api/info', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    try {
        console.log(`[info] Fetching: ${url}`);
        const info = await youtubedl(url, {
            dumpJson: true,
            noPlaylist: true,
            noCheckCertificates: true,
            preferFreeFormats: true,
            addHeader: ['referer:youtube.com', 'user-agent:Mozilla/5.0'],
            // Explicitly try to use system binary if found, else let library decide
        });
...

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
                id: `bestvideo[height<=${h}]+bestaudio/best`,
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
        res.status(500).json({ error: 'Failed to fetch video info. Please check the URL.' });
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

        const options = {
            output: tmpOut,
            noPlaylist: true,
            mergeOutputFormat: 'mp4'
        };

        if (formatId === 'bestaudio/best') {
            options.format = 'bestaudio/best';
            options.extractAudio = true;
            options.audioFormat = 'mp3';
        } else {
            options.format = formatId || 'bestvideo+bestaudio/best';
        }

        await youtubedl(url, options);

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

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, (err) => {
    if (err) {
        console.error('❌ Failed to start server:', err);
        process.exit(1);
    }
    console.log(`🎬 Server is LIVE on port ${PORT}`);
    console.log(`🔍 yt-dlp path: ${systemYtDlp}`);
});
