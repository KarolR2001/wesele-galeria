const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;
const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 45;
const MAX_ARCHIVE_BYTES = 15_000_000_000;
const ZIP32_MAX = 0xffffffff;
const ZIP32_VERSION = 20;
const ZIP64_VERSION = 45;
const ZIP_FLAG = 0x0808;
const CRC32_TABLE = createCrc32Table();

let tokenCache = {
  accessToken: null,
  expiresAt: 0,
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }

    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        return handleHealth(env);
      }

      if (request.method === "GET" && url.pathname === "/api/files") {
        return handleListFiles(url, env);
      }

      if (request.method === "POST" && url.pathname === "/api/uploads/init") {
        return handleInitUpload(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/download-archive") {
        return handleDownloadArchive(request, env);
      }

      const thumbnailMatch = url.pathname.match(/^\/api\/thumbnail\/([A-Za-z0-9_-]+)$/);
      if (request.method === "GET" && thumbnailMatch) {
        return handleThumbnail(thumbnailMatch[1], env);
      }

      const mediaMatch = url.pathname.match(/^\/api\/media\/([A-Za-z0-9_-]+)$/);
      if ((request.method === "GET" || request.method === "HEAD") && mediaMatch) {
        return handleMedia(request, url, mediaMatch[1], env, false);
      }

      const downloadMatch = url.pathname.match(/^\/api\/download\/([A-Za-z0-9_-]+)$/);
      if ((request.method === "GET" || request.method === "HEAD") && downloadMatch) {
        return handleMedia(request, url, downloadMatch[1], env, true);
      }

      return json({ error: "Nie znaleziono endpointu." }, 404);
    } catch (error) {
      console.error("Unhandled worker error", error);
      return json(
        {
          error: "Wewnętrzny błąd aplikacji.",
          detail: error instanceof Error ? error.message : String(error),
        },
        500,
      );
    }
  },
};

async function handleHealth(env) {
  assertEnv(env);

  const endpoint = new URL(`${DRIVE_API}/files/${encodeURIComponent(env.GOOGLE_FOLDER_ID)}`);
  endpoint.searchParams.set("fields", "id,name,mimeType,trashed");

  const response = await googleFetch(env, endpoint, { method: "GET" });
  if (!response.ok) {
    return googleError(response, "Nie udało się uzyskać dostępu do folderu Google Drive.");
  }

  const folder = await response.json();
  const validFolder =
    folder.mimeType === "application/vnd.google-apps.folder" && folder.trashed !== true;

  return json({
    ok: validFolder,
    folderId: folder.id,
    folderName: folder.name,
  }, validFolder ? 200 : 500);
}

