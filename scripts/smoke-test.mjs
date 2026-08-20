import { readFile } from "node:fs/promises";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const TEST_CHUNK_SIZE = 256 * 1024;
const baseUrl = (process.argv[2] || process.env.BASE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const appOrigin = new URL(baseUrl).origin;
const secrets = await loadDevVars(".dev.vars");
let uploadedFileId = null;

try {
  console.log(`Testuję: ${baseUrl}`);

  const health = await fetchJson(`${baseUrl}/api/health`);
  assert(health.response.ok && health.payload.ok, `Health check nie przeszedł: ${JSON.stringify(health.payload)}`);
  console.log(`OK  health — folder: ${health.payload.folderName}`);

  const fileName = `smoke-test-${Date.now()}.png`;
  const pngHeader = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nL8AAAAASUVORK5CYII=",
    "base64",
  );
  // Poprawny nagłówek PNG z neutralnym dopełnieniem. Rozmiar wymusza dwie
  // części uploadu i pozwala sprawdzić odpowiedź 308 oraz nagłówek Range.
  const png = Buffer.alloc(TEST_CHUNK_SIZE + 1024);
  pngHeader.copy(png);

  const init = await fetchJson(`${baseUrl}/api/uploads/init`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: appOrigin,
    },
    body: JSON.stringify({ name: fileName, mimeType: "image/png", size: png.length }),
  });
  assert(init.response.ok && init.payload.uploadUrl, `Nie udało się utworzyć sesji uploadu: ${JSON.stringify(init.payload)}`);
  console.log("OK  inicjalizacja uploadu");

  const preflightResponse = await fetch(init.payload.uploadUrl, {
    method: "OPTIONS",
    headers: {
      Origin: appOrigin,
      "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers": "content-range,content-type",
    },
  });
  const allowedOrigin = preflightResponse.headers.get("access-control-allow-origin");
  assert(
    preflightResponse.ok && (allowedOrigin === appOrigin || allowedOrigin === "*"),
    `Sesja uploadu nie zezwala na CORS dla ${appOrigin} (HTTP ${preflightResponse.status}, Access-Control-Allow-Origin: ${allowedOrigin || "brak"}).`,
  );
  console.log("OK  CORS sesji uploadu");

  const firstChunk = png.subarray(0, TEST_CHUNK_SIZE);
  const firstUploadResponse = await fetch(init.payload.uploadUrl, {
    method: "PUT",
    redirect: "manual",
    headers: {
      Origin: appOrigin,
      "Content-Type": "image/png",
      "Content-Length": String(firstChunk.length),
      "Content-Range": `bytes 0-${firstChunk.length - 1}/${png.length}`,
    },
    body: firstChunk,
  });
  const firstUploadText = await firstUploadResponse.text();
  assert(
    firstUploadResponse.status === 308,
    `Pierwsza część powinna zwrócić HTTP 308, otrzymano ${firstUploadResponse.status}: ${firstUploadText}`,
  );
  const receivedRange = firstUploadResponse.headers.get("range");
  assert(
    receivedRange === `bytes=0-${firstChunk.length - 1}`,
    `Google nie potwierdził zakresu pierwszej części. Range: ${receivedRange || "brak"}.`,
  );
  const chunkAllowedOrigin = firstUploadResponse.headers.get("access-control-allow-origin");
  assert(
    chunkAllowedOrigin === appOrigin || chunkAllowedOrigin === "*",
    `Odpowiedź części uploadu nie zezwala na CORS dla ${appOrigin}.`,
  );
  const exposedHeaders = firstUploadResponse.headers.get("access-control-expose-headers") || "";
  assert(
    exposedHeaders === "*" || exposedHeaders.toLowerCase().split(",").map((value) => value.trim()).includes("range"),
    `Google nie udostępnia nagłówka Range przeglądarce. Access-Control-Expose-Headers: ${exposedHeaders || "brak"}.`,
  );
  console.log("OK  pierwsza część i potwierdzenie Range");

  const finalChunk = png.subarray(TEST_CHUNK_SIZE);
  const uploadResponse = await fetch(init.payload.uploadUrl, {
    method: "PUT",
    redirect: "manual",
    headers: {
      Origin: appOrigin,
      "Content-Type": "image/png",
      "Content-Length": String(finalChunk.length),
      "Content-Range": `bytes ${TEST_CHUNK_SIZE}-${png.length - 1}/${png.length}`,
    },
    body: finalChunk,
  });
  const uploadText = await uploadResponse.text();
  assert(
    uploadResponse.status === 200 || uploadResponse.status === 201,
    `Końcowa część uploadu nie przeszła (HTTP ${uploadResponse.status}): ${uploadText}`,
  );
  const uploaded = JSON.parse(uploadText);
  uploadedFileId = uploaded.id;
  assert(uploadedFileId, "Google nie zwrócił ID pliku.");
  console.log(`OK  upload dwuczęściowy — fileId: ${uploadedFileId}`);

  const listed = await pollForFile(fileName, uploadedFileId);
  assert(listed, "Przesłany plik nie pojawił się w galerii.");
  console.log("OK  lista galerii");

  const nameQuery = encodeURIComponent(fileName);
  const mediaResponse = await fetch(`${baseUrl}/api/media/${uploadedFileId}?name=${nameQuery}`, {
    headers: { Range: "bytes=0-9" },
  });
  assert(mediaResponse.status === 200 || mediaResponse.status === 206, `Podgląd nie działa: HTTP ${mediaResponse.status}`);
  const mediaBytes = new Uint8Array(await mediaResponse.arrayBuffer());
  assert(mediaBytes.length > 0, "Endpoint podglądu zwrócił pustą odpowiedź.");
  console.log("OK  podgląd / streaming");

  const downloadResponse = await fetch(`${baseUrl}/api/download/${uploadedFileId}?name=${nameQuery}`, {
    headers: { Range: "bytes=0-9" },
  });
  assert(downloadResponse.status === 200 || downloadResponse.status === 206, `Pobieranie nie działa: HTTP ${downloadResponse.status}`);
  assert(downloadResponse.headers.get("content-disposition")?.startsWith("attachment"), "Brakuje nagłówka attachment.");
  console.log("OK  pobieranie");

  console.log("\nWszystkie automatyczne testy smoke zakończyły się powodzeniem.\n");
} catch (error) {
  console.error(`\nTEST NIEUDANY: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (uploadedFileId) {
    try {
      const accessToken = await getAccessToken(secrets);
      const cleanup = await fetch(`${DRIVE_API}/files/${encodeURIComponent(uploadedFileId)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (cleanup.ok || cleanup.status === 404) {
        console.log("OK  usunięto plik testowy");
      } else {
        console.warn(`UWAGA: nie udało się usunąć pliku testowego (HTTP ${cleanup.status}). Usuń go ręcznie z Dysku.`);
      }
    } catch (error) {
      console.warn(`UWAGA: nie udało się usunąć pliku testowego: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function pollForFile(fileName, fileId) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = await fetchJson(`${baseUrl}/api/files?pageSize=100`);
    if (result.response.ok && result.payload.files?.some((file) => file.id === fileId || file.name === fileName)) {
      return true;
    }
    await sleep(Math.min(1000 + attempt * 500, 5000));
  }
  return false;
}

async function getAccessToken(env) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: required(env, "GOOGLE_CLIENT_ID"),
      client_secret: required(env, "GOOGLE_CLIENT_SECRET"),
      refresh_token: required(env, "GOOGLE_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    }),
  });
  const payload = await response.json();
  assert(response.ok && payload.access_token, `Nie udało się pobrać tokenu do sprzątania: ${JSON.stringify(payload)}`);
  return payload.access_token;
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  return { response, payload };
}

async function loadDevVars(path) {
  const content = await readFile(path, "utf8");
  const result = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    result[key] = value;
  }
  return result;
}

function required(object, key) {
  const value = object[key];
  assert(value, `Brakuje ${key} w .dev.vars.`);
  return value;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
