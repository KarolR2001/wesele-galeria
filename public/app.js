const API = "/api";
const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_RETRIES = 6;
const SESSION_MAX_AGE_MS = 6 * 24 * 60 * 60 * 1000;

const MIME_BY_EXTENSION = {
  avif: "image/avif",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  "3gp": "video/3gpp",
  m4v: "video/x-m4v",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  mp4: "video/mp4",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
  webm: "video/webm",
};

const elements = {
  fileInput: document.querySelector("#file-input"),
  uploadSummary: document.querySelector("#upload-summary"),
  uploadQueue: document.querySelector("#upload-queue"),
  gallery: document.querySelector("#gallery"),
  galleryStatus: document.querySelector("#gallery-status"),
  refreshButton: document.querySelector("#refresh-button"),
  loadMoreButton: document.querySelector("#load-more-button"),
  viewer: document.querySelector("#viewer"),
  viewerTitle: document.querySelector("#viewer-title"),
  viewerContent: document.querySelector("#viewer-content"),
  viewerDownload: document.querySelector("#viewer-download"),
  viewerDrive: document.querySelector("#viewer-drive"),
  viewerClose: document.querySelector("#viewer-close"),
};

const state = {
  uploading: false,
  nextPageToken: null,
  galleryLoading: false,
  wakeLock: null,
};

elements.fileInput.addEventListener("change", handleFileSelection);
elements.refreshButton.addEventListener("click", () => loadGallery({ reset: true }));
elements.loadMoreButton.addEventListener("click", () => loadGallery({ reset: false }));
elements.viewerClose.addEventListener("click", closeViewer);
elements.viewer.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeViewer();
});
elements.viewer.addEventListener("click", (event) => {
  if (event.target === elements.viewer) {
    closeViewer();
  }
});
window.addEventListener("beforeunload", (event) => {
  if (!state.uploading) {
    return;
  }
  event.preventDefault();
  event.returnValue = "";
});
window.addEventListener("online", () => {
  if (!state.uploading) {
    elements.uploadSummary.textContent = "Połączenie z Internetem zostało przywrócone.";
  }
});
window.addEventListener("offline", () => {
  elements.uploadSummary.textContent = "Brak Internetu. Przesyłanie zostanie ponowione po odzyskaniu połączenia.";
});
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && state.uploading) {
    await requestWakeLock();
  }
});

window.addEventListener("load", () => {
  setTimeout(() => {
    const splash = document.getElementById("splash-screen");
    if (splash) {
      splash.classList.add("fade-out");
      setTimeout(() => splash.remove(), 800);
    }
  }, 2800);
});

loadGallery({ reset: true });

async function handleFileSelection() {
  const files = Array.from(elements.fileInput.files || []);
  elements.fileInput.value = "";

  if (files.length === 0 || state.uploading) {
    return;
  }

  const prepared = files.map(prepareFile);
  const rejected = prepared.filter((entry) => !entry.ok);
  const accepted = prepared.filter((entry) => entry.ok);

  elements.uploadQueue.replaceChildren();
  for (const entry of prepared) {
    entry.row = createUploadRow(entry.file, entry.ok ? "Oczekuje" : entry.error);
    elements.uploadQueue.append(entry.row.root);
    if (!entry.ok) {
      setRowState(entry.row, 0, entry.error, "error");
    }
  }

  if (accepted.length === 0) {
    elements.uploadSummary.textContent = "Nie wybrano obsługiwanych zdjęć ani filmów.";
    return;
  }

  state.uploading = true;
  await requestWakeLock();
  let successCount = 0;

  try {
    for (let index = 0; index < accepted.length; index += 1) {
      const entry = accepted[index];
      elements.uploadSummary.textContent = `Przesyłanie ${index + 1} z ${accepted.length}…`;
      try {
        await uploadFile(entry.file, entry.mimeType, entry.row);
        successCount += 1;
      } catch (error) {
        console.error("Upload failed", error);
        setRowState(entry.row, entry.row.progress.value, readableError(error), "error");
      }
    }
  } finally {
    state.uploading = false;
    await releaseWakeLock();
  }

  const failureCount = accepted.length - successCount + rejected.length;
  if (successCount > 0 && failureCount === 0) {
    elements.uploadSummary.textContent = `Gotowe. Przesłano ${successCount} ${fileWord(successCount)}.`;
  } else if (successCount > 0) {
    elements.uploadSummary.textContent = `Przesłano ${successCount} ${fileWord(successCount)}. Nie udało się przesłać ${failureCount}.`;
  } else {
    elements.uploadSummary.textContent = "Nie udało się przesłać plików. Sprawdź Internet i spróbuj ponownie.";
  }

  if (successCount > 0) {
    await sleep(1200);
    await loadGallery({ reset: true });
    window.setTimeout(() => loadGallery({ reset: true, quiet: true }), 7000);
  }
}

