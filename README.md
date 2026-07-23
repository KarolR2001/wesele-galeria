# Galeria Weselna - Patrycja i Karol

Współdzielona, interaktywna galeria weselna pozwalająca gościom na przeglądanie oraz łatwe dodawanie własnych zdjęć i filmów. Aplikacja została zoptymalizowana pod kątem urządzeń mobilnych, responsywności i maksymalnej wydajności (w tym obsługa "safe area" dla ekranów z wcięciem / notchem).

## Główne funkcje

- **Wspólna przestrzeń multimedialna:** Wszyscy goście mogą bez zakładania konta dodawać wiele zdjęć i filmów naraz.
- **Integracja z Dyskiem Google:** Stabilne, wznawialne przesyłanie przesyłanie plików prosto do dedykowanego folderu na Dysku Google, bez obciążania Twojego serwera.
- **Pełnoekranowy podgląd (Viewer):** Zaawansowany, oparty na Flexbox tryb pełnoekranowy z dedykowanymi loaderami i wsparciem na smartfonach.
- **Animowany Splash Screen:** Nieszablonowy, estetyczny ekran startowy, w całości wyreżyserowany w płynnych klatkach CSS (Keyframes).
- **Gotowe na Social Media (SEO & OG):** Zaimplementowane tagi Open Graph, zapewniające piękny podgląd (duży obrazek) podczas wysyłania linku na WhatsAppie, Messengerze czy w iMessage.

## Architektura & Technologie

- **Frontend:** Vanilla HTML5, czysty, ultralekki CSS3 i JavaScript (ES6+). Zero nadmiarowych frameworków (np. Reacta), by strona lądowała się błyskawicznie w plenerze przy słabszym zasięgu.
- **Backend:** Cloudflare Workers – bezserwerowa (serverless), wysoce skalowalna chmura brzegowa.
- **Główny magazyn danych:** Google Drive API.

## Jak pracować z projektem (Development)

Wymagane jest środowisko Node.js.

1. Zainstaluj niezbędne pakiety (NPM):
   ```bash
   npm install
   ```
2. Uruchom serwer testowy (Wrangler):
   ```bash
   npm run dev
   ```
   Galeria otworzy się lokalnie, domyślnie pod adresem `http://localhost:8787`.

## Publikacja do internetu (Deploy)

Wysyłanie zmian na chmurę produkcyjną sprowadza się do jednego polecenia:

```bash
npm run deploy
```
