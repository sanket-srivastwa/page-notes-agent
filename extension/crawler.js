// Browser-side part of course mode. Pages are opened one at a time in a separate window of YOUR browser,
// so your login session, cookies and the site's own JavaScript are used; nothing is fetched from the server side.

// ---------------------------------------------------------------- injected into the tab (must be self-contained)
function discoverInPage() {
  const origin = location.origin;
  const BAD_EXT = /\.(pdf|png|jpe?g|gif|svg|webp|zip|mp4|mp3|css|js|json|xml|ico)$/i;
  const text = (el) => (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
  const norm = (href) => {
    try {
      const u = new URL(href, location.href);
      if (u.origin !== origin) return null;
      const path = u.pathname.replace(/\/+$/, "") || "/";
      if (BAD_EXT.test(path)) return null;
      return { url: origin + path, path };
    } catch { return null; }
  };
  const here = norm(location.href).path;
  const parentOf = (p) => p.replace(/\/[^/]*$/, "") || "/";

  // every link and heading in document order; the nearest heading above a link is its chapter
  let chapter = "";
  const items = [];
  for (const el of document.querySelectorAll("a[href], h1, h2, h3, h4, h5, h6")) {
    if (/^H[1-6]$/.test(el.tagName)) { chapter = text(el); continue; }
    const n = norm(el.getAttribute("href"));
    if (n) items.push({ ...n, text: text(el), chapter });
  }

  const below = (prefix) => {
    const seen = new Map();
    for (const it of items) {
      if (!it.path.startsWith(prefix + "/")) continue;
      const have = seen.get(it.url);
      if (!have) seen.set(it.url, { url: it.url, text: it.text, chapter: it.chapter });
      else if (!have.text && it.text) have.text = it.text;
    }
    return [...seen.values()];
  };

  let prefix = here, pages = below(here), onIndex = true;
  if (pages.length < 2) {
    const parent = parentOf(here);
    // never climb to a one-segment parent such as /courses: that lists every course on the site
    const up = parent.split("/").filter(Boolean).length >= 2 && parent !== here ? below(parent) : [];
    if (up.length >= 2) { prefix = parent; pages = up; onIndex = false; }
  }
  const pretty = (p) => p.split("/").pop().replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const h1 = document.querySelector("h1");
  const h1Text = h1 ? text(h1) : "";
  const docTitle = document.title.split(/\s[|\u2013\u2014-]\s/)[0].trim();
  // the h1 when the tab title agrees with it, otherwise the tab title (an h1 is sometimes just the site logo)
  const title = onIndex
    ? ((h1Text.length > 2 && (docTitle.toLowerCase().includes(h1Text.toLowerCase()) || h1Text.toLowerCase().includes(docTitle.toLowerCase())) ? h1Text : docTitle) || h1Text || pretty(prefix))
    : pretty(prefix);

  return { found: pages.length >= 2, title, prefixPath: prefix, rootUrl: origin + prefix, onIndex, pages };
}

function probeTab() {
  const b = document.body;
  return { len: b ? b.innerText.length : 0, imgs: document.images.length, ready: document.readyState };
}

// Scrolls the biggest scrollable area (the window, or an inner panel that scrolls on its own) and wakes lazy images.
function scrollStep(frac) {
  document.querySelectorAll("img[loading=lazy]").forEach((i) => { i.loading = "eager"; });
  document.querySelectorAll("img[data-src]:not([src])").forEach((i) => i.setAttribute("src", i.getAttribute("data-src")));
  const doc = document.scrollingElement || document.documentElement;
  let best = doc, bestH = doc.scrollHeight > doc.clientHeight + 40 ? doc.scrollHeight : 0;
  for (const el of document.querySelectorAll("main, article, section, div")) {
    if (el.scrollHeight <= el.clientHeight + 40 || el.clientHeight < 200) continue;
    const oy = getComputedStyle(el).overflowY;
    if ((oy === "auto" || oy === "scroll" || oy === "overlay") && el.scrollHeight > bestH) { best = el; bestH = el.scrollHeight; }
  }
  const vh = best === doc ? window.innerHeight : best.clientHeight;
  best.scrollTop += Math.max(200, Math.floor(vh * frac));
  return { y: best.scrollTop, h: best.scrollHeight, vh };
}

function scrollTopAll() {
  document.querySelectorAll("*").forEach((el) => { if (el.scrollTop) el.scrollTop = 0; });
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- panel side
const abortError = () => Object.assign(new Error("Stopped"), { name: "AbortError" });

function sleepMs(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    const t = setTimeout(() => { if (signal) signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(abortError()); };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

const inTab = async (tabId, func, args = []) => {
  const r = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return r && r[0] ? r[0].result : undefined;
};

async function discoverCourse(tabId) {
  return inTab(tabId, discoverInPage);
}

async function openCrawlWindow() {
  const w = await chrome.windows.create({ url: "about:blank", focused: false, width: 1100, height: 850, type: "normal" });
  await chrome.storage.local.set({ crawlWindowId: w.id });
  return { windowId: w.id, tabId: w.tabs[0].id };
}

async function closeCrawlWindow(handle) {
  if (handle) { try { await chrome.windows.remove(handle.windowId); } catch { /* already closed */ } }
  await chrome.storage.local.remove("crawlWindowId");
}

// A crawl window left behind by a panel that was closed mid-crawl.
async function closeStaleCrawlWindow() {
  const { crawlWindowId } = await chrome.storage.local.get("crawlWindowId");
  if (crawlWindowId) { try { await chrome.windows.remove(crawlWindowId); } catch { /* gone */ } }
  await chrome.storage.local.remove("crawlWindowId");
}

function navigateTab(tabId, url, signal, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    let sawLoading = false;
    const finish = (err) => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      err ? reject(err) : resolve();
    };
    const onUpdated = (id, info) => {
      if (id !== tabId) return;
      if (info.status === "loading") sawLoading = true;
      if (info.status === "complete" && sawLoading) finish();
    };
    const onAbort = () => finish(abortError());
    const timer = setTimeout(() => finish(), timeoutMs); // some single-page apps never report "complete"; carry on
    chrome.tabs.onUpdated.addListener(onUpdated);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    chrome.tabs.update(tabId, { url }).catch(finish);
  });
}

// Wait until the page text and image count stop changing (single-page apps render after "load").
async function settleTab(tabId, signal, maxMs = 25000) {
  let prev = null, stable = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    await sleepMs(500, signal);
    const s = await inTab(tabId, probeTab);
    if (s && s.ready === "complete" && s.len > 0 && prev && s.len === prev.len && s.imgs === prev.imgs) {
      if (++stable >= 3) return;
    } else stable = 0;
    prev = s;
  }
}