async function handleListFiles(url, env) {
  assertEnv(env);

  const requestedPageSize = Number.parseInt(url.searchParams.get("pageSize") || "", 10);
  const pageSize = Number.isFinite(requestedPageSize)
    ? Math.min(Math.max(requestedPageSize, 1), MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;
  const pageToken = url.searchParams.get("pageToken") || "";

  const endpoint = new URL(`${DRIVE_API}/files`);
  endpoint.searchParams.set(
    "q",
    `'${env.GOOGLE_FOLDER_ID}' in parents and trashed = false`,
  );
  endpoint.searchParams.set("spaces", "drive");
  endpoint.searchParams.set("pageSize", String(pageSize));
  endpoint.searchParams.set("orderBy", "createdTime desc");
  endpoint.searchParams.set(
    "fields",
    "nextPageToken,files(id,name,mimeType,size,createdTime,thumbnailLink,webViewLink,webContentLink,resourceKey)",
  );
  if (pageToken) {
    endpoint.searchParams.set("pageToken", pageToken);
  }

  const response = await googleFetch(env, endpoint, { method: "GET" });
  if (!response.ok) {
    return googleError(response, "Nie udało się pobrać galerii z Google Drive.");
  }

  const payload = await response.json();
  const files = (payload.files || [])
    .filter((file) => isAllowedMimeType(file.mimeType))
    .map((file) => ({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      size: Number(file.size || 0),
      createdTime: file.createdTime,
      kind: file.mimeType.startsWith("video/") ? "video" : "image",
      thumbnailLink: file.thumbnailLink || null,
      webViewLink: file.webViewLink || null,
      webContentLink: file.webContentLink || null,
      resourceKey: file.resourceKey || null,
    }));

  return json({
    files,
    nextPageToken: payload.nextPageToken || null,
  });
}

async function handleInitUpload(request, env) {
  assertEnv(env);

  let input;
  try {
    input = await request.json();
  } catch {
    return json({ error: "Nieprawidłowe dane żądania." }, 400);
  }

  const name = normalizeFileName(input?.name);
  const mimeType = typeof input?.mimeType === "string" ? input.mimeType.trim() : "";
  const size = Number(input?.size);

  if (!name) {
    return json({ error: "Brakuje poprawnej nazwy pliku." }, 400);
  }
  if (!isAllowedMimeType(mimeType)) {
    return json({ error: "Dozwolone są wyłącznie zdjęcia i filmy." }, 400);
  }
  if (!Number.isSafeInteger(size) || size <= 0) {
    return json({ error: "Nieprawidłowy rozmiar pliku." }, 400);
  }

  const endpoint = new URL(`${DRIVE_UPLOAD_API}/files`);
  endpoint.searchParams.set("uploadType", "resumable");
  endpoint.searchParams.set(
    "fields",
    "id,name,mimeType,size,createdTime,thumbnailLink,webViewLink,webContentLink,resourceKey",
  );

  const metadata = {
    name,
    mimeType,
    parents: [env.GOOGLE_FOLDER_ID],
    appProperties: {
      source: "wesele-galeria",
    },
  };

  // Google przypisuje CORS sesji resumable do Origin użytego przy jej
  // inicjalizacji. Musi to być dokładnie origin strony, która wykona PUT.
  const uploadOrigin = new URL(request.url).origin;

  const response = await googleFetch(env, endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": mimeType,
      "X-Upload-Content-Length": String(size),
      Origin: uploadOrigin,
    },
    body: JSON.stringify(metadata),
  });

  if (!response.ok) {
    return googleError(response, "Nie udało się rozpocząć przesyłania pliku.");
  }

  const uploadUrl = response.headers.get("Location");
  if (!uploadUrl) {
    return json({ error: "Google nie zwrócił adresu sesji przesyłania." }, 502);
  }

  return json({
    uploadUrl,
    chunkSize: UPLOAD_CHUNK_SIZE,
  });
}

async function handleDownloadArchive(request, env) {
  assertEnv(env);

  let input;
  try {
    input = await readArchiveRequest(request);
  } catch {
    return json({ error: "Nieprawidłowe dane archiwum." }, 400);
  }

  let files;
  try {
    files = normalizeArchiveFiles(input?.files);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Nieprawidłowe pliki archiwum." }, 400);
  }

  return createArchiveResponse(files, env);
}

async function readArchiveRequest(request) {
  const contentType = request.headers.get("Content-Type") || "";
  if (contentType.includes("application/json")) {
    return request.json();
  }

  const formData = await request.formData();
  const rawFiles = formData.get("files");
  if (typeof rawFiles !== "string") {
    throw new Error("Brakuje listy plików.");
  }
  return { files: JSON.parse(rawFiles) };
}

function normalizeArchiveFiles(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("Nie zaznaczono żadnych plików.");
  }
  if (input.length > MAX_ARCHIVE_FILES) {
    throw new Error(`Można pobrać maksymalnie ${MAX_ARCHIVE_FILES} plików naraz.`);
  }

  const usedNames = new Set();
  let declaredBytes = 0;
  const files = input.map((value, index) => {
    const id = typeof value?.id === "string" ? value.id.trim() : "";
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new Error("Lista zawiera nieprawidłowy identyfikator pliku.");
    }

    const requestedName = normalizeFileName(value?.name) || `plik-${index + 1}`;
    const size = Number(value?.size || 0);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error("Lista zawiera nieprawidłowy rozmiar pliku.");
    }
    declaredBytes += size;
    if (declaredBytes > MAX_ARCHIVE_BYTES) {
      throw new Error("Wybrane pliki przekraczają maksymalny rozmiar archiwum.");
    }

    return {
      id,
      name: uniqueArchiveName(requestedName, usedNames),
      declaredSize: size,
      resourceKey: typeof value?.resourceKey === "string" ? value.resourceKey.slice(0, 512) : "",
    };
  });

  return files;
}