function prepareFile(file) {
  const mimeType = detectMimeType(file);
  if (!mimeType || (!mimeType.startsWith("image/") && !mimeType.startsWith("video/"))) {
    return {
      ok: false,
      file,
      mimeType: "",
      error: "Ten plik nie jest rozpoznanym zdjęciem ani filmem.",
    };
  }

  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    return {
      ok: false,
      file,
      mimeType,
      error: "Plik jest pusty albo ma nieprawidłowy rozmiar.",
    };
  }

  return { ok: true, file, mimeType };
}

function detectMimeType(file) {
  if (file.type && (file.type.startsWith("image/") || file.type.startsWith("video/"))) {
    return file.type;
  }
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  return MIME_BY_EXTENSION[extension] || "";
}

async function uploadFile(file, mimeType, row) {
  const key = sessionStorageKey(file);
  const saved = readSavedSession(key, file);
  let uploadUrl = saved?.uploadUrl || "";
  let offset = 0;
  let chunkSize = saved?.chunkSize || DEFAULT_CHUNK_SIZE;

  if (uploadUrl) {
    setRowState(row, 0, "Sprawdzanie poprzedniej sesji…");
    const status = await withRetries(
      () => queryUploadStatus(uploadUrl, file.size),
      row,
      "Sprawdzanie sesji",
    );

    if (status.complete) {
      localStorage.removeItem(key);
      setRowState(row, 100, "Przesłano", "success");
      return;
    }
    if (status.expired) {
      localStorage.removeItem(key);
      uploadUrl = "";
    } else {
      offset = status.offset;
      setRowState(row, percentage(offset, file.size), "Wznawianie przesyłania…");
    }
  }

  if (!uploadUrl) {
    setRowState(row, 0, "Rozpoczynanie przesyłania…");
    const session = await withRetries(
      () => createUploadSession(file, mimeType),
      row,
      "Rozpoczęcie przesyłania",
    );
    uploadUrl = session.uploadUrl;
    chunkSize = normalizeChunkSize(session.chunkSize);
    saveSession(key, file, uploadUrl, chunkSize);
  }

  while (offset < file.size) {
    const endExclusive = Math.min(offset + chunkSize, file.size);
    const chunk = file.slice(offset, endExclusive);
    const chunkStart = offset;

    const result = await uploadChunkWithRecovery({
      uploadUrl,
      chunk,
      start: chunkStart,
      endInclusive: endExclusive - 1,
      total: file.size,
      mimeType,
      row,
      onProgress: (loaded) => {
        const sent = Math.min(chunkStart + loaded, file.size);
        setRowState(row, percentage(sent, file.size), `Przesyłanie: ${formatBytes(sent)} z ${formatBytes(file.size)}`);
      },
    });

    if (result.complete) {
      localStorage.removeItem(key);
      setRowState(row, 100, "Przesłano", "success");
      return;
    }

    if (result.expired) {
      localStorage.removeItem(key);
      throw new Error("Sesja przesyłania wygasła. Wybierz plik ponownie.");
    }

    offset = result.offset;
    saveSession(key, file, uploadUrl, chunkSize, offset);
    setRowState(row, percentage(offset, file.size), `Przesłano ${formatBytes(offset)} z ${formatBytes(file.size)}`);
  }

  const finalStatus = await queryUploadStatus(uploadUrl, file.size);
  if (!finalStatus.complete) {
    throw new Error("Google nie potwierdził zakończenia przesyłania.");
  }
  localStorage.removeItem(key);
  setRowState(row, 100, "Przesłano", "success");
}