async function autoScrollTab(tabId, signal) {
  let still = 0, lastH = -1;
  for (let step = 0; step < 80; step++) {
    const r = await inTab(tabId, scrollStep, [0.8]);
    if (!r) break;
    await sleepMs(300, signal);
    if (r.y + r.vh >= r.h - 4 && r.h === lastH) { if (++still >= 2) break; } else still = 0;
    lastH = r.h;
  }
  await inTab(tabId, scrollTopAll);
}

const LOGIN_PATH = /\/(log-?in|sign-?in|signup|sign-up|auth|account\/login)(\/|$)/i;
const pathOf = (u) => { try { return new URL(u).pathname.replace(/\/+$/, "") || "/"; } catch { return ""; } };

/**
 * Loads `url` in the crawl tab, waits for it to render, scrolls to the end, and runs extractor.js on it.
 * Throws LoginError when the site sent us somewhere outside the course (almost always a login page).
 */
async function captureInTab(tabId, url, prefixPath, signal) {
  await navigateTab(tabId, url, signal);
  await settleTab(tabId, signal);
  await autoScrollTab(tabId, signal);
  await sleepMs(400, signal);

  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, files: ["extractor.js"] });
  if (!result) throw new Error("Could not read the page.");

  const finalPath = pathOf(result.url);
  const inCourse = finalPath === prefixPath || finalPath.startsWith(prefixPath + "/");
  if (!inCourse || LOGIN_PATH.test(finalPath)) {
    throw new LoginError(`The site redirected to ${result.url}. Are you logged in? Log in in your normal window, then press Resume.`);
  }
  if (!result.blocks.length || result.stats.chars < 200) {
    throw new Error("No readable content (the page did not load, or it needs a login).");
  }
  return result;
}