function uniqueArchiveName(name, usedNames) {
  const extensionIndex = name.lastIndexOf(".");
  const base = extensionIndex > 0 ? name.slice(0, extensionIndex) : name;
  const extension = extensionIndex > 0 ? name.slice(extensionIndex) : "";
  let candidate = name;
  let suffix = 2;

  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${base} (${suffix})${extension}`;
    suffix += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function createArchiveResponse(files, env) {
  const textEncoder = new TextEncoder();
  const zip64 = shouldUseZip64(files, textEncoder);
  const archiveLength = zip64 ? null : getZip32Length(files, textEncoder);
  const fixedLength = !zip64 && typeof globalThis.FixedLengthStream === "function"
    ? new globalThis.FixedLengthStream(archiveLength)
    : null;
  const output = fixedLength || new TransformStream();
  const writer = output.writable.getWriter();

  void (async () => {
    try {
      await writeZip(files, env, writer, zip64);
      await writer.close();
    } catch (error) {
      console.error("Archive download failed", error);
      await writer.abort(error).catch(() => {});
    }
  })();

  const headers = new Headers({
    "Content-Type": "application/zip",
    "Cache-Control": "private, no-store",
    "Content-Disposition": createContentDisposition("attachment", "wspolne-wspomnienia.zip"),
    "X-Content-Type-Options": "nosniff",
  });
  if (fixedLength) {
    headers.set("Content-Length", String(archiveLength));
  }

  return new Response(output.readable, { status: 200, headers });
}

async function writeZip(files, env, writer, zip64) {
  const entries = [];
  const dateTime = getZipDateTime(new Date());
  const textEncoder = new TextEncoder();
  let archiveOffset = 0;
  let totalBytes = 0;

  for (const file of files) {
    const nameBytes = textEncoder.encode(file.name);
    const localOffset = archiveOffset;
    const localHeader = createZipLocalHeader(nameBytes, dateTime, file.declaredSize, zip64);
    await writer.write(localHeader);
    archiveOffset += localHeader.byteLength;

    const response = await fetchDriveFile(file, env);
    if (!response.ok || !response.body) {
      throw new Error(`Nie udało się pobrać pliku ${file.name}.`);
    }

    const reader = response.body.getReader();
    let crc = 0xffffffff;
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        crc = updateCrc32(crc, value);
        size += value.byteLength;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_ARCHIVE_BYTES) {
          throw new Error("Wybrane pliki przekraczają maksymalny rozmiar archiwum.");
        }
        if (!zip64 && (size > ZIP32_MAX - value.byteLength || archiveOffset > ZIP32_MAX - value.byteLength)) {
          throw new Error("Archiwum przekracza rozmiar obsługiwany przez klasyczny format ZIP.");
        }
        await writer.write(value);
        archiveOffset += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }

    if (!zip64 && size !== file.declaredSize) {
      throw new Error(`Rozmiar pliku ${file.name} zmienił się podczas pobierania.`);
    }

    const checksum = (crc ^ 0xffffffff) >>> 0;
    const descriptor = createZipDataDescriptor(checksum, size, zip64);
    await writer.write(descriptor);
    archiveOffset += descriptor.byteLength;
    entries.push({ nameBytes, checksum, size, localOffset, dateTime });
  }

  const centralDirectoryOffset = archiveOffset;
  for (const entry of entries) {
    const centralHeader = createZipCentralHeader(entry, zip64);
    await writer.write(centralHeader);
    archiveOffset += centralHeader.byteLength;
  }

  const centralDirectorySize = archiveOffset - centralDirectoryOffset;
  if (zip64) {
    const zip64EndOffset = archiveOffset;
    const zip64EndRecord = createZip64EndRecord(
      entries.length,
      centralDirectorySize,
      centralDirectoryOffset,
    );
    await writer.write(zip64EndRecord);
    archiveOffset += zip64EndRecord.byteLength;

    const zip64Locator = createZip64EndLocator(zip64EndOffset);
    await writer.write(zip64Locator);
    archiveOffset += zip64Locator.byteLength;
    await writer.write(createZipEndRecord(entries.length, centralDirectorySize, centralDirectoryOffset, true));
  } else {
    await writer.write(createZipEndRecord(entries.length, centralDirectorySize, centralDirectoryOffset, false));
  }
}

function shouldUseZip64(files, textEncoder) {
  let dataSize = 0;
  let centralDirectorySize = 0;

  for (const file of files) {
    const nameSize = textEncoder.encode(file.name).byteLength;
    if (file.declaredSize >= ZIP32_MAX || files.length >= 0xffff) {
      return true;
    }

    dataSize += 30 + nameSize + 16 + file.declaredSize;
    centralDirectorySize += 46 + nameSize;
  }

  // ZIP32 stores the end of the central directory in 32-bit offsets. Keep
  // the archive in ZIP64 when headers plus payload would reach the sentinel
  // value, even if the declared file data alone is below 4 GiB.
  return dataSize + centralDirectorySize + 22 >= ZIP32_MAX;
}

function getZip32Length(files, textEncoder) {
  let length = 22;
  for (const file of files) {
    const nameSize = textEncoder.encode(file.name).byteLength;
    length += 30 + nameSize + file.declaredSize + 16;
    length += 46 + nameSize;
  }
  return length;
}

async function fetchDriveFile(file, env, init = {}) {
  const endpoint = new URL(`${DRIVE_API}/files/${encodeURIComponent(file.id)}`);
  endpoint.searchParams.set("alt", "media");
  if (file.resourceKey) {
    endpoint.searchParams.set("resourceKey", file.resourceKey);
  }
  return googleFetch(env, endpoint, init);
}

async function handleThumbnail(fileId, env) {
  assertEnv(env);

  const metadataUrl = new URL(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`);
  metadataUrl.searchParams.set("fields", "thumbnailLink");

  const metadataResponse = await googleFetch(env, metadataUrl, { method: "GET" });
  if (!metadataResponse.ok) {
    return new Response("Miniatura jest niedostępna.", { status: 404 });
  }

  const metadata = await metadataResponse.json();
  if (!metadata.thumbnailLink) {
    return new Response("Miniatura nie została jeszcze utworzona.", { status: 404 });
  }

  const token = await getAccessToken(env);
  const thumbnailResponse = await fetch(metadata.thumbnailLink, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!thumbnailResponse.ok) {
    return new Response("Miniatura jest niedostępna.", { status: 404 });
  }

  const headers = copyHeaders(thumbnailResponse.headers, [
    "content-type",
    "content-length",
    "etag",
    "last-modified",
  ]);
  headers.set("Cache-Control", "public, max-age=3600");

  return new Response(thumbnailResponse.body, {
    status: thumbnailResponse.status,
    headers,
  });
}

