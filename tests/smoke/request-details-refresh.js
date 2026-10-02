// Run in the browser console on an authenticated /dashboard/usage?tab=details.
// Uses synthetic API responses only; does not write usage data or change settings.
(async () => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const waitFor = async (condition, label) => {
    const deadline = Date.now() + 10000;
    while (!condition()) {
      assert(Date.now() < deadline, `Timed out: ${label}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const clickTab = (name) => {
    const button = [...document.querySelectorAll("button")].find(el => el.textContent.trim() === name);
    assert(button, `Missing ${name} tab`);
    button.click();
  };
  const originalFetch = window.fetch;
  let requests = 0;
  let refreshed = false;
  window.fetch = async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : input, location.href);
    if (url.pathname !== "/api/usage/request-details") return originalFetch(input, options);
    requests++;
    return Response.json({
      details: [{
        id: "refresh-smoke", timestamp: new Date().toISOString(),
        model: refreshed ? "smoke-newest-model" : "smoke-older-model",
        provider: "openai", tokens: { prompt_tokens: 100, completion_tokens: 20 }
      }],
      pagination: { page: Number(url.searchParams.get("page")), pageSize: 20, totalItems: 1, totalPages: 1 }
    });
  };
  try {
    clickTab("Overview");
    await waitFor(() => !document.querySelector("#provider-filter") && location.search.includes("tab=overview"), "leaving Details");
    clickTab("Details");
    await waitFor(() => document.querySelector("table")?.textContent.includes("smoke-older-model"), "initial row");
    refreshed = true;
    await waitFor(() => document.querySelector("table")?.textContent.includes("smoke-newest-model"), "new row via polling");
    assert(!document.querySelector("table").textContent.includes("smoke-older-model"), "Old rows remain after refresh");
    clickTab("Overview");
    await waitFor(() => !document.querySelector("#provider-filter") && location.search.includes("tab=overview"), "polling cleanup");
    const stoppedAt = requests;
    await new Promise(resolve => setTimeout(resolve, 3500));
    assert(requests === stoppedAt, "Details polling continues after leaving the tab");
    console.log("PASS: Details shows new data without navigation and stops polling on tab exit");
  } finally {
    window.fetch = originalFetch;
    clickTab("Details");
  }
})();
