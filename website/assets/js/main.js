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
})();
