# Sova – ľahký prehliadač

Prehliadač na jadre Chromium (Electron 44), ktorý šetrí neaktívne karty a blokuje reklamy.

## Ako šetrí karty

| Stav | Kedy | CPU/GPU | RAM |
|---|---|---|---|
| Aktívna | karta, ktorú máš práve otvorenú | normálne | normálne |
| Zmrazená (ikona vločky) | 3 s po prepnutí na inú kartu | ≈ 0 % (JS, časovače, animácie aj vykresľovanie sú zastavené) | ostáva |
| Uspaná (ikona mesiaca) | po 10 min neaktivity | 0 | uvoľnená (proces stránky sa ukončí) |

Po kliknutí na uspanú kartu sa stránka obnoví aj s históriou, pozíciou scrollu a vyplnenými formulármi.
Karty, ktoré hrajú zvuk, sa nezmrazujú. Domény ako Outlook alebo Teams môžeš dať do zoznamu „Nikdy neuspávať“
(v nastaveniach, alebo pravým tlačidlom na karte).

Prázdna nová karta nemá vlastný proces (kreslí ju lišta prehliadača) a bubliny/menu sa 30 s po zatvorení
úplne uvoľnia z pamäte. Pamäť v lište je súkromná pamäť procesov (ako v Správcovi úloh Windows).

## Blokovanie reklám

Knižnica Ghostery adblocker (zoznamy EasyList, EasyPrivacy, uBlock filtre). Zoznamy sa aktualizujú denne,
záložná kópia je pribalená v aplikácii, takže blokovanie funguje aj offline. Štít v adresnom riadku ukazuje počet
zablokovaných požiadaviek; kliknutím naň vypneš blokovanie pre danú stránku.

## História a návrhy

Ctrl+H alebo ikona hodín otvorí históriu na samostatnej karte `sova://history` (vyhľadávanie bez ohľadu na diakritiku,
označenie a zmazanie vybraných záznamov, zmazanie za poslednú hodinu/deň/týždeň/mesiac alebo celej histórie).
Nastavenia sú na karte `sova://settings` (Ctrl+, alebo ikona ozubeného kolieska). Pri písaní do adresného riadku sa navrhujú navštívené domény (nie konkrétne podstránky) –
napr. po napísaní „you“ sa doplní „youtube.com“. Enter ho otvorí, Backspace doplnenie zruší.
Uložené v `%APPDATA%\Sova\history.json`, záznamy staršie ako pol roka sa mažú.

## Záložky

Hviezdička v adresnom riadku alebo Ctrl+D pridá stránku na lištu záložiek (v bubline zmeníš názov a priečinok).
Lišta záložiek je pod adresným riadkom (Ctrl+Shift+B ju skryje), priečinky sa otvárajú ako menu, poradie sa mení ťahaním.
Správca záložiek `sova://bookmarks` (Ctrl+Shift+O): priečinky, hľadanie, úpravy, presúvanie, odstránenie so „Späť“,
import z Chrome / Brave / Edge / Vivaldi / Opery (priamo z profilu na tomto PC) alebo zo súboru HTML a export do HTML.
Uložené v `%APPDATA%\Sova\bookmarks.json`.

## Vyťaženie, test rýchlosti a sťahovanie

V lište je vyťaženie procesora a pamäť Sovy a aktuálna rýchlosť siete celého PC (↓ sťahovanie, ↑ odosielanie).
Kliknutím sa otvorí prehľad s testom rýchlosti internetu (odozva, sťahovanie, odosielanie cez servery Cloudflare).
Ikona sťahovania ukazuje priebeh (krúžok) a nové stiahnuté súbory (bodka); bublina so zoznamom sa pri začatí
sťahovania ukáže sama. Všetky sťahovania sú na karte `sova://downloads` (Ctrl+J). Priečinok a „spýtať sa kam uložiť“
sú v Nastaveniach.

## Vývoj

```
npm install
npm start                 # spustenie
npm run dist              # Windows build (portable .exe) do priečinka dist/
```

Kód: `src/main.js` (okno, skratky, oprávnenia), `src/tabs.js` (karty, zmrazovanie, uspávanie),
`src/adblock.js` (blokovanie), `src/history.js` (história, návrhy), `src/bookmarks.js` + `src/bookmarks-ui.js` + `src/bmpopover.js` (záložky), `src/suggest.js` (zoznam návrhov), `src/downloads.js` + `src/tools-ui.js` + `src/netstats.js` + `src/speedtest.js` (sťahovanie, vyťaženie, test rýchlosti), `src/bubble.js` (bubliny v lište), `src/ui/` (rozhranie), `src/ui/pages/` (interné stránky sova://). Nastavenia a relácia sú v `%APPDATA%\Sova`.
