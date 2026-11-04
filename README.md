<div align="center">

# ⚡ Muse AI Gateway & Distributed Cluster API
### Enterprise-Grade RESTful API, SSE Streaming & SaaS Gateway for Meta AI / Imagine Diffusion & Video Generation
**Direct Noise Protocol (`Noise_XX_25519_AESGCM_SHA256`) & WebSocket Connection • Up to 2,000 Concurrency • Self-Healing WSS Auto-Recovery**

[![GitHub Stars](https://img.shields.io/github/stars/suncodevn/muse-api-server?style=for-the-badge&logo=github&color=FFD700)](https://github.com/suncodevn/muse-api-server/stargazers)
[![Official Website](https://img.shields.io/badge/🌐_Website-suncodevn.com-0066FF?style=for-the-badge&logo=googlechrome&logoColor=white)](https://suncodevn.com)
[![Live Platform](https://img.shields.io/badge/🚀_Live_Demo-museai.suncodevn.com-0866FF?style=for-the-badge&logo=meta&logoColor=white)](https://museai.suncodevn.com)
[![Node.js](https://img.shields.io/badge/Node.js-v20.12%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Docker Ready](https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white)](Dockerfile)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

[**🌐 Official Website**](https://suncodevn.com) • [**🚀 Live Studio Demo**](https://museai.suncodevn.com) • [**📖 Interactive API Docs (/docs)**](https://museai.suncodevn.com/docs) • [**💼 Hire Us / Commercial Support**](#-commercial-support--enterprise-services)

---

### ⭐ If this project helped you or saved you time, please give it a Star! It inspires continuous updates and community feature drops.

---

</div>

## 📌 Global SEO Keywords & Topics
`meta-ai`, `meta-ai-api`, `ai-gateway`, `imagine-api`, `video-generation`, `image-generation`, `text-to-video`, `text-to-image`, `openai-compatible`, `sse-streaming`, `multi-account-pool`, `high-concurrency`, `self-healing`, `reverse-engineered`, `websocket-proxy`, `ai-cluster`, `suncodevn`

---

## 🌟 What is Muse AI Gateway?

**Muse AI Gateway** is a production-grade, reverse-engineered API server that transforms Meta AI's proprietary end-to-end encrypted **Noise Protocol (`Noise_XX_25519_AESGCM_SHA256`)** and WebSocket architecture into a clean, developer-friendly **OpenAI-compatible REST API** and **Server-Sent Events (SSE)** gateway.

Whether you want to build autonomous AI agents, Telegram/Discord bots, automated video/image generation pipelines (n8n/Make), or high-throughput SaaS applications, **Muse AI Gateway** handles account pooling, proxy routing, token streaming, and datacenter IP bypass with extreme performance.

---

## ⚡ Why Muse AI Gateway? (Comparison)

| Feature | Standard Scraping / Basic Wrappers | ⚡ Muse AI Gateway (This Project) |
|---|---|---|
| **Concurrency Ceiling** | 1 - 2 requests (easily blocked) | **Up to 2,000 concurrent threads** per account / global cluster |
| **Connection Method** | Cookie-based HTTP scraping (Fragile) | **Direct WebSocket + Noise Protocol** straight to Meta VM |
| **Datacenter IP Ban** | ❌ 99% blocked on AWS/Hetzner/Vultr | ✅ **100% Bypassed** via direct WSS streaming |
| **WSS Auto-Recovery** | ❌ Manual re-login when token dies | ✅ **Self-Healing Watchdog** (Auto-renews via Headless Chromium) |
| **Chat API** | Custom, non-standard JSON | ✅ **100% OpenAI-Compatible** (`/v1/chat/completions` + SSE) |
| **Media Generation** | Blocking / High timeout rate | ✅ **Durable Queue Dispatcher** + Webhooks + Signed CDN links |
| **Web GUI** | None or basic playground | ✅ **Full Web Studio** with Non-blocking Live Render Queue |
| **Reliability** | Restarts lose in-flight tasks | ✅ **MongoDB-backed idempotency**, circuit breakers, graceful drain |

---

## 🚀 Key Highlights & Capabilities

### 1. 🔌 Multi-Account Pooling with Extreme Concurrency (Up to 2,000 Threads)
- **Zero Datacenter IP Blocking**: Meta strictly limits requests originating from cloud VPS/datacenter IPs. By feeding a **direct WebSocket link (`wss://...`)**, the backend connects straight to the assigned Meta VM, **100% bypassing datacenter IP restrictions**.
- **Dynamic Load Balancing**: Connect multiple Meta accounts. The built-in client pool dynamically balances loads using least-loaded round-robin selection with configurable concurrency slots.
- **Configurable Concurrency**: Concurrency limits can scale up to **2,000 parallel threads** per account for large-scale enterprise clusters.

### 2. 🛡️ Self-Healing WSS Auto-Recovery Watchdog
- **Active Health Monitoring**: Runs a background diagnostic loop every 45 seconds to inspect all connected account sockets.
- **Automated Headless Browser Renewal**: If an account's WSS token expires or is dropped by Meta, the gateway automatically launches a lightweight headless Chromium process (auto-detected on Linux & Windows) to re-authenticate and derive a fresh WebSocket connection without human intervention.
- **One-Click Bulk Recovery**: REST endpoint `POST /api/accounts/recover-all` to heal all degraded accounts simultaneously.

### 3. 🎨 3-in-1 Generative AI Engine
- 💬 **OpenAI-Compatible Chat (`/v1/chat/completions`)**: Low-latency token-by-token SSE streaming, multi-turn conversations pinned to accounts, and reference media attachments.
- 🖼️ **Photorealistic Image Generation (`/v1/images/generations`)**: High-res Imagine Diffusion (Aspect ratios: `1:1`, `16:9`, `9:16`, `4:3`, `3:2`) with Image-to-Image reference support.
- 🎬 **Motion Video Synthesis (`/v1/videos/generations`)**: Motion-coherent MP4 video creation (5s standard, 10s extended, 16:9 widescreen, 9:16 vertical reels) with Image-to-Video and synchronous/asynchronous polling.

### 4. 🖥️ AI Studio & Non-Blocking Render Queue
- **Non-Blocking Submission**: Click **"Render Video"** or **"Generate Image"** and continue submitting prompts without waiting 60–90 seconds for each job to complete.
- **Live Active Render Queue**: Real-time table tracking all queued/rendering/completed jobs with live progress percentage bars.
- **Interactive Output Stage**: Click **"View on Stage"** on any job in the queue to preview live progress or immediately play the finished MP4 video.
- **Direct Download & Signed Links**: HMAC-SHA256 signed expiring URLs with HTTP Range support for seamless video seeking.

### 5. 🏢 Enterprise Queue Dispatcher & Webhooks
- **Durable MongoDB Queue**: Survives server restarts; jobs are claimed atomically (`findOneAndUpdate`) across multi-node clusters.
- **Signed Webhooks**: HMAC-SHA256 signed delivery with exponential backoff retries and SSRF protection.
- **Stripe-Style Error Envelopes**: Standardized JSON responses, cursor pagination, and idempotency key support.

---

## 🏛️ System Architecture

```
                                    ┌──────────────────────────── API Node ─────────────────────────────┐
  Clients / Apps / SaaS / Bots ───► │ Express  ─► Auth / Rate Limit / Validation ─► Route Handlers       │
                                    │                                    │                 │             │
                                    │                          Chat (direct)        Image/Video Jobs     │
                                    │                                    │                 │             │
                                    │                                    ▼                 ▼             │
                                    │                         ┌────────────────┐   ┌───────────────┐     │
                                    │                         │  Account Pool  │◄──│  Dispatcher   │     │
                                    │                         │ (2000 Concurr, │   │ (Claim Queue, │     │
                                    │                         │  WSS Watchdog) │   │  Retry/Heart) │     │
                                    │                         └───────┬────────┘   └───────▲───────┘     │
                                    └─────────────────────────────────┼────────────────────┼─────────────┘
                                                                      │ WebSocket          │
                                                                      ▼                    │
                                                              Upstream Meta AI        MongoDB (Jobs,
                                                               (Noise Protocol)      Accounts, Keys)
```

---

## ⚡ Quick Start (1 Minute Setup)

### Prerequisites
- Node.js **20.12+** (v22 LTS recommended)
- MongoDB **6.0+**
- (Optional) Docker & Docker Compose

---

### Method A: Docker Compose (Fastest)

```bash
# 1. Clone repository
git clone https://github.com/suncodevn/muse-api-server.git
cd muse-api-server

# 2. Setup environment variables
cp .env.example .env

# Set secure secrets:
# node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

# 3. Start full stack (API + MongoDB)
docker compose up -d --build

# 4. View logs
docker compose logs -f api
```

Access the Interactive Documentation & Admin Studio:
- **API Swagger Docs**: `http://localhost:8080/docs`
- **Admin Studio & Playground**: `http://localhost:8080/admin`

---

### Method B: Local Node.js Setup

```bash
# 1. Install dependencies
npm ci

# 2. Setup environment
cp .env.example .env
# Edit .env and configure MONGODB_URI, ADMIN_API_KEY, SIGNING_SECRET

# 3. Start development server
npm run dev

# Or start production server
npm start
```

---

## 📚 API Usage Examples

### 1. OpenAI-Compatible Chat Completion (cURL)

```bash
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer mk_live_YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "muse-1",
    "messages": [
      {"role": "system", "content": "You are a helpful AI assistant."},
      {"role": "user", "content": "Explain quantum computing in 2 sentences."}
    ],
    "stream": false
  }'
```

#### Using Official OpenAI Python SDK:

```python
from openai import OpenAI

client = OpenAI(
    api_key="mk_live_YOUR_API_KEY",
    base_url="http://localhost:8080/v1"
)

response = client.chat.completions.create(
    model="muse-1",
    messages=[
        {"role": "user", "content": "Hello, write a haiku about the ocean."}
    ],
    stream=True
)

for chunk in response:
    content = chunk.choices[0].delta.content or ""
    print(content, end="", flush=True)
```

---

### 2. Generate Photorealistic Image

```bash
curl -X POST http://localhost:8080/v1/images/generations \
  -H "Authorization: Bearer mk_live_YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Cyberpunk street market in Tokyo with neon rain reflections, ultra-realistic 8k",
    "aspect_ratio": "16:9",
    "response_format": "url"
  }'
```

---

### 3. Generate Motion Video (MP4)

```bash
curl -X POST http://localhost:8080/v1/videos/generations \
  -H "Authorization: Bearer mk_live_YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "A glowing jellyfish floating through a cosmic nebula with shimmering starlight, 4k cinematic slow motion",
    "aspect_ratio": "16:9",
    "duration": 5
  }'
```

Returns immediately with a durable Job ID:
```json
{
  "id": "job_9b3e1f0a2c",
  "object": "job",
  "status": "queued",
  "type": "video",
  "created_at": "2026-10-29T10:00:00.000Z"
}
```

Poll job progress or use Webhooks:
```bash
curl http://localhost:8080/v1/jobs/job_9b3e1f0a2c \
  -H "Authorization: Bearer mk_live_YOUR_API_KEY"
```

For image-to-video, pass public image URLs directly:

```json
{
  "model": "muse-video-v1",
  "mode": "image_to_video",
  "prompt": "Same woman as in the reference, wearing a navy sailor dress. Vertical realistic UGC fashion ad, seven shots with hard cuts. No talking, no on-screen text.",
  "first_frame_image": "https://cdn.example.com/original-face.jpg",
  "reference_images": [
    {
      "type": "face",
      "image": "https://cdn.example.com/original-face.jpg",
      "weight": 1.0,
      "lock": true
    }
  ],
  "aspect_ratio": "9:16",
  "duration": 8,
  "style": "realistic",
  "negative_prompt": "different face, distorted face, cartoon, text, watermark"
}
```

`mode` accepts `text_to_video`, `image_to_video`, or `video_to_video`; when omitted,
it is inferred from the references. Image-to-video requires an image, and
video-to-video requires `reference_video`. Images and video references cannot be
combined; text-to-video accepts no reference media. Images may also use uploaded
file IDs or data URIs, as with the existing `reference_image` and `refs` fields.
Remote URLs must be enabled on the server and reachable without authentication.

At most 10 image entries are accepted across `first_frame_image`, `reference_images`,
`reference_image`, and `refs`. The attachment order follows that same field order.
Identical images are sent upstream once while retaining their first-frame/face
instructions. `type` accepts `image` (default) or `face`; `weight` is between 0 and 1.

The current upstream uses a chat-based generation interface. First-frame, face lock,
weight, style, and negative prompt are translated into prompt instructions; they
are best-effort requests rather than native face-lock or numeric conditioning
controls. `model` is retained as a client label and does not select an upstream model.

---

## 🛠️ Configuration Guide

Key environment variables in `.env`:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP listener port. |
| `MONGODB_URI` | `mongodb://localhost:27017/muse_ai` | MongoDB connection URI. |
| `ADMIN_API_KEY` | *(Required)* | Master admin secret key (≥ 32 chars). |
| `SIGNING_SECRET` | *(Required)* | Secret key for signed media URLs (≥ 32 chars). |
| `PUBLIC_BASE_URL` | `http://localhost:8080` | Public CDN URL prefix for signed media. |
| `DEFAULT_MAX_CONCURRENT_JOBS` | `20` | Max queued/running jobs per API key. |
| `ACCOUNT_MAX_CONCURRENCY` | `2000` | Maximum concurrency ceiling per account. |
| `QUEUE_MAX_PENDING` | `2000` | Global queue limit before backpressure. |
| `CHROMIUM_PATH` | *auto-detected* | Custom executable path for Chromium/Chrome. |

---

## 💼 Commercial Support & Enterprise Services

Need custom development, automated account farming, or enterprise-scale deployment? **SunCodeVN** provides full-lifecycle engineering services for AI startups and enterprises:

- 🚀 **Turnkey Private API Gateway Deployment**: Complete setup on AWS, Hetzner, Vultr, OVH, or bare-metal servers.
- 🔄 **Meta Account Pool & Proxy Farm Setup**: 100% Ban-resistant Datacenter IP bypass with automatic rotating residential/mobile proxies.
- ⚡ **High-Throughput Concurrency Scaling**: Architectural optimization for 1,000 – 10,000+ Requests Per Minute.
- 🤖 **Custom AI SaaS & Automation Integration**: Custom Telegram bots, Discord bots, n8n/Make workflows, and white-label AI platforms.
- 🛡️ **Custom Protocols & Anti-Detection Engineering**: Reverse-engineering proprietary AI platforms and building secure API bridges.

### 📞 Contact & Inquiries
- 🌐 **Official Website**: [https://suncodevn.com](https://suncodevn.com)
- 🚀 **Live Demo Platform**: [https://museai.suncodevn.com](https://museai.suncodevn.com)
- 📧 **Business Email**: [contact@suncodevn.com](mailto:contact@suncodevn.com) / [suncodevn@gmail.com](mailto:suncodevn@gmail.com)
- 💬 **Telegram**: [@suncodevn](https://t.me/suncodevn)
- 🐙 **GitHub Profile**: [@suncodevn](https://github.com/suncodevn)

---

## 🤝 Contributing

Contributions, feature requests, and bug reports are welcome!
1. Fork this repository.
2. Create your feature branch (`git checkout -b feature/AmazingFeature`).
3. Commit your changes (`git commit -m 'feat: Add AmazingFeature'`).
4. Push to the branch (`git push origin feature/AmazingFeature`).
5. Open a Pull Request.

---

## 📜 License

Distributed under the **MIT License**. See [`LICENSE`](LICENSE) for more details.

---

<div align="center">
  <sub>Built with ❤️ by <a href="https://suncodevn.com"><strong>SunCodeVN.Com</strong></a> • Powering Next-Gen AI Gateways.</sub>
</div>
