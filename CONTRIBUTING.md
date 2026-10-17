# Contributing to Perfect Download Manager

Thank you for your interest in contributing to PDM! This project is community-driven and every contribution — no matter how small — makes a difference.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Ways to Contribute](#ways-to-contribute)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Submitting Changes](#submitting-changes)
- [Code Style](#code-style)
- [Testing](#testing)
- [Documentation](#documentation)
- [Community](#community)

---

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold these standards. Please report unacceptable behavior to **conduct@perfectdownloadmanager.com**.

---

## Ways to Contribute

You don't need to write code to contribute meaningfully:

- 🐛 **Report bugs** — open a [GitHub Issue](https://github.com/vpbgkt/Perfect-Download-Manager/issues/new?template=bug_report.md)
- 💡 **Suggest features** — open a [Feature Request](https://github.com/vpbgkt/Perfect-Download-Manager/issues/new?template=feature_request.md)
- 📝 **Improve documentation** — fix typos, clarify steps, add examples
- 🌍 **Translate** — help localize PDM for non-English speakers
- 🧪 **Test pre-releases** — try Beta channel builds and report issues
- 💬 **Help in Discussions** — answer questions from other users
- ⭐ **Star the repo** — increases visibility for others discovering the project
- 💎 **Become a supporter** — [Premium plans](https://perfectdownloadmanager.com/pricing) directly fund development

---

## Getting Started

### Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Windows | 10/11 (x64) | Required for WPF app |
| .NET SDK | 10.0.x | `dotnet --version` to check |
| Node.js | 22.x | For admin-portal & browser extension |
| Git | Any recent | — |

### Fork & Clone

```powershell
# 1. Fork the repo on GitHub, then clone YOUR fork
git clone https://github.com/YOUR-USERNAME/Perfect-Download-Manager.git
cd Perfect-Download-Manager

# 2. Add upstream remote
git remote add upstream https://github.com/vpbgkt/Perfect-Download-Manager.git

# 3. Keep your fork up to date
git fetch upstream
git merge upstream/main
```

---

## Development Setup

### Build the full solution

```powershell
dotnet build PDM.sln
```

Expected: `Build succeeded. 0 Warning(s) 0 Error(s)`

### Run all tests

```powershell
dotnet test PDM.sln
```

Expected: **81 passed, 0 failed**

### Run the desktop app

```powershell
dotnet run --project src/PDM.App
```

### Run the CLI (quick engine smoke test)

```powershell
dotnet run --project src/PDM.Cli -- "https://proof.ovh.net/files/10Mb.dat" ".\downloads" --connections 8
```

### Admin portal (Node.js)

```powershell
cd admin-portal
npm ci
npm run dev
```

### Browser extension tests

```powershell
node --test --test-force-exit browser-extension/tests/background.test.js
```

---

## Submitting Changes

### Branch Naming

Use descriptive branch names:

```
feature/smart-categorization
fix/resume-on-network-drop
docs/add-architecture-diagram
refactor/segment-planner-cleanup
```

### Workflow

1. **Create a branch** from `main`
2. **Make your changes** in focused, atomic commits
3. **Write or update tests** — all 81 existing tests must still pass
4. **Update documentation** if your change affects user-facing behavior
5. **Open a Pull Request** against `main`
6. **Fill in the PR template** completely — partial PRs slow down review
7. **Respond to review feedback** promptly

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add smart URL categorization
fix: resume download after network drop
docs: add architecture diagram to README
test: add segment planner edge cases
refactor: extract token bucket into separate class
```

### Pull Request Size

- Keep PRs focused — one feature or fix per PR
- Large features? Open an issue first to discuss the design
- PRs over ~500 lines of change get harder to review — split them if possible

---

## Code Style

### C# / .NET

- Follow the existing code conventions in the project
- Use `CancellationToken` consistently in async paths
- Parameterize all SQL — no string concatenation in queries
- Keep `PDM.Core` free of UI and infrastructure dependencies
- Add XML doc comments to public APIs

### TypeScript / JavaScript (admin-portal, backend)

- Follow the existing ESLint config
- Use `async`/`await` over raw Promises
- Keep AWS SDK calls wrapped in try/catch with typed errors

### General

- No TODO comments in merged code — open an issue instead
- No secrets, credentials, or API keys in commits
- `.env` files are gitignored — use `.env.example` for templates

---

## Testing

### Test Projects

| Project | Focus |
|---------|-------|
| `PDM.Core.Tests` | Download engine, segment planner, stress harness |
| `PDM.Infrastructure.Tests` | SQLite catalog, DownloadManager orchestration |
| `PDM.Licensing.Tests` | Trial logic, DPAPI store, token verification |
| `PDM.Updater.Tests` | Manifest parsing, signature verification |

### Adding Tests

- New features **require** tests
- Bug fixes **should** include a regression test
- Use `[Theory]` + `[InlineData]` for parameterized cases
- Stress/flake-prone tests: mark with the `Stress` category so CI can soak them nightly

### Running a Specific Test Project

```powershell
dotnet test tests/PDM.Core.Tests/PDM.Core.Tests.csproj -v normal
```

---

## Documentation

Documentation lives in `docs/`. If your change affects:

- **User-facing behavior** → update `docs/USER-GUIDE.md`
- **Build/publish steps** → update `docs/COMMANDS.md`
- **API endpoints** → update `docs/API-REFERENCE.md`
- **Security model** → update `docs/SECURITY.md`
- **Architecture** → update `docs/ARCHITECTURE.md`

Docs use standard Markdown. Diagrams use Mermaid (rendered on GitHub).

---

## Community

- **Discussions**: [GitHub Discussions](https://github.com/vpbgkt/Perfect-Download-Manager/discussions) — questions, ideas, show & tell
- **Issues**: [GitHub Issues](https://github.com/vpbgkt/Perfect-Download-Manager/issues) — bugs and feature requests
- **Email**: contributors@perfectdownloadmanager.com
- **Premium Supporters Discord**: available to [premium plan](https://perfectdownloadmanager.com/pricing) subscribers

---

## Recognition

All contributors are listed in [SUPPORTERS.md](SUPPORTERS.md). Significant contributors may be invited to the core team.

Thank you for helping make PDM better for everyone. 🚀