async function handleMedia(request, url, fileId, env, forceDownload) {
  assertEnv(env);

  const upstreamHeaders = new Headers();
  const range = request.headers.get("Range");
  if (range) {
    upstreamHeaders.set("Range", range);
  }

  let upstreamMethod = request.method;
  if (request.method === "HEAD") {
    upstreamMethod = "GET";
    upstreamHeaders.set("Range", "bytes=0-0");
  }

  const response = await fetchDriveFile({
    id: fileId,
    resourceKey: url.searchParams.get("resourceKey") || "",
  }, env, {
    method: upstreamMethod,
    headers: upstreamHeaders,
  });

  if (!response.ok && response.status !== 206) {
    const status = response.status === 404 ? 404 : 502;
    return new Response("Plik jest chwilowo niedostępny.", { status });
  }

  const headers = copyHeaders(response.headers, [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
  ]);

  const requestedName = normalizeFileName(url.searchParams.get("name")) || "plik";
  headers.set(
    "Content-Disposition",
    createContentDisposition(forceDownload ? "attachment" : "inline", requestedName),
  );
  headers.set("Cache-Control", forceDownload ? "private, no-store" : "public, max-age=3600");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Accept-Ranges", "bytes");

  if (request.method === "HEAD") {
    const contentRange = response.headers.get("Content-Range");
    const total = contentRange?.match(/\/(\d+)$/)?.[1];
    if (total) {
      headers.set("Content-Length", total);
    } else {
      headers.delete("Content-Length");
    }
    response.body?.cancel();
    return new Response(null, { status: 200, headers });
  }

  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

async function googleFetch(env, input, init = {}, attempt = 0) {
  const token = await getAccessToken(env);
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(input, {
    ...init,
    headers,
  });

  if (response.status === 401 && attempt === 0) {
    tokenCache = { accessToken: null, expiresAt: 0 };
    return googleFetch(env, input, init, attempt + 1);
  }

  if (isRetryableStatus(response.status) && attempt < 3) {
    response.body?.cancel();
    const retryAfter = parseRetryAfter(response.headers.get("Retry-After"));
    const delay = retryAfter ?? Math.min(500 * (2 ** attempt) + Math.floor(Math.random() * 300), 5000);
    await sleep(delay);
    return googleFetch(env, input, init, attempt + 1);
  }

  return response;
}

async function getAccessToken(env) {
  assertEnv(env);

  if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt) {
    return tokenCache.accessToken;
  }

  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: env.GOOGLE_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Nie udało się odświeżyć tokenu Google OAuth: ${detail}`);
  }

  const payload = await response.json();
  tokenCache = {
    accessToken: payload.access_token,
    expiresAt: Date.now() + Math.max(Number(payload.expires_in || 3600) - 120, 60) * 1000,
  };

  return tokenCache.accessToken;
}

async function googleError(response, fallbackMessage) {
  let detail = "";
  try {
    detail = await response.text();
  } catch {
    detail = "";
  }

  console.error("Google API error", response.status, detail);
  return json(
    {
      error: fallbackMessage,
      googleStatus: response.status,
      detail: detail.slice(0, 1000),
    },
    response.status >= 400 && response.status < 500 ? response.status : 502,
  );
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function parseRetryAfter(value) {
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 10_000);
  }
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.max(0, Math.min(date - Date.now(), 10_000));
  }
  return null;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertEnv(env) {
  const required = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REFRESH_TOKEN",
    "GOOGLE_FOLDER_ID",
  ];
  const missing = required.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Brak wymaganych zmiennych środowiskowych: ${missing.join(", ")}`);
  }
}

