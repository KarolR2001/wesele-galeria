# Galeria dla gości

Lekka, współdzielona galeria zdjęć i filmów przeznaczona dla gości wydarzeń. Uczestnicy dołączają przez link, dodają materiały, przeglądają całą galerię i pobierają pojedyncze oryginalne pliki.

Aplikacja jest przygotowana przede wszystkim z myślą o telefonach, a responsywny układ obsługuje również tablety i komputery. Frontend korzysta z lekkiego HTML, CSS i JavaScriptu, a pliki są przechowywane w Google Drive.

## Funkcje

- wspólna galeria dostępna z jednego linku lub kodu QR,
- wysyłanie wielu zdjęć i filmów w kolejce,
- wznawialny upload do Google Drive w częściach po 8 MiB,
- ponawianie błędów przejściowych oraz obsługa chwilowej utraty połączenia,
- automatyczne ładowanie kolejnych stron galerii dla dowolnej liczby elementów,
- leniwe ładowanie miniaturek i fallback przez Workera,
- podgląd zdjęć i natywne odtwarzanie filmów,
- fallback Google Drive dla formatów wymagających zewnętrznego podglądu,
- viewer z nawigacją klawiaturą, przyciskiem Escape i obsługą ekranów dotykowych,
- pobieranie każdego oryginalnego pliku osobno,
- responsywny layout desktopowy z zachowaniem mobilnego interfejsu,
- obsługa safe-area, `prefers-reduced-motion` i zoomu przeglądarki.

## Architektura

- **Frontend:** Vanilla HTML, CSS i JavaScript ES Modules.
- **Backend:** Cloudflare Workers.
- **Magazyn plików:** Google Drive API.
- **Hosting assetów:** Cloudflare Workers Assets.
- **Konfiguracja lokalna:** sekrety Google Drive zapisane w pliku `.dev.vars`, ignorowanym przez Git.

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

Plik `.dev.vars` pozostaje lokalny i jest ignorowany przez Git.

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

## Bezpieczeństwo

- Dostęp do galerii otrzymują osoby posiadające link.
- Tokeny OAuth są przechowywane jako sekrety Cloudflare i lokalnie w ignorowanym pliku `.dev.vars`.
- Pliki są przechowywane w Google Drive, a Worker pośredniczy w listowaniu, podglądzie i pobieraniu.
- Worker przekazuje duże pliki strumieniowo i obsługuje żądania `Range`.

## Najczęstsze problemy

### Diagnostyka ładowania galerii

Sprawdź `/api/health`, poprawność `GOOGLE_FOLDER_ID` oraz ważność tokenu OAuth.

### Upload zatrzymuje się

Pozostaw stronę otwartą, sprawdź połączenie z Internetem i wybierz ten sam plik ponownie. Aplikacja wykorzystuje zapisane sesje uploadu do wznowienia przesyłania.

### Obsługa formatów multimedialnych

Użyj przycisku „Otwórz” w Google Drive albo „Pobierz”, aby otrzymać oryginalny plik.
