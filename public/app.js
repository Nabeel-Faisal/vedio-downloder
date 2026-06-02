/* ── State ───────────────────────────────────────────────────────────────── */
const API = '';          // same origin
let currentFormats = [];

/* ── DOM ─────────────────────────────────────────────────────────────────── */
const urlInput = document.getElementById('urlInput');
const fetchBtn = document.getElementById('fetchBtn');
const fetchBtnText = document.getElementById('fetchBtnText');
const fetchSpinner = document.getElementById('fetchSpinner');
const errorMsg = document.getElementById('errorMsg');
const videoCard = document.getElementById('videoCard');
const thumbnail = document.getElementById('thumbnail');
const duration = document.getElementById('duration');
const platform = document.getElementById('platform');
const videoTitle = document.getElementById('videoTitle');
const uploader = document.getElementById('uploader');
const viewCount = document.getElementById('viewCount');
const likeCount = document.getElementById('likeCount');
const formatSelect = document.getElementById('formatSelect');
const downloadBtn = document.getElementById('downloadBtn');
const downloadBtnText = document.getElementById('downloadBtnText');
const downloadSpinner = document.getElementById('downloadSpinner');
const downloadNote = document.getElementById('downloadNote');

/* ── Helpers ─────────────────────────────────────────────────────────────── */
function formatDuration(secs) {
    if (!secs) return '';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    return h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `${m}:${String(s).padStart(2, '0')}`;
}

function formatCount(n) {
    if (!n) return '';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(n);
}

function formatFilesize(bytes) {
    if (!bytes) return '';
    if (bytes >= 1_073_741_824) return (bytes / 1_073_741_824).toFixed(1) + ' GB';
    if (bytes >= 1_048_576) return (bytes / 1_048_576).toFixed(1) + ' MB';
    return Math.round(bytes / 1024) + ' KB';
}

function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.classList.remove('hidden');
}

function hideError() {
    errorMsg.classList.add('hidden');
}


/* ── Fetch Video Info ────────────────────────────────────────────────────── */
async function fetchInfo() {
    const url = urlInput.value.trim();
    if (!url) { showError('Please paste a video URL first.'); return; }

    hideError();
    videoCard.classList.add('hidden');
    fetchBtn.disabled = true;
    fetchBtnText.textContent = 'Fetching…';
    fetchSpinner.classList.remove('hidden');

    try {
        const resp = await fetch(`${API}/api/info`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url }),
        });

        const data = await resp.json();
        if (!resp.ok) {
            const detail = data.details ? `\n\nDetails: ${data.details.slice(0, 300)}` : '';
            const err = new Error((data.error || 'Failed to fetch video info') + detail);
            err.needsCookies = !!data.needsCookies;
            throw err;
        }

        // Populate card
        thumbnail.src = data.thumbnail || '';
        thumbnail.alt = data.title;
        duration.textContent = formatDuration(data.duration);
        platform.textContent = data.platform || 'Video';
        videoTitle.textContent = data.title || 'Untitled';
        uploader.textContent = data.uploader ? `by ${data.uploader}` : '';
        viewCount.textContent = data.viewCount ? `👁 ${formatCount(data.viewCount)} views` : '';
        likeCount.textContent = data.likeCount ? `👍 ${formatCount(data.likeCount)} likes` : '';

        // Populate format select
        currentFormats = data.formats || [];
        formatSelect.innerHTML = '';
        currentFormats.forEach((f, i) => {
            const option = document.createElement('option');
            option.value = i;
            const sizeStr = f.filesize ? ` · ${formatFilesize(f.filesize)}` : '';
            option.textContent = `${f.label} · ${(f.ext || 'mp4').toUpperCase()}${sizeStr}`;
            formatSelect.appendChild(option);
        });

        videoCard.classList.remove('hidden');
        videoCard.scrollIntoView({ behavior: 'smooth', block: 'start' });

    } catch (err) {
        showError(`❌ ${err.message}`);
    } finally {
        fetchBtn.disabled = false;
        fetchBtnText.textContent = 'Fetch Video';
        fetchSpinner.classList.add('hidden');
    }
}

