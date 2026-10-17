# AI Roadmap — Perfect Download Manager

This document describes how AI (specifically Anthropic's Claude API) will be integrated into PDM to deliver intelligent features to all Community Edition users at no cost.

---

## Why AI in a Download Manager?

PDM handles thousands of files across diverse sources — executables, documents, media, datasets, archives. Today, users manually organize, verify, and decide what to do with downloads. AI can automate and enhance every one of these decisions, making PDM genuinely smarter than any existing download manager.

The goal: **every AI feature ships free in the Community Edition**, powered by Claude API credits. Premium support plans sustain development; AI credits enable the intelligence layer.

---

## Planned AI Features

### 1. 🧠 Smart Categorization (Phase 1)

**What it does:** Automatically assigns categories to downloads by analyzing the URL structure, filename, MIME type, referrer domain, and content headers — without downloading the full file.

**How Claude helps:**
- Understands context that regex patterns miss (e.g., `dl.php?id=12345` → "Software Installer" from the referrer context)
- Handles ambiguous filenames gracefully
- Learns from user corrections over time

**Example:**
```
URL: https://releases.ubuntu.com/24.04/ubuntu-24.04-desktop-amd64.iso
→ Category: "OS Images / Linux"
→ Suggested folder: ~/Downloads/PDM/OS-Images/
→ Suggested post-download action: "Verify SHA-256"
```

**Status:** Architecture designed. Implementation pending Claude API integration.

---

### 2. 🛡️ URL Safety Analysis (Phase 1)

**What it does:** Before starting a download, Claude analyzes the URL, domain reputation signals, and filename patterns to flag potentially unsafe downloads.

**How Claude helps:**
- Identifies suspicious patterns (e.g., typosquatting domains, executable-disguised-as-media)
- Explains *why* a URL looks risky, not just a red/green flag
- Provides a confidence score so users can make informed decisions

**Example warning:**
```
⚠️  Risk: Medium
Domain 'micros0ft-downloads.net' mimics a legitimate vendor.
Executable '.exe' served with misleading filename 'codec_update.mp4.exe'.
Recommendation: Verify this URL before proceeding.
```

**Status:** Planned for Phase 1. Will use Claude's reasoning on metadata only — no file content is sent to the API.

---

### 3. 💬 Natural Language Download Interface (Phase 2)

**What it does:** Users type what they want in plain English; Claude figures out the URL and starts the download.

**How Claude helps:**
- Resolves natural language to canonical download URLs
- Handles version disambiguation ("latest stable", "LTS", "for Windows 11")
- Integrates with the existing download engine seamlessly

**Examples:**
```
"Download the latest Python 3 installer for Windows"
→ Resolves to: https://www.python.org/ftp/python/3.x.x/python-3.x.x-amd64.exe

"Get the Node.js LTS release"
→ Resolves to: https://nodejs.org/dist/vX.X.X/node-vX.X.X-x64.msi

"Download VS Code"
→ Resolves to: https://code.visualstudio.com/sha/download?build=stable&os=win32-x64
```

**Status:** Planned for Phase 2. Requires careful prompt design to avoid hallucinated URLs — Claude will provide a URL it's confident about plus a verification step.

---

### 4. 📊 Intelligent Scheduling (Phase 2)

**What it does:** Claude analyzes historical download patterns (stored locally) to recommend optimal scheduling — when to run large downloads, how to balance bandwidth across concurrent jobs.

**How Claude helps:**
- Interprets local usage patterns in natural language summaries
- Suggests quiet-hours windows based on observed low-activity periods
- Recommends connection count based on server behavior history

**Privacy note:** All pattern data stays on-device. Only anonymized aggregate statistics (no URLs or filenames) are sent to the AI if the user opts in.

**Status:** Planned for Phase 2.

---

### 5. 📝 Downloaded Document Summaries (Phase 3)

**What it does:** For downloaded PDF, DOCX, or text files, PDM can optionally generate a one-paragraph summary using Claude, shown in the download history panel.

**How Claude helps:**
- Gives users a quick sense of what they downloaded without opening the file
- Particularly useful for research workflows with many papers or reports

**Privacy note:** Opt-in only. File content is sent to Claude API only with explicit user consent per file. No content is retained after processing.

**Status:** Planned for Phase 3.

---

### 6. 🔍 Download History Search (Phase 3)

**What it does:** Natural language search over download history — "find that Python tutorial I downloaded last month" instead of scrolling through a list.

**How Claude helps:**
- Semantic search across filenames, URLs, categories, and dates
- Understands fuzzy queries ("that big ISO file from last week")

**Status:** Planned for Phase 3.

---

## Architecture

```
PDM.App (UI)
    │
    ├── PDM.AI (new module — planned)
    │       ├── ICategoryClassifier   → Claude API (smart categorization)
    │       ├── IUrlSafetyAnalyzer    → Claude API (safety analysis)
    │       ├── INaturalLanguageResolver → Claude API (NL interface)
    │       └── IDocumentSummarizer   → Claude API (summaries, opt-in)
    │
    └── PDM.Core (engine — unchanged)
```

The `PDM.AI` module will be designed so that:
- All AI features **degrade gracefully** if the API is unreachable (the download still works)
- API keys are configured once in Settings, not hard-coded
- All AI calls are **async and non-blocking** — they never delay a download starting
- Community Edition users share a managed API key funded by Anthropic credits
- Premium supporters can optionally bring their own API key for higher rate limits

---

## Privacy Commitments

| Data Type | Sent to Claude API? |
|-----------|-------------------|
| Download URL + filename | ✅ Yes — for categorization and safety (Phase 1) |
| File content | ❌ Never, unless user explicitly opts in per file (Phase 3) |
| Browsing history | ❌ Never |
| Personal information | ❌ Never |
| Usage patterns | ❌ Never (stays local) |

All AI features will be clearly labeled in the UI, toggleable in Settings, and fully documented.

---

## How Anthropic Credits Enable Free AI for Everyone

Running Claude API calls at scale has a cost. With support from Anthropic's **Claude for Startups** program:

- All Community Edition users get AI features **at zero cost**
- No API key setup required for basic features
- Usage is pooled and managed transparently
- If credits run low, AI features gracefully fall back to rule-based behavior

This is the same model used by open source projects like Cursor, Zed, and others that use AI credits to democratize access to intelligent tooling.

---

## Contributing to AI Features

Interested in helping build the AI layer? See:
- [CONTRIBUTING.md](../CONTRIBUTING.md) for general contribution guidelines
- Open issues tagged `ai-feature` on GitHub
- Discussion thread: "AI integration architecture" in GitHub Discussions

The `PDM.AI` module will be kept deliberately simple and testable — no framework lock-in, clean interfaces, easy to mock in tests.

---

*Last updated: October 2026*
