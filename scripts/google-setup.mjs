import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const HOST = "127.0.0.1";

const rl = createInterface({ input, output });
let listener = null;

try {
  console.log("\nKonfiguracja połączenia z Google Drive\n");
  console.log("W Google Auth Platform utwórz klienta OAuth typu „Aplikacja komputerowa”.");
  console.log("Nie dodawaj ręcznie adresu przekierowania — skrypt użyje lokalnego adresu loopback.\n");

  const clientId = (await rl.question("Google OAuth Client ID: ")).trim();
  const clientSecret = (await rl.question("Google OAuth Client Secret: ")).trim();
  const folderAnswer = (await rl.question("Nazwa nowego folderu [Galeria weselna]: ")).trim();
  const folderName = folderAnswer || "Galeria weselna";

  if (!clientId || !clientSecret) {
    throw new Error("Client ID i Client Secret są wymagane.");
  }

  const state = randomBytes(24).toString("hex");
  const codeVerifier = randomBytes(64).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  listener = await createAuthorizationListener(state);

  const authorizationUrl = new URL(AUTH_URL);
  authorizationUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: listener.redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  }).toString();

  console.log("Otwieram stronę autoryzacji Google w przeglądarce…");
  console.log(`Gdyby nie otworzyła się automatycznie, skopiuj ten adres:\n${authorizationUrl}\n`);
  openBrowser(authorizationUrl.toString());

  const code = await listener.codePromise;
  console.log("Autoryzacja odebrana. Pobieram token…");
  const tokens = await exchangeCode({
    code,
    clientId,
    clientSecret,
    codeVerifier,
    redirectUri: listener.redirectUri,
  });

  if (!tokens.refresh_token) {
    throw new Error(
      "Google nie zwrócił refresh tokenu. Cofnij dostęp aplikacji na stronie konta Google i uruchom skrypt ponownie.",
    );
  }

  console.log(`Tworzę folder „${folderName}”…`);
  const folder = await createFolder(tokens.access_token, folderName);
  console.log("Ustawiam folder jako: każda osoba z linkiem — tylko odczyt…");
  await makeFolderPublicReadOnly(tokens.access_token, folder.id);

  const devVars = [
    dotenvLine("GOOGLE_CLIENT_ID", clientId),
    dotenvLine("GOOGLE_CLIENT_SECRET", clientSecret),
    dotenvLine("GOOGLE_REFRESH_TOKEN", tokens.refresh_token),
    dotenvLine("GOOGLE_FOLDER_ID", folder.id),
    "",
  ].join("\n");

  await writeFile(".dev.vars", devVars, { encoding: "utf8", mode: 0o600 });

  console.log("\nGotowe.");
  console.log(`Folder ID: ${folder.id}`);
  console.log(`Folder: ${folder.webViewLink || `https://drive.google.com/drive/folders/${folder.id}`}`);
  console.log("Sekrety zapisano lokalnie w .dev.vars (plik jest ignorowany przez Git).\n");
  console.log("Następne polecenia:");
  console.log("  npm run dev");
  console.log("  npm run smoke -- http://127.0.0.1:8787");
  console.log("  npx wrangler login");
  console.log("  npm run deploy\n");
} catch (error) {
  console.error(`\nBłąd: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  listener?.close();
  rl.close();
}

async function createAuthorizationListener(expectedState) {
  let settled = false;
  let timeout = null;
  let resolveCode;
  let rejectCode;

  const codePromise = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((request, response) => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const baseUrl = `http://${HOST}:${port}`;
    const url = new URL(request.url || "/", baseUrl);

    if (url.pathname !== "/") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Nie znaleziono strony.");
      return;
    }

    const returnedState = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const oauthError = url.searchParams.get("error");

    if (returnedState !== expectedState) {
      finish(400, "Nieprawidłowy parametr state. Zamknij kartę i uruchom konfigurację ponownie.");
      rejectOnce(new Error("Google zwrócił nieprawidłowy parametr state."));
      return;
    }

    if (oauthError) {
      finish(400, `Autoryzacja została przerwana: ${oauthError}`);
      rejectOnce(new Error(`Autoryzacja Google nie powiodła się: ${oauthError}`));
      return;
    }

    if (!code) {
      finish(400, "Google nie zwrócił kodu autoryzacyjnego.");
      rejectOnce(new Error("Brak kodu autoryzacyjnego."));
      return;
    }

    finish(200, "Autoryzacja zakończona. Możesz zamknąć tę kartę i wrócić do terminala.");
    resolveOnce(code);

    function finish(status, message) {
      response.writeHead(status, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(`<!doctype html><meta charset="utf-8"><title>Galeria weselna</title><style>body{font-family:system-ui;max-width:42rem;margin:10vh auto;padding:2rem;line-height:1.6}</style><h1>${escapeHtml(message)}</h1>`);
    }
  });

  server.on("error", (error) => {
    rejectOnce(new Error(`Nie udało się uruchomić lokalnego callbacku OAuth: ${error.message}`));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, resolve);
  });

  const address = server.address();
  if (!address || typeof address !== "object") {
    server.close();
    throw new Error("Nie udało się ustalić portu lokalnego callbacku OAuth.");
  }

  const redirectUri = `http://${HOST}:${address.port}`;
  timeout = setTimeout(() => {
    rejectOnce(new Error("Upłynął czas oczekiwania na autoryzację Google."));
  }, 10 * 60 * 1000);

  return {
    redirectUri,
    codePromise,
    close,
  };

  function resolveOnce(code) {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timeout);
    resolveCode(code);
    server.close();
  }

  function rejectOnce(error) {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timeout);
    rejectCode(error);
    server.close();
  }

  function close() {
    clearTimeout(timeout);
    if (server.listening) {
      server.close();
    }
  }
}

async function exchangeCode({ code, clientId, clientSecret, codeVerifier, redirectUri }) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(`Wymiana kodu OAuth nie powiodła się (HTTP ${response.status}): ${payload.error_description || payload.error || JSON.stringify(payload)}`);
  }
  return payload;
}

async function createFolder(accessToken, name) {
  const url = new URL(`${DRIVE_API}/files`);
  url.searchParams.set("fields", "id,name,webViewLink");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
      appProperties: { source: "wesele-galeria" },
    }),
  });

  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(`Nie udało się utworzyć folderu (HTTP ${response.status}): ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function makeFolderPublicReadOnly(accessToken, folderId) {
  const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(folderId)}/permissions`);
  url.searchParams.set("fields", "id,type,role");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      type: "anyone",
      role: "reader",
      allowFileDiscovery: false,
    }),
  });

  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(`Nie udało się ustawić publicznego odczytu folderu (HTTP ${response.status}): ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function readJson(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function dotenvLine(key, value) {
  const escaped = String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  return `${key}="${escaped}"`;
}

function openBrowser(url) {
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(command, args, { windowsHide: true }, () => {});
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
