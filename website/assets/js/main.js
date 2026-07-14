// Perfect Download Manager marketing site — vanilla JS enhancements.
// Kept intentionally tiny so the page stays snappy on slow connections.

(function () {
    "use strict";

    // Mobile navigation toggle. Uses aria-expanded so screen readers know the state.
    var toggle = document.getElementById("navToggle");
    var nav = document.getElementById("siteNav");
    if (toggle && nav) {
        toggle.addEventListener("click", function () {
            var isOpen = nav.classList.toggle("is-open");
            toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
        });

        // Close the menu when any in-page link is clicked so the target section is visible.
        nav.addEventListener("click", function (e) {
            if (e.target.tagName === "A" && nav.classList.contains("is-open")) {
                nav.classList.remove("is-open");
                toggle.setAttribute("aria-expanded", "false");
            }
        });
    }

    // Auto-fill the current year in the footer copyright so we don't ship stale text.
    var yearEl = document.getElementById("year");
    if (yearEl) {
        yearEl.textContent = new Date().getFullYear();
    }

    // ---- Live version + download links from the backend ----
    // The portal publishes public metadata to the S3 updates bucket. We prefer
    // downloads.json (has both MSI + ZIP URLs); if it isn't there yet we fall
    // back to the signed manifest.json (version + portable package). If neither
    // loads, the static values already in the HTML remain as a safe default.
    var S3_BASE = "https://pdm-updates-452359090613-aps1.s3.ap-south-1.amazonaws.com/stable/";

    function formatBytes(bytes) {
        if (!bytes || bytes <= 0) return "";
        var mb = bytes / (1024 * 1024);
        if (mb >= 1024) return (mb / 1024).toFixed(1) + " GB";
        return Math.round(mb) + " MB";
    }

    function setVersion(v) {
        if (!v) return;
        var els = document.querySelectorAll("[data-version]");
        for (var i = 0; i < els.length; i++) els[i].textContent = v;
    }

    function setDownload(id, sizeSel, url, bytes) {
        var a = document.getElementById(id);
        if (!a || !url) return;
        a.setAttribute("href", url);
        a.removeAttribute("target");
        var sizeEl = document.querySelector('[data-size="' + sizeSel + '"]');
        if (sizeEl) {
            var s = formatBytes(bytes);
            sizeEl.textContent = s ? " · " + s : "";
        }
    }

    function applyDownloads(d) {
        if (!d) return;
        setVersion(d.version || d.Version);
        setDownload("dlMsi", "msi", d.msiUrl, d.msiSizeBytes);
        setDownload("dlZip", "zip", d.portableZipUrl || d.PackageUrl, d.portableSizeBytes || d.PackageSizeBytes);
    }

    function fetchJson(url) {
        return fetch(url, { cache: "no-store" }).then(function (r) {
            return r.ok ? r.json() : Promise.reject(new Error(String(r.status)));
        });
    }

    fetchJson(S3_BASE + "downloads.json")
        .then(applyDownloads)
        .catch(function () {
            // Fall back to the signed manifest for version + portable download.
            return fetchJson(S3_BASE + "manifest.json").then(applyDownloads);
        })
        .catch(function () {
            /* offline or nothing published yet — keep the static defaults */
        });
})();
