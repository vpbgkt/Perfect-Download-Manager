const HOST_NAME = "com.pdm.host";

const checkbox = document.getElementById("intercept");
const testButton = document.getElementById("test");

// Restore the interception toggle.
chrome.storage.local.get({ intercept: false }).then(({ intercept }) => {
  checkbox.checked = intercept;
});

checkbox.addEventListener("change", () => {
  chrome.storage.local.set({ intercept: checkbox.checked });
});

testButton.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !/^https?:\/\//i.test(tab.url)) {
    return;
  }
  chrome.runtime.sendNativeMessage(HOST_NAME, { url: tab.url, referrer: "", filename: "" }, () => {
    window.close();
  });
});
