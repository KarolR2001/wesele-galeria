# Galeria dla gości

Lekka, współdzielona galeria zdjęć i filmów przeznaczona dla gości wydarzeń. Uczestnicy mogą bez zakładania konta dodawać materiały, przeglądać całą galerię i pobierać pojedyncze oryginalne pliki.

Aplikacja jest przygotowana przede wszystkim z myślą o telefonach, ale ma również responsywny układ dla tabletów i komputerów. Nie wymaga frameworka frontendowego ani osobnej bazy danych.

## Funkcje

- wspólna galeria dostępna z jednego linku lub kodu QR,
- wysyłanie wielu zdjęć i filmów w kolejce,
- wznawialny upload do Google Drive w częściach po 8 MiB,
- ponawianie błędów przejściowych oraz obsługa chwilowej utraty połączenia,
- galeria ładowana stronami bez ograniczenia do pierwszych 100 elementów,
- leniwe ładowanie miniaturek i fallback przez Workera,
- podgląd zdjęć i natywne odtwarzanie filmów,
- fallback Google Drive dla formatów nieobsługiwanych przez przeglądarkę,
- viewer z nawigacją klawiaturą, przyciskiem Escape i obsługą ekranów dotykowych,
- pobieranie każdego oryginalnego pliku osobno,
- responsywny layout desktopowy bez zmiany mobilnego interfejsu,
- obsługa safe-area, `prefers-reduced-motion` i zoomu przeglądarki.

Aplikacja nie ma trybu zaznaczania wielu plików i nie tworzy archiwów ZIP. Pobieranie odbywa się pojedynczo z poziomu viewera.

## Architektura

- **Frontend:** Vanilla HTML, CSS i JavaScript ES Modules.
- **Backend:** Cloudflare Workers.
- **Magazyn plików:** Google Drive API.
- **Hosting assetów:** Cloudflare Workers Assets.
- **Konfiguracja lokalna:** plik `.dev.vars`, ignorowany przez Git.

### Struktura projektu

```text
public/                 statyczny frontend
  index.html            struktura strony
  styles.css            style mobile-first i desktop responsive
  app.js                upload, galeria i viewer
src/worker.js           endpointy API i integracja z Google Drive
scripts/google-setup.mjs
                         jednorazowa konfiguracja OAuth i folderu Drive
scripts/smoke-test.mjs  test health, uploadu, streamingu i pobierania
wrangler.jsonc          konfiguracja Cloudflare Worker
```

## Wymagania

- Node.js 20 lub nowszy,
- konto Google z dostępem do Google Drive,
- konto Cloudflare z dostępem do Workers,
- klient OAuth Google typu „Aplikacja komputerowa”.

## Uruchomienie lokalne

Zainstaluj zależności:

```bash
npm install
```

Przy pierwszej konfiguracji uruchom kreator Google Drive:

```bash
npm run setup:google
```

Skrypt przeprowadzi przez autoryzację OAuth, utworzy folder galerii, nada mu dostęp do odczytu dla osób mających link i zapisze lokalne zmienne w `.dev.vars`.

Uruchom serwer deweloperski:

```bash
npm run dev
```

Domyślny adres lokalny:

```text
http://127.0.0.1:8787
```

## Testy

Smoke test wymaga działającego serwera oraz `.dev.vars`. Wykonuje kontrolny upload, sprawdza CORS, wznowienie uploadu, listowanie galerii, streaming i pojedyncze pobieranie, a następnie usuwa plik testowy z Google Drive.

```bash
npm run smoke -- http://127.0.0.1:8787
```

Do szybkiej kontroli składni plików JavaScript można użyć:

```bash
node --check public/app.js
node --check src/worker.js
node --check scripts/smoke-test.mjs
```

## Konfiguracja sekretów

Worker korzysta z następujących zmiennych:

| Zmienna | Przeznaczenie |
| --- | --- |
| `GOOGLE_CLIENT_ID` | identyfikator klienta OAuth |
| `GOOGLE_CLIENT_SECRET` | sekret klienta OAuth |
| `GOOGLE_REFRESH_TOKEN` | token odświeżania dostępu do Google Drive |
| `GOOGLE_FOLDER_ID` | folder przechowujący pliki galerii |

Pliku `.dev.vars` nie należy dodawać do repozytorium ani udostępniać publicznie.

## Wdrożenie

Zaloguj Wrangler do Cloudflare:

```bash
npx wrangler login
```

Przed pierwszym wdrożeniem ustaw sekrety bezpośrednio w Cloudflare:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN
npx wrangler secret put GOOGLE_FOLDER_ID
```

Następnie wdroż Workera i assety:

```bash
npx wrangler deploy
```

Po wdrożeniu sprawdź działanie endpointu:

```text
https://<nazwa-workera>.workers.dev/api/health
```

W odpowiedzi powinno pojawić się `"ok": true` oraz nazwa skonfigurowanego folderu Google Drive.

## Endpointy API

| Metoda | Endpoint | Działanie |
| --- | --- | --- |
| `GET` | `/api/health` | sprawdza dostęp do folderu Google Drive |
| `GET` | `/api/files` | zwraca stronę plików galerii |
| `POST` | `/api/uploads/init` | inicjuje wznawialny upload |
| `GET` | `/api/thumbnail/:id` | pobiera miniaturę przez Workera |
| `GET`, `HEAD` | `/api/media/:id` | podgląd lub streaming pliku |
| `GET`, `HEAD` | `/api/download/:id` | pobranie pojedynczego oryginału |

## Bezpieczeństwo i ograniczenia

- Dostęp do galerii zapewnia posiadanie linku; aplikacja nie ma logowania gości.
- Tokeny OAuth są przechowywane jako sekrety Cloudflare i lokalnie w ignorowanym pliku `.dev.vars`.
- Pliki są przechowywane w Google Drive, a Worker pośredniczy w listowaniu, podglądzie i pobieraniu.
- Worker nie buforuje całych dużych plików w pamięci — przekazuje odpowiedzi strumieniowo i obsługuje żądania `Range`.
- Aplikacja nie usuwa ani nie edytuje plików z poziomu interfejsu.

## Najczęstsze problemy

### Galeria nie ładuje plików

Sprawdź `/api/health`, poprawność `GOOGLE_FOLDER_ID` oraz ważność tokenu OAuth.

### Upload zatrzymuje się

Pozostaw stronę otwartą, sprawdź połączenie z Internetem i wybierz ten sam plik ponownie. Aplikacja wykorzystuje zapisane sesje uploadu do wznowienia przesyłania.

### Format nie otwiera się w przeglądarce

Użyj przycisku „Otwórz” w Google Drive albo „Pobierz”, aby otrzymać oryginalny plik.
