# Perfect Download Manager (PDM)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![.NET](https://img.shields.io/badge/.NET-10-purple.svg)](https://dotnet.microsoft.com/)
[![Tests](https://img.shields.io/badge/tests-81%20passing-brightgreen.svg)](tests)

A high-performance, open source download manager for Windows 10/11 — a modern alternative to Internet Download Manager. Built with .NET 10 and designed for speed, reliability, and extensibility.

🌟 **[PerfectDownloadManager.com](https://PerfectDownloadManager.com)** | 📚 **[Documentation](docs/)** | 💬 **[Community](https://github.com/yourusername/PDM/discussions)** | 🐛 **[Issues](https://github.com/yourusername/PDM/issues)**

---

## 🌍 Our Mission

**Making efficient, reliable downloading accessible to everyone — for free.**

PDM serves users worldwide, especially those in:
- 🌐 Bandwidth-constrained regions where every byte counts
- 📚 Educational institutions and research communities managing large datasets
- 💰 Users with metered connections who need intelligent download management
- 🚀 Developers and power users who demand speed and reliability

**Goal:** Serve 100,000+ users globally by end of 2027, with AI-powered features free for all Community Edition users.

## 🎯 Community Edition vs Premium Support

### 🆓 Community Edition (Free & Open Source)
Perfect Download Manager Community Edition is **100% free and open source** under the MIT License. It includes:
- ✅ All core download features (multi-connection, resume, queue management)
- ✅ Modern WPF UI with Fluent Design and Mica effects
- ✅ Browser integration (Chrome, Edge, Brave)
- ✅ Automatic updates
- ✅ Categories, scheduling, and notifications
- ✅ Community support via GitHub Discussions

### 💎 Premium Support Plans
Help sustain development and get priority assistance:

#### **Professional Plan** - $29/year
- ✅ All Community Edition features
- 🎫 Priority email support (24-hour response time)
- 📧 Direct access to the core development team
- 🎁 Early access to new features
- ⭐ Support open source development

#### **Enterprise Plan** - $199/year
- ✅ Everything in Professional
- 📞 Priority support (4-hour response time)
- 🔧 Custom integration assistance
- 📊 Dedicated Slack/Discord channel
- 🛡️ Extended security updates
- 📝 Service Level Agreement (SLA)

**[Get Premium Support →](https://perfectdownloadmanager.com/pricing)**

> **Note:** All features are available in the free Community Edition. Premium plans only unlock priority support and direct assistance from maintainers.

## Tech stack

- **.NET 10 / C#** — native performance, first-class Windows integration.
- **PDM.Core** — download engine (async, multi-connection, resumable). No UI dependencies.
- **PDM.Infrastructure** — SQLite catalog, `DownloadManager`, quiet-hours scheduler, categories, post-download hook.
- **PDM.Licensing** — trial + grace-period, hardware binding, DPAPI-encrypted store, pluggable transport (drop in Keygen client later).
- **PDM.Updater** — signed manifest fetch (ECDSA P-256), SHA-256 package verification, staging, release channels.
- **PDM.App** — WPF desktop UI on WPF-UI 4.3 (Fluent/Mica), MVVM via `CommunityToolkit.Mvvm`, system tray, drag-and-drop, single-instance, Serilog rolling file logs.
- **PDM.Cli** — thin command-line front end used to exercise the engine.
- **xUnit** — **81 tests**, all passing.

## 🤖 AI-Powered Features (Coming Soon)

Thanks to support from AI partners, we're building intelligent features powered by Claude API:

- 🧠 **Smart Categorization** — AI automatically organizes downloads by analyzing URLs and content
- 🛡️ **Safety Analysis** — Claude flags suspicious downloads with explanations
- 💬 **Natural Language Interface** — "Download the latest Python 3.12 for Windows" → done
- 📊 **Intelligent Scheduling** — AI learns your patterns and optimizes download timing
- 📝 **Document Summaries** — Get AI summaries of downloaded PDFs (opt-in)

**All AI features will be free in the Community Edition.** See **[docs/AI_ROADMAP.md](docs/AI_ROADMAP.md)** for details.

---

## 📚 Documentation

### User Documentation
- **[docs/USER-GUIDE.md](docs/USER-GUIDE.md)** — end-user manual (install, download, settings)
- **[docs/BROWSER-EXTENSION.md](docs/BROWSER-EXTENSION.md)** — Chrome/Edge/Brave extension setup

### Developer Documentation
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — system design, modules, data flow
- **[docs/AI_ROADMAP.md](docs/AI_ROADMAP.md)** — Claude API integration roadmap
- **[docs/API-REFERENCE.md](docs/API-REFERENCE.md)** — licensing API endpoints
- **[docs/COMMANDS.md](docs/COMMANDS.md)** — build/test/publish commands
- **[docs/SECURITY.md](docs/SECURITY.md)** — security model and threat analysis

### Project Management
- **[docs/ROADMAP.md](docs/ROADMAP.md)** — quarterly goals and milestones
- **[CHANGELOG.md](CHANGELOG.md)** — version history
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — how to contribute
- **[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)** — community standards

## 🚀 Quick Start

The Community Edition is **fully functional without any trial limitations or license keys**. Simply build and run!

### Prerequisites

- Windows 10/11 (x64)
- .NET 10 SDK (verified with `10.0.301`)

### Build the whole solution

```powershell
dotnet build
```

Expected output: `Build succeeded. 0 Warning(s) 0 Error(s)`.

### Run the full test suite

```powershell
dotnet test
```

Expected: **81 passed, 0 failed** across four test projects (`PDM.Core.Tests`, `PDM.Infrastructure.Tests`, `PDM.Licensing.Tests`, `PDM.Updater.Tests`).

### Run the desktop app

```powershell
dotnet run --project src/PDM.App
```

You should see the main window with the beautiful Fluent/Mica design. The Community Edition runs without any trial limitations or license prompts.

Try:
- **Add Download** → paste a URL and hit Enter.
- **Add Many** → paste one URL per line.
- **Drag a link** from any browser onto the window.
- Right-click a download for pause/resume/open/show-in-folder/remove.
- **Settings** → adjust connections, speed cap, overwrite policy, quiet-hours schedule, notifications, theme.
- **Check for Updates** → automatic update checking keeps you on the latest version.

### Run the CLI (optional)

Fast way to smoke-test the engine against a real server:

```powershell
dotnet run --project src/PDM.Cli -- "https://proof.ovh.net/files/10Mb.dat" ".\downloads" --connections 8
```

Press Ctrl+C to pause; re-run the same command to resume from persisted state.

### Where things live

- Settings and license: `%LOCALAPPDATA%\PerfectDownloadManager\`
- Per-download resumable state (JSON sidecars): `%LOCALAPPDATA%\PerfectDownloadManager\state\`
- SQLite history catalog: `%LOCALAPPDATA%\PerfectDownloadManager\pdm.db`
- Rolling logs: `%LOCALAPPDATA%\PerfectDownloadManager\logs\pdm-YYYY-MM-DD.log`
- Downloaded files: `%USERPROFILE%\Downloads\PDM\<Category>\` by default

## Architecture

### Engine (Stage 1)

- **Probe** — single-byte range request detects range support + total size in one round trip.
- **Plan** — `SegmentPlanner` chooses connection count and byte ranges.
- **Transfer** — segments run concurrently into a preallocated `.pdmdownload` file, throttled by a shared token-bucket, retrying on transient failures, resuming from durable per-segment offsets.
- **Reserve** — the part file is created empty during `PrepareAsync` so back-to-back queued downloads never race on the same destination path.
- **Overwrite policy** — Rename (default), Overwrite, or Skip.
- **Finalize** — verifies the written size, atomically moves the part file to its final path.

### Persistence + orchestration (Stage 2)

- SQLite catalog, WAL, parameterized SQL, indexed by status/category.
- `DownloadManager` — queue, `MaxSimultaneousDownloads` limit, event surface, structured logging.
- **Post-download hook** — user-configurable command invoked with the file path (e.g. `MpCmdRun.exe` for a virus scan).
- Mid-flight downloads at shutdown restore as **Paused**.

### Desktop app (Stage 3 + 5)

- WPF-UI FluentWindow with Mica; theme selector (Light / Dark / System).
- Downloads grid with progress bars, speed, ETA, active connections, status.
- Toolbar: **Add Download**, **Add Many** (paste many URLs), **Resume**, **Pause**, **Remove**, **Settings**, **License**, **Check for Updates**.
- **Drag-and-drop** URLs from any browser.
- **System tray** icon with Open / Add / Exit.
- **Balloon notifications** on Completed / Failed (WinForms hidden NotifyIcon — no AUMID needed).
- **Single-instance**: launching PDM a second time focuses the existing window.
- **Serilog rolling logs** with daily rotation and a 14-file retention window.
- **Settings dialog**: theme, folders, connections, global speed cap, proxy, user-agent, notifications, schedule, overwrite policy, post-download command.

### Licensing (Stage 6)

The Community Edition is free and open source without any licensing restrictions. For those who want to support the project and receive priority support:

- **Premium Support Plans** — optional paid plans that provide priority email/chat support, early access to features, and help sustain development.
- **Hardware binding & activation** — infrastructure exists for enterprise deployments that need centralized license management (optional).
- **Self-hosted licensing server** — the admin portal in `admin-portal/` allows organizations to run their own license server if desired.

**For most users:** Just use the free Community Edition without any activation or license keys!

### Auto-update (Stage 7)

- **Signed manifest** — ECDSA P-256 detached signature over canonical JSON.
- **Channels** — Stable and Beta.
- **Package verification** — size + SHA-256 both checked before promoting from `.part`.
- **Public key** configured via `AppSettings.UpdatePublicKeyBase64` at packaging time.
- The apply/swap step is a small launcher, added at packaging time (Stage 8).

## Roadmap

- [x] **Stage 1** — Core engine.
- [x] **Stage 2** — Persistence + queue manager + categories.
- [x] **Stage 3** — WPF desktop UI.
- [ ] **Stage 4** — Browser integration (deferred by user).
- [x] **Stage 5** — Settings, quiet-hours scheduler, balloon notifications, overwrite policy, post-download hook, bulk add, single-instance, logging.
- [x] **Stage 6** — Licensing scaffolding (trial, grace, hardware binding, DPAPI, transport seam). Server integration paused pending your decision.
- [x] **Stage 7** — Update service (signed manifest, hash verification, staging). Launcher/installer is a Stage 8 concern.
- [ ] **Stage 8** — Packaging: MSI/MSIX installer, code signing certificate, update-launcher helper, AUMID for native Windows 11 toasts.

## Security notes

- All SQL is parameterized and self-authored; the SQLite DB lives in per-user `LOCALAPPDATA`.
- License records are DPAPI-encrypted at the current-user scope.
- Update manifests are ECDSA-signed; a compromised update host cannot force malicious payloads unless the private signing key is also compromised.
- HTTPS is required for update fetch; the `HttpClient` uses the OS trust store.
- CVE-2025-6965 (native SQLite advisory) is unreachable in our threat model; suppression documented inline in `PDM.Infrastructure.csproj`.

## 🤝 Contributing

We welcome contributions from the community! Whether you're fixing bugs, adding features, or improving documentation, your help is appreciated.

### How to Contribute
1. **Fork the repository** and clone it locally
2. **Create a branch** for your feature: `git checkout -b feature/amazing-feature`
3. **Make your changes** and add tests if applicable
4. **Run the test suite**: `dotnet test` (ensure all 81 tests pass)
5. **Commit your changes**: `git commit -m 'Add amazing feature'`
6. **Push to your fork**: `git push origin feature/amazing-feature`
7. **Open a Pull Request** with a clear description

### Development Guidelines
- Follow the existing code style and conventions
- Add tests for new functionality
- Update documentation as needed
- Keep commits atomic and well-described

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines.

## 📄 License

This project is licensed under the **MIT License** - see the [LICENSE](LICENSE) file for details.

You are free to:
- ✅ Use commercially
- ✅ Modify
- ✅ Distribute
- ✅ Use privately

## 🙏 Support the Project

Perfect Download Manager is free and open source. If you find it useful, consider:

- ⭐ **Star this repository** to help others discover it
- 💬 **Join discussions** and help other users
- 🐛 **Report bugs** and suggest features
- 🔧 **Contribute code** or documentation
- 💎 **Get Premium Support** to help sustain development

**[Become a Sponsor →](https://perfectdownloadmanager.com/pricing)**

## 📧 Contact & Community

- **Website**: [PerfectDownloadManager.com](https://PerfectDownloadManager.com)
- **GitHub Discussions**: [Community Forum](https://github.com/yourusername/PDM/discussions)
- **Issues**: [Bug Reports & Feature Requests](https://github.com/yourusername/PDM/issues)
- **Email**: support@perfectdownloadmanager.com
- **Premium Support**: [Get Priority Help](https://perfectdownloadmanager.com/pricing)

## 🌟 Acknowledgments

Built with:
- [.NET 10](https://dotnet.microsoft.com/) - Microsoft's modern development platform
- [WPF-UI](https://wpfui.lepo.co/) - Modern Fluent Design controls
- [CommunityToolkit.Mvvm](https://github.com/CommunityToolkit/dotnet) - MVVM helpers
- [Serilog](https://serilog.net/) - Structured logging

Special thanks to all contributors who help make PDM better!

---

<p align="center">
  Made with ❤️ by the PDM Community | <a href="https://perfectdownloadmanager.com">PerfectDownloadManager.com</a>
</p>