function isAllowedMimeType(mimeType) {
  return typeof mimeType === "string" &&
    (mimeType.startsWith("image/") || mimeType.startsWith("video/"));
}

function normalizeFileName(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[\\/]/g, "_")
    .trim()
    .slice(0, 240);
}

function createContentDisposition(disposition, fileName) {
  const asciiName = fileName
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encoded}`;
}

function createCrc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function updateCrc32(crc, bytes) {
  let value = crc;
  for (const byte of bytes) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return value >>> 0;
}

function getZipDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function setUint64LE(view, offset, value) {
  view.setBigUint64(offset, BigInt(Math.trunc(value)), true);
}

function createZip64Extra(values) {
  const extra = new Uint8Array(4 + values.length * 8);
  const view = new DataView(extra.buffer);
  view.setUint16(0, 0x0001, true);
  view.setUint16(2, values.length * 8, true);
  values.forEach((value, index) => setUint64LE(view, 4 + index * 8, value));
  return extra;
}

function createZipLocalHeader(nameBytes, dateTime, declaredSize, zip64) {
  const extra = zip64 ? createZip64Extra([declaredSize, declaredSize]) : new Uint8Array(0);
  const header = new Uint8Array(30 + nameBytes.length + extra.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, zip64 ? ZIP64_VERSION : ZIP32_VERSION, true);
  view.setUint16(6, ZIP_FLAG, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, dateTime.time, true);
  view.setUint16(12, dateTime.date, true);
  view.setUint32(14, 0, true);
  view.setUint32(18, zip64 ? ZIP32_MAX : 0, true);
  view.setUint32(22, zip64 ? ZIP32_MAX : 0, true);
  view.setUint16(26, nameBytes.length, true);
  view.setUint16(28, extra.length, true);
  header.set(nameBytes, 30);
  header.set(extra, 30 + nameBytes.length);
  return header;
}

function createZipDataDescriptor(checksum, size, zip64) {
  const descriptor = new Uint8Array(zip64 ? 24 : 16);
  const view = new DataView(descriptor.buffer);
  view.setUint32(0, 0x08074b50, true);
  view.setUint32(4, checksum, true);
  if (zip64) {
    setUint64LE(view, 8, size);
    setUint64LE(view, 16, size);
  } else {
    view.setUint32(8, size, true);
    view.setUint32(12, size, true);
  }
  return descriptor;
}

function createZipCentralHeader(entry, zip64) {
  const extra = zip64
    ? createZip64Extra([entry.size, entry.size, entry.localOffset])
    : new Uint8Array(0);
  const header = new Uint8Array(46 + entry.nameBytes.length + extra.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, zip64 ? ZIP64_VERSION : ZIP32_VERSION, true);
  view.setUint16(6, zip64 ? ZIP64_VERSION : ZIP32_VERSION, true);
  view.setUint16(8, ZIP_FLAG, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, entry.dateTime.time, true);
  view.setUint16(14, entry.dateTime.date, true);
  view.setUint32(16, entry.checksum, true);
  view.setUint32(20, zip64 ? ZIP32_MAX : entry.size, true);
  view.setUint32(24, zip64 ? ZIP32_MAX : entry.size, true);
  view.setUint16(28, entry.nameBytes.length, true);
  view.setUint16(30, extra.length, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, zip64 ? ZIP32_MAX : entry.localOffset, true);
  header.set(entry.nameBytes, 46);
  header.set(extra, 46 + entry.nameBytes.length);
  return header;
}

function createZip64EndRecord(entryCount, centralDirectorySize, centralDirectoryOffset) {
  const record = new Uint8Array(56);
  const view = new DataView(record.buffer);
  view.setUint32(0, 0x06064b50, true);
  setUint64LE(view, 4, 44);
  view.setUint16(12, ZIP64_VERSION, true);
  view.setUint16(14, ZIP64_VERSION, true);
  view.setUint32(16, 0, true);
  view.setUint32(20, 0, true);
  setUint64LE(view, 24, entryCount);
  setUint64LE(view, 32, entryCount);
  setUint64LE(view, 40, centralDirectorySize);
  setUint64LE(view, 48, centralDirectoryOffset);
  return record;
}

function createZip64EndLocator(zip64EndOffset) {
  const locator = new Uint8Array(20);
  const view = new DataView(locator.buffer);
  view.setUint32(0, 0x07064b50, true);
  view.setUint32(4, 0, true);
  setUint64LE(view, 8, zip64EndOffset);
  view.setUint32(16, 1, true);
  return locator;
}

function createZipEndRecord(entryCount, centralDirectorySize, centralDirectoryOffset, zip64) {
  const record = new Uint8Array(22);
  const view = new DataView(record.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, zip64 ? 0xffff : entryCount, true);
  view.setUint16(10, zip64 ? 0xffff : entryCount, true);
  view.setUint32(12, zip64 ? ZIP32_MAX : centralDirectorySize, true);
  view.setUint32(16, zip64 ? ZIP32_MAX : centralDirectoryOffset, true);
  view.setUint16(20, 0, true);
  return record;
}

function copyHeaders(source, names) {
  const output = new Headers();
  for (const name of names) {
    const value = source.get(name);
    if (value) {
      output.set(name, value);
    }
  }
  return output;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
