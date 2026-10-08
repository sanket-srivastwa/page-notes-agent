// Renders the notes handed over by the side panel and opens the browser's print dialog.
(async () => {
  const status = document.getElementById("status");
  const root = document.getElementById("notes");
  const again = document.getElementById("again");

  const { printJob } = await chrome.storage.local.get("printJob");
  if (!printJob || !printJob.md) {
    status.textContent = "Nothing to print. Generate notes in the side panel first, then press Save as PDF.";
    return;
  }

  // Chrome uses the page title as the default PDF file name.
  document.title = (printJob.title || "notes").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "notes";

  // Lazy images are never fetched for pages that are not on screen, which would leave blanks in the PDF.
  root.innerHTML = render(printJob.md, { ids: true }).replace(/ loading="lazy"/g, "");

  const imgs = [...root.querySelectorAll("img")];
  status.textContent = imgs.length ? `Loading ${imgs.length} image(s)…` : "Ready.";
  await Promise.all(imgs.map((img) => img.complete ? null : new Promise((resolve) => {
    img.addEventListener("load", resolve, { once: true });
    img.addEventListener("error", resolve, { once: true });
  })));

  const broken = imgs.filter((i) => i.complete && i.naturalWidth === 0).length;
  status.textContent = broken
    ? `${broken} image(s) could not be loaded. Is the backend still running? Start it and press the button again.`
    : 'In the print dialog, set Destination to "Save as PDF".';
  again.hidden = false;
  again.onclick = () => window.print();
  if (!broken) setTimeout(() => window.print(), 250);
})();
