# Multi-Platform Video Downloader

A robust, multi-platform video and audio downloader built with Node.js, Express, and `yt-dlp`. It provides a clean API and an intuitive web interface for fetching video formats and downloading media from platforms like YouTube, Instagram, TikTok, and more.

## Features

- **Multi-Platform Support**: Downloads videos from YouTube, Instagram, TikTok, Twitter, and hundreds of other websites supported by `yt-dlp`.
- **Format Selection**: Automatically fetches the best quality (video + audio) by default, and allows users to choose specific resolutions or extract Audio-only (MP3).
- **Advanced Platform Bypasses**: Uses modern User-Agents and referers (e.g., tailored for Instagram) to prevent blocking.
- **Docker & Railway Ready**: Comes with a pre-configured `Dockerfile` that installs all required system dependencies (Python, FFmpeg, `yt-dlp`).
- **Authentication Support**: Supports bypassing account-restricted videos via `cookies.txt` or the `COOKIES_CONTENT` environment variable.
- **Diagnostic API**: Built-in health and diagnostic endpoints to verify system dependencies on the fly.

## Prerequisites

If you are running the project natively (without Docker), you must have the following installed on your system:
- **Node.js** (v18 or higher recommended)
- **Python 3**
- **FFmpeg** (required for merging video and audio tracks)
- **yt-dlp** (or it will automatically attempt to use the node-wrapper version)

## Installation & Setup

### Running Natively

1. **Clone the repository** (or navigate to the project directory):
   ```bash
   cd "vedio downloder"
   ```

2. **Install Node dependencies**:
   ```bash
   npm install
   ```

3. **Start the development server**:
   ```bash
   npm run dev
   ```
   Or start in production mode:
   ```bash
   npm start
   ```

4. **Open the App**:
   Navigate to `http://localhost:3000` in your browser.

### Running with Docker

This project includes a Dockerfile that sets up a Node.js 20 environment with all required system binaries (`python3`, `ffmpeg`, `yt-dlp`).

1. **Build the Docker Image**:
   ```bash
   docker build -t video-downloader .
   ```

2. **Run the Docker Container**:
   ```bash
   docker run -p 3000:3000 video-downloader
   ```

### Using Cookies (For Age-Restricted / Private Content)
To download videos that require a login:
- **Locally**: Place a valid Netscape-format `cookies.txt` file in the root directory.
- **Docker / Production**: Set the `COOKIES_CONTENT` environment variable containing the raw contents of your cookies.txt file. The container will automatically generate the file on startup.

## API Documentation

The server exposes the following REST API endpoints:

### `GET /health`
Returns the status of the server.
**Response**: `{"ok": true, "port": 3000}`

### `GET /api/diag`
Returns system diagnostics, ensuring all required binaries (node, yt-dlp, ffmpeg, python) are properly installed and accessible in the `PATH`.

### `POST /api/info`
Fetches available formats, video title, thumbnail, duration, and other metadata for a given URL.
- **Body**: `{ "url": "https://www.youtube.com/watch?v=..." }`

### `POST /api/download`
Initiates the download of a specific video format. The server streams the merged file (`.mp4` or `.mp3`) directly to the client.
- **Body**: 
  ```json
  {
    "url": "https://www.youtube.com/watch?v=...",
    "formatId": "bestvideo+bestaudio/best",
    "title": "Video Title",
    "ext": "mp4"
  }
  ```

## Tech Stack

- **Backend**: Node.js, Express.js
- **Downloader Core**: [yt-dlp](https://github.com/yt-dlp/yt-dlp), [youtube-dl-exec](https://github.com/microlinkhq/youtube-dl-exec)
- **Frontend**: HTML/JS/CSS (served from the `/public` directory)

## License
MIT
