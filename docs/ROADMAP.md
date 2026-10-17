# Project Roadmap — Perfect Download Manager

This document outlines PDM's development trajectory: where we are, where we're going, and how AI integration will transform the project into something genuinely unique in the download manager space.

---

## Vision

> **Make efficient, intelligent downloading accessible to everyone — for free.**

PDM started as a high-performance alternative to IDM. It's evolving into an AI-augmented download manager where Claude understands *what* you're downloading, *why* it might be risky, and *how* to best organize it — all without the user lifting a finger.

Every AI feature ships free in the Community Edition.

---

## Current Status (October 2026)

| Component | Status | Notes |
|-----------|--------|-------|
| Download engine (Core) | ✅ Complete | 81 tests, NativeAOT |
| WPF desktop UI | ✅ Complete | Fluent/Mica, MVVM |
| Browser extension | ✅ Complete | Chrome/Edge/Brave |
| Auto-update service | ✅ Complete | ECDSA signed manifests |
| Licensing infrastructure | ✅ Complete | DPAPI, hardware binding |
| Admin portal | ✅ Complete | Next.js, DynamoDB |
| NativeAOT distribution | ✅ Complete | Runtime-free install |
| Community Edition | ✅ Live | Free, MIT license |
| Premium Support Plans | ✅ Live | Supporter + Enterprise |
| **AI features** | 🔄 In design | Claude API integration |
| MSI/MSIX installer | 📋 Planned | Stage 8 |
| Code signing certificate | 📋 Planned | Stage 8 |

---

## Phase 1: AI Foundation (Q1 2027)

**Goal:** Ship the first two AI features powered by Claude API to all Community Edition users.

### Milestone 1.1 — PDM.AI Module
- [ ] Define `ICategoryClassifier`, `IUrlSafetyAnalyzer` interfaces
- [ ] Implement `ClaudeApiClient` (shared HTTP client, retry, rate limit handling)
- [ ] Implement rule-based fallbacks (work without API)
- [ ] Settings UI: AI toggle, API key input (optional, for bring-your-own)
- [ ] Tests: mock Claude responses, verify fallback behavior

### Milestone 1.2 — Smart Categorization
- [ ] `ClaudeCategoryClassifier` — analyze URL + filename + headers
- [ ] Integrate into `AddDownloadViewModel` (non-blocking, async)
- [ ] Show suggested category in Add Download dialog
- [ ] User can accept, modify, or disable per-download
- [ ] Telemetry: track acceptance rate to improve prompts (opt-in)

### Milestone 1.3 — URL Safety Analysis
- [ ] `ClaudeUrlSafetyAnalyzer` — flag suspicious URLs with explanation
- [ ] Show warning badge in download queue for flagged items
- [ ] Configurable: off / warn / block
- [ ] Explain *why* flagged (not just red/green)

**Metrics target:** 1,000 active Community Edition users by end of Q1 2027

---

## Phase 2: Natural Language & Intelligence (Q2–Q3 2027)

**Goal:** Make PDM feel like a smart assistant, not just a queue manager.

### Milestone 2.1 — Natural Language Download Interface
- [ ] "Quick Add" dialog with NL input mode
- [ ] `ClaudeNLResolver` — resolve plain English to download URLs
- [ ] Verification step: show resolved URL before starting
- [ ] Fallback: open browser search if Claude can't resolve confidently

### Milestone 2.2 — Intelligent Scheduling
- [ ] Local pattern analysis (on-device, no data sent)
- [ ] Claude-powered recommendations: "Best quiet hours: 2–6 AM based on your usage"
- [ ] Bandwidth prediction: suggest connection count per server based on history

### Milestone 2.3 — Download History Semantic Search
- [ ] Index download history locally (filename, URL, category, date)
- [ ] Natural language query: "find the PDF I downloaded about React hooks"
- [ ] Claude interprets fuzzy queries, returns ranked results

**Metrics target:** 10,000 active users, 500 GitHub stars by end of Q3 2027

---

## Phase 3: Content Intelligence (Q4 2027)

**Goal:** Make downloaded content immediately useful.

### Milestone 3.1 — Document Summaries (Opt-in)
- [ ] One-paragraph AI summary for downloaded PDFs/DOCX (user consent per file)
- [ ] Show summary in download history detail panel
- [ ] Privacy: content sent to API only on explicit per-file opt-in

### Milestone 3.2 — Duplicate & Version Detection
- [ ] Detect when user is downloading a newer version of an existing file
- [ ] "You already have Python 3.11. This is 3.12 — replace or keep both?"
- [ ] Claude understands version semantics (3.12 > 3.11 for Python, etc.)

### Milestone 3.3 — Batch Operations
- [ ] Process a list of URLs in bulk with AI categorization
- [ ] Smart queue prioritization: prioritize downloads based on file type and user history

**Metrics target:** 50,000 active users, 2,000 GitHub stars by end of Q4 2027

---

## Stage 8: Packaging & Distribution (Parallel Track)

These are independent of AI work and can progress in parallel:

- [ ] MSI/MSIX installer with WiX Toolset
- [ ] Code signing certificate (Authenticode)
- [ ] AUMID registration for native Windows 11 toast notifications
- [ ] Update launcher helper binary
- [ ] Microsoft Store submission (optional)
- [ ] Windows Package Manager (winget) manifest

---

## Community Goals

| Metric | Q1 2027 | Q3 2027 | Q4 2027 |
|--------|---------|---------|---------|
| Active users | 1,000 | 10,000 | 50,000 |
| GitHub stars | 100 | 500 | 2,000 |
| Contributors | 5 | 20 | 50 |
| Premium supporters | 10 | 100 | 500 |
| Community forum posts | 50 | 500 | 2,000 |

---

## How You Can Help

The roadmap moves faster with community involvement:

- **Code contributors:** See [CONTRIBUTING.md](../CONTRIBUTING.md) and issues tagged `help-wanted`
- **AI feature design:** Join the "AI integration" discussion on GitHub Discussions
- **Beta testing:** Subscribe to the Beta update channel for early access
- **Premium support:** [Supporter and Enterprise plans](https://perfectdownloadmanager.com/pricing) directly fund AI API costs and development time
- **Feedback:** Open feature requests on GitHub — the most-voted ones get prioritized

---

## What Anthropic Credits Enable

PDM has applied to Anthropic's **Claude for Startups** program. If supported:

- All Phase 1 and Phase 2 AI features ship **free to all Community Edition users** (no API key setup)
- No cost barrier means global accessibility — users in developing regions get the same AI features as enterprise users
- Allows us to validate AI feature design with real users before asking anyone to pay for API credits
- Enables a sustainable model: open source core + AI-powered features + premium support

We believe an AI-augmented download manager is genuinely useful — and that it should be free. Anthropic credits make that possible at launch scale.

---

*Roadmap is updated quarterly. Last updated: October 2026.*
*To influence priorities, vote on [GitHub Issues](https://github.com/vpbgkt/Perfect-Download-Manager/issues) or join [Discussions](https://github.com/vpbgkt/Perfect-Download-Manager/discussions).*