async function createUploadSession(file, mimeType) {
  let response;
  try {
    response = await fetch(`${API}/uploads/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: file.name,
        mimeType,
        size: file.size,
      }),
    });
  } catch {
    throw new RetryableError("Nie udało się połączyć z serwerem galerii.");
  }

  const payload = await parseJson(response);
  if (!response.ok || !payload.uploadUrl) {
    const message = payload.error || "Nie udało się rozpocząć przesyłania.";
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      throw new RetryableError(message, response.status);
    }
    throw new Error(message);
  }
  return payload;
}

async function uploadChunkWithRecovery(options) {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await uploadChunk(options);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === MAX_RETRIES) {
        throw error;
      }

      const delay = retryDelay(attempt);
      setRowState(options.row, options.row.progress.value, `Sprawdzanie przesłanych danych i ponowienie za ${Math.ceil(delay / 1000)} s…`);
      await waitUntilOnline();
      await sleep(delay);

      try {
        const status = await queryUploadStatus(options.uploadUrl, options.total);
        if (status.complete || status.expired || status.offset !== options.start) {
          return status;
        }
      } catch (statusError) {
        if (!isRetryable(statusError)) {
          throw statusError;
        }
      }
    }
  }

  throw lastError;
}

function uploadChunk({ uploadUrl, chunk, start, endInclusive, total, mimeType, onProgress }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.timeout = 5 * 60 * 1000;
    xhr.setRequestHeader("Content-Range", `bytes ${start}-${endInclusive}/${total}`);
    xhr.setRequestHeader("Content-Type", mimeType || "application/octet-stream");

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(event.loaded);
      }
    };

    xhr.onload = async () => {
      if (xhr.status === 200 || xhr.status === 201) {
        resolve({ complete: true, offset: total });
        return;
      }

      if (xhr.status === 308) {
        const receivedEnd = parseReceivedEnd(xhr.getResponseHeader("Range"));
        if (receivedEnd !== null) {
          resolve({ complete: false, offset: receivedEnd + 1 });
          return;
        }
        try {
          resolve(await queryUploadStatus(uploadUrl, total));
        } catch (error) {
          reject(error);
        }
        return;
      }

      if (xhr.status === 404 || xhr.status === 410) {
        resolve({ complete: false, expired: true, offset: 0 });
        return;
      }

      reject(createHttpError(xhr.status, xhr.responseText));
    };

    xhr.onerror = () => reject(new RetryableError("Nie udało się połączyć z Google Drive."));
    xhr.ontimeout = () => reject(new RetryableError("Przesyłanie trwało zbyt długo i zostanie ponowione."));
    xhr.onabort = () => reject(new Error("Przesyłanie zostało przerwane."));
    xhr.send(chunk);
  });
}

function queryUploadStatus(uploadUrl, total) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.timeout = 60 * 1000;
    xhr.setRequestHeader("Content-Range", `bytes */${total}`);

    xhr.onload = () => {
      if (xhr.status === 200 || xhr.status === 201) {
        resolve({ complete: true, offset: total });
        return;
      }
      if (xhr.status === 308) {
        const receivedEnd = parseReceivedEnd(xhr.getResponseHeader("Range"));
        resolve({ complete: false, offset: receivedEnd === null ? 0 : receivedEnd + 1 });
        return;
      }
      if (xhr.status === 404 || xhr.status === 410) {
        resolve({ complete: false, expired: true, offset: 0 });
        return;
      }
      reject(createHttpError(xhr.status, xhr.responseText));
    };

    xhr.onerror = () => reject(new RetryableError("Nie udało się sprawdzić stanu przesyłania."));
    xhr.ontimeout = () => reject(new RetryableError("Sprawdzanie przesyłania trwało zbyt długo."));
    xhr.send(null);
  });
}

async function withRetries(operation, row, retryMessage) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === MAX_RETRIES) {
        throw error;
      }
      const delay = retryDelay(attempt);
      setRowState(row, row.progress.value, `${retryMessage} za ${Math.ceil(delay / 1000)} s…`);
      await waitUntilOnline();
      await sleep(delay);
    }
  }
  throw lastError;
}

function createHttpError(status, responseText) {
  const message = status === 429 || status >= 500
    ? `Google Drive chwilowo nie odpowiada (HTTP ${status}).`
    : `Przesyłanie zostało odrzucone (HTTP ${status}). ${responseText || ""}`.trim();
  if (status === 408 || status === 429 || status >= 500 || status === 0) {
    return new RetryableError(message, status);
  }
  const error = new Error(message);
  error.status = status;
  return error;
}

class RetryableError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "RetryableError";
    this.status = status;
  }
}

function isRetryable(error) {
  return error instanceof RetryableError || error?.status === 408 || error?.status === 429 || error?.status >= 500;
}

function retryDelay(attempt) {
  const base = Math.min(1000 * (2 ** attempt), 30_000);
  return base + Math.floor(Math.random() * 700);
}

async function waitUntilOnline() {
  if (navigator.onLine !== false) {
    return;
  }
  await new Promise((resolve) => window.addEventListener("online", resolve, { once: true }));
}

function parseReceivedEnd(rangeHeader) {
  const match = rangeHeader?.match(/bytes=0-(\d+)/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function normalizeChunkSize(value) {
  const parsed = Number(value);
  const minimum = 256 * 1024;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed % minimum !== 0) {
    return DEFAULT_CHUNK_SIZE;
  }
  return parsed;
}

function sessionStorageKey(file) {
  return `wesele-upload:${encodeURIComponent(file.name)}:${file.size}:${file.lastModified}`;
}

function saveSession(key, file, uploadUrl, chunkSize, offset = 0) {
  try {
    localStorage.setItem(key, JSON.stringify({
      uploadUrl,
      chunkSize,
      offset,
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      savedAt: Date.now(),
    }));
  } catch {
    // Brak localStorage nie blokuje bieżącego przesyłania.
  }
}

function readSavedSession(key, file) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return null;
    }
    const saved = JSON.parse(raw);
    const valid = saved.uploadUrl &&
      saved.name === file.name &&
      saved.size === file.size &&
      saved.lastModified === file.lastModified &&
      Date.now() - saved.savedAt < SESSION_MAX_AGE_MS;
    if (!valid) {
      localStorage.removeItem(key);
      return null;
    }
    return saved;
  } catch {
    localStorage.removeItem(key);
    return null;
  }
}

function createUploadRow(file, initialMessage) {
  const root = document.createElement("article");
  root.className = "upload-item";

  const name = document.createElement("span");
  name.className = "upload-name";
  name.textContent = file.name;
  name.title = file.name;

  const detail = document.createElement("span");
  detail.className = "upload-detail";
  detail.textContent = formatBytes(file.size);

  const progress = document.createElement("progress");
  progress.max = 100;
  progress.value = 0;

  const message = document.createElement("p");
  message.className = "upload-message";
  message.textContent = initialMessage;

  root.append(name, detail, progress, message);
  return { root, progress, message };
}

function setRowState(row, progress, message, kind = "") {
  row.progress.value = Math.max(0, Math.min(100, Number(progress) || 0));
  row.message.textContent = message;
  row.message.className = `upload-message${kind ? ` ${kind}` : ""}`;
}

async function loadGallery({ reset, quiet = false }) {
  if (state.galleryLoading) {
    return;
  }
  state.galleryLoading = true;
  elements.refreshButton.disabled = true;
  elements.loadMoreButton.disabled = true;

  if (reset) {
    state.nextPageToken = null;
    if (!quiet) {
      elements.galleryStatus.textContent = "Ładowanie galerii…";
    }
  } else {
    elements.galleryStatus.textContent = "Ładowanie kolejnych plików…";
  }

  try {
    const params = new URLSearchParams({ pageSize: "100" });
    if (!reset && state.nextPageToken) {
      params.set("pageToken", state.nextPageToken);
    }

    const response = await fetch(`${API}/files?${params}`, { cache: "no-store" });
    const payload = await parseJson(response);
    if (!response.ok) {
      throw new Error(payload.error || "Nie udało się pobrać galerii.");
    }

    if (reset) {
      elements.gallery.replaceChildren();
    }

    for (const file of payload.files || []) {
      elements.gallery.append(createGalleryCard(file));
    }

    state.nextPageToken = payload.nextPageToken || null;
    elements.loadMoreButton.hidden = !state.nextPageToken;

    const total = elements.gallery.childElementCount;
    if (total === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "Galeria jest jeszcze pusta. Dodaj pierwsze zdjęcie lub film.";
      elements.gallery.append(empty);
      elements.galleryStatus.textContent = "";
    } else {
      elements.galleryStatus.textContent = `Wyświetlono ${total} ${itemWord(total)}.`;
    }
  } catch (error) {
    console.error("Gallery load failed", error);
    elements.galleryStatus.textContent = "Nie udało się załadować galerii. Naciśnij „Odśwież”.";
    if (reset && elements.gallery.childElementCount === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = readableError(error);
      elements.gallery.append(empty);
    }
  } finally {
    state.galleryLoading = false;
    elements.refreshButton.disabled = false;
    elements.loadMoreButton.disabled = false;
  }
}

function createGalleryCard(file) {
  const button = document.createElement("button");
  button.className = "gallery-card";
  button.type = "button";
  button.setAttribute("aria-label", `${file.kind === "video" ? "Odtwórz film" : "Otwórz zdjęcie"}: ${file.name}`);
  button.addEventListener("click", () => openViewer(file));

  if (file.thumbnailLink) {
    const image = document.createElement("img");
    image.src = file.thumbnailLink;
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    let usedProxy = false;
    image.addEventListener("error", () => {
      if (!usedProxy) {
        usedProxy = true;
        image.src = `${API}/thumbnail/${encodeURIComponent(file.id)}`;
      } else {
        image.replaceWith(createPlaceholder(file.kind));
      }
    });
    button.append(image);
  } else {
    button.append(createPlaceholder(file.kind));
  }

  if (file.kind === "video") {
    const badge = document.createElement("span");
    badge.className = "video-badge";
    badge.textContent = "▶";
    badge.setAttribute("aria-hidden", "true");
    button.append(badge);
  }

  return button;
}

function createPlaceholder(kind) {
  const placeholder = document.createElement("span");
  placeholder.className = "gallery-placeholder";
  placeholder.textContent = kind === "video" ? "▶" : "▧";
  placeholder.setAttribute("aria-hidden", "true");
  return placeholder;
}

function openViewer(file) {
  elements.viewerTitle.textContent = file.name;
  elements.viewerContent.replaceChildren();

  const resourceKey = file.resourceKey ? `&resourceKey=${encodeURIComponent(file.resourceKey)}` : "";
  const name = encodeURIComponent(file.name);
  const mediaUrl = `${API}/media/${encodeURIComponent(file.id)}?name=${name}${resourceKey}`;
  const downloadUrl = `${API}/download/${encodeURIComponent(file.id)}?name=${name}${resourceKey}`;
  const driveUrl = file.webViewLink || createDrivePreviewUrl(file);

  elements.viewerDownload.href = downloadUrl;
  elements.viewerDrive.href = driveUrl;
  elements.viewerDrive.hidden = !driveUrl;

  if (file.kind === "image" && !isHeic(file.mimeType)) {
    const image = document.createElement("img");
    image.src = mediaUrl;
    image.alt = file.name;
    image.addEventListener("error", () => showPreviewFallback(file, driveUrl));
    elements.viewerContent.append(image);
  } else if (file.kind === "video") {
    const video = document.createElement("video");
    video.src = mediaUrl;
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.addEventListener("error", () => showDrivePreview(file, driveUrl));
    elements.viewerContent.append(video);
  } else {
    showDrivePreview(file, driveUrl);
  }

  document.body.classList.add("dialog-open");
  elements.viewer.showModal();
}

function showPreviewFallback(file, driveUrl) {
  elements.viewerContent.replaceChildren();
  const note = document.createElement("p");
  note.className = "viewer-note";
  note.textContent = "Przeglądarka nie potrafi wyświetlić tego formatu bezpośrednio. Użyj podglądu Google albo pobierz oryginalny plik.";
  elements.viewerContent.append(note);
  if (driveUrl) {
    window.setTimeout(() => {
      if (elements.viewer.open) {
        showDrivePreview(file, driveUrl);
      }
    }, 400);
  }
}

function showDrivePreview(file, driveUrl) {
  elements.viewerContent.replaceChildren();
  if (!driveUrl) {
    const note = document.createElement("p");
    note.className = "viewer-note";
    note.textContent = "Podgląd nie jest jeszcze dostępny. Oryginalny plik można pobrać przyciskiem poniżej.";
    elements.viewerContent.append(note);
    return;
  }

  const iframe = document.createElement("iframe");
  iframe.src = createDrivePreviewUrl(file) || driveUrl;
  iframe.title = `Podgląd: ${file.name}`;
  iframe.allow = "autoplay; fullscreen";
  iframe.referrerPolicy = "no-referrer";
  elements.viewerContent.append(iframe);
}

function createDrivePreviewUrl(file) {
  if (!file?.id) {
    return "";
  }
  const key = file.resourceKey ? `?resourcekey=${encodeURIComponent(file.resourceKey)}` : "";
  return `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/preview${key}`;
}

function closeViewer() {
  if (!elements.viewer.open) {
    return;
  }
  const media = elements.viewerContent.querySelector("video");
  media?.pause();
  elements.viewer.close();
  elements.viewerContent.replaceChildren();
  document.body.classList.remove("dialog-open");
}

function isHeic(mimeType) {
  return mimeType === "image/heic" || mimeType === "image/heif";
}

async function requestWakeLock() {
  if (!state.uploading || state.wakeLock || !("wakeLock" in navigator)) {
    return;
  }
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => {
      state.wakeLock = null;
    });
  } catch {
    state.wakeLock = null;
  }
}

async function releaseWakeLock() {
  try {
    await state.wakeLock?.release();
  } catch {
    // Brak blokady ekranu nie jest błędem przesyłania.
  }
  state.wakeLock = null;
}

async function parseJson(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

function readableError(error) {
  return error instanceof Error ? error.message : String(error || "Nieznany błąd.");
}

function percentage(value, total) {
  return total > 0 ? Math.min(100, Math.max(0, (value / total) * 100)) : 0;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let unit = 0;
  let amount = value;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

function fileWord(count) {
  if (count === 1) {
    return "plik";
  }
  const lastTwo = count % 100;
  const last = count % 10;
  return last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14) ? "pliki" : "plików";
}

function itemWord(count) {
  return count === 1 ? "element" : "elementów";
}

function sleep(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