/* ── Download ────────────────────────────────────────────────────────────── */
async function startDownload() {
    const url = urlInput.value.trim();
    if (!url) return;

    const idx = parseInt(formatSelect.value, 10);
    const fmt = currentFormats[idx] || {};

    downloadBtn.disabled = true;
    downloadBtnText.textContent = 'Downloading…';
    downloadSpinner.classList.remove('hidden');
    downloadNote.classList.remove('hidden');

    try {
        const resp = await fetch(`${API}/api/download`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url,
                formatId: fmt.id,
                title: videoTitle.textContent,
                ext: fmt.ext === 'mp3' ? 'mp3' : 'mp4',
            }),
        });

        if (!resp.ok) {
            const errData = await resp.json().catch(() => ({}));
            throw new Error(errData.error || 'Download failed');
        }

        const blob = await resp.blob();
        const disposition = resp.headers.get('Content-Disposition') || '';
        let filename = 'video.mp4';
        const match = disposition.match(/filename="?([^"]+)"?/);
        if (match) filename = match[1];

        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);

    } catch (err) {
        showError(`❌ ${err.message}`);
    } finally {
        downloadBtn.disabled = false;
        downloadBtnText.textContent = 'Download';
        downloadSpinner.classList.add('hidden');
        downloadNote.classList.add('hidden');
    }
}

/* ── Event Listeners ────────────────────────────────────────────────────── */
fetchBtn.addEventListener('click', fetchInfo);
urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') fetchInfo(); });
downloadBtn.addEventListener('click', startDownload);

// Auto-paste & fetch
urlInput.addEventListener('paste', () => {
    setTimeout(() => {
        const val = urlInput.value.trim();
        if (val.startsWith('http')) fetchInfo();
    }, 50);
});

/* ── fix button text after redesign ─────────────────────────────────────── */
// fetchBtnText default is "Fetch Video" — restore it (not "Fetch") after calls
const FETCH_IDLE = 'Fetch Video';
fetchBtn.addEventListener('click', fetchInfo);

/* ── Particles ───────────────────────────────────────────────────────────── */
(function spawnParticles() {
    const container = document.getElementById('particles');
    if (!container) return;
    for (let i = 0; i < 35; i++) {
        const p = document.createElement('div');
        p.className = 'particle';
        const size = 2 + Math.random() * 3;
        p.style.cssText = `
            left:${Math.random() * 100}%;
            top:${80 + Math.random() * 20}%;
            width:${size}px; height:${size}px;
            animation-delay:${Math.random() * 12}s;
            animation-duration:${10 + Math.random() * 8}s;
            opacity:${0.15 + Math.random() * 0.35};
            background:${Math.random() > 0.5 ? 'rgba(124,58,237,0.7)' : 'rgba(6,182,212,0.7)'};
        `;
        container.appendChild(p);
    }
})();

/* ── 3D Tilt on feature cards ────────────────────────────────────────────── */
document.querySelectorAll('.tilt-card').forEach(card => {
    card.addEventListener('mousemove', e => {
        const r = card.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width  - 0.5;
        const y = (e.clientY - r.top)  / r.height - 0.5;
        card.style.transform = `perspective(700px) rotateY(${x * 14}deg) rotateX(${-y * 14}deg) translateZ(12px) scale(1.02)`;
    });
    card.addEventListener('mouseleave', () => { card.style.transform = ''; });
});

/* ── Scroll reveal ───────────────────────────────────────────────────────── */
const revealObs = new IntersectionObserver(entries => {
    entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('visible'); revealObs.unobserve(e.target); } });
}, { threshold: 0.12 });
document.querySelectorAll('.reveal-section').forEach(el => revealObs.observe(el));

/* ── Animated counter ────────────────────────────────────────────────────── */
const counterObs = new IntersectionObserver(entries => {
    entries.forEach(e => {
        if (!e.isIntersecting) return;
        const el = e.target;
        const target = +el.dataset.count;
        let start = 0;
        const step = () => {
            start += Math.ceil(target / 60);
            if (start >= target) { el.textContent = target; return; }
            el.textContent = start;
            requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
        counterObs.unobserve(el);
    });
}, { threshold: 0.5 });
document.querySelectorAll('[data-count]').forEach(el => counterObs.observe(el));
