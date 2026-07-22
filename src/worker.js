const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;
const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;

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

  const endpoint = new URL(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`);
  endpoint.searchParams.set("alt", "media");
  if (url.searchParams.get("resourceKey")) {
    endpoint.searchParams.set("resourceKey", url.searchParams.get("resourceKey"));
  }

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

  const response = await googleFetch(env, endpoint, {
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
