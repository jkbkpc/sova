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
Ikony stránok sa ukladajú priamo do záložiek: pri importe z Chrome/Brave/Edge sa prevezmú z profilu prehliadača,
chýbajúce sa doplnia na pozadí a po návšteve stránky sa aktualizujú.
Uložené v `%APPDATA%\Sova\bookmarks.json`.

## Vyťaženie, test rýchlosti a sťahovanie

V lište je vyťaženie procesora a pamäť Sovy a aktuálna rýchlosť siete celého PC (↓ sťahovanie, ↑ odosielanie).
Kliknutím sa otvorí prehľad s testom rýchlosti internetu (odozva, sťahovanie, odosielanie cez servery Cloudflare).
Ikona sťahovania ukazuje priebeh (krúžok) a nové stiahnuté súbory (bodka); bublina so zoznamom sa pri začatí
sťahovania ukáže sama. Všetky sťahovania sú na karte `sova://downloads` (Ctrl+J). Priečinok a „spýtať sa kam uložiť“
sú v Nastaveniach.

## Zabezpečenie

- **Ochrana pred podvodnými a nebezpečnými stránkami:** zoznamy URLhaus (malvér), Phishing Army, CERT Polska
  a OpenPhish (phishing) sa sťahujú každých 30 minút (len keď sa zmenili) a kontrola prebieha v počítači – adresy sa
  nikam neposielajú. Pred takou stránkou sa ukáže červené varovanie a sťahovanie z nej sa zablokuje. Vypína sa v Nastaveniach.
- **Bezpečnostné záplaty Chromia:** Dependabot každé ráno kontroluje nové verzie Electronu. Záplatu (napr. 44.4.5 → 44.4.6)
  workflow `security-update` sám zlúči a vydá novú verziu Sovy – nainštalované Sovy si ju stiahnu samy.
  Nová hlavná verzia Electronu čaká na ručnú kontrolu (pull request na GitHube).
- Prihlasovacia stránka Google dostane user agent Firefoxu (Google inak prehliadače na Electrone odmieta).

## Okná a inkognito

Ctrl+N otvorí nové okno, Ctrl+Shift+N okno inkognito (aj pravým tlačidlom na „+“, alebo „Otvoriť v novom okne /
v okne inkognito“ pri odkaze či záložke). Inkognito má vlastnú reláciu v pamäti – nezapisuje sa história, cookies,
údaje stránok ani priblíženie a po zatvorení posledného okna inkognito sa všetko zahodí. Pri obnovení relácie
sa vrátia všetky bežné okná aj s polohou (`session.json`).

## Priblíženie, PDF a skratky

Ctrl + koliesko myši, Ctrl +/− a Ctrl+0 menia priblíženie v krokoch ako Chrome (25–500 %); zapamätá sa pre každú doménu
(`%APPDATA%\Sova\zoom.json`) a v adresnom riadku ho ukazuje lupa. PDF súbory sa otvárajú priamo v karte (vstavaný
prehliadač Chromia – listovanie, hľadanie, tlač, stiahnutie). Zoznam všetkých klávesových skratiek je dole v Nastaveniach.

## Aktualizácie

Nainštalovaná verzia (Setup) si každé 4 hodiny skontroluje GitHub Releases (`jkbkpc/sova`). Novú verziu stiahne na pozadí,
v lište sa ukáže zelené **Aktualizovať** (reštart s obnovením kariet) a inak sa nainštaluje pri najbližšom zatvorení Sovy.
Prenosná verzia len upozorní „Nová verzia“ a otvorí stránku so stiahnutím. Stav a ručná kontrola sú v Nastaveniach.

Vydanie novej verzie (stiahne zmeny z GitHubu, zvýši verziu, commit + push, zostaví a nahrá GitHub Release):

```
npm run ship -- 1.3.4 "Čo je nové"
```

GitHub token (fine-grained, repozitár `jkbkpc/sova`, Contents: Read and write) sa pri prvom spustení vypýta
a uloží zašifrovaný cez Windows do `%APPDATA%\Sova-dev\github-token.txt`. Nový token: pridaj `-NewToken`.

## Vývoj

```
npm install
npm start                 # spustenie
npm run dist              # Windows build (portable .exe) do priečinka dist/
```

Kód: `src/main.js` (spustenie, okná, skratky, oprávnenia), `src/window.js` (jedno okno prehliadača), `src/tabs.js` (karty, zmrazovanie, uspávanie),
`src/adblock.js` (blokovanie), `src/history.js` (história, návrhy), `src/bookmarks.js` + `src/bookmarks-ui.js` + `src/favicons.js` + `src/bmpopover.js` (záložky), `src/suggest.js` (zoznam návrhov), `src/downloads.js` + `src/tools-ui.js` + `src/netstats.js` + `src/speedtest.js` (sťahovanie, vyťaženie, test rýchlosti), `src/bubble.js` (bubliny v lište), `src/updater.js` (aktualizácie), `src/windowstate.js` (poloha okna), `src/zoom.js` + `src/zoom-ui.js` (priblíženie), `src/defaultbrowser.js` (predvolený prehliadač), `src/log.js` (denník), `src/ui/` (rozhranie), `src/ui/pages/` (interné stránky sova://). Nastavenia a relácia sú v `%APPDATA%\Sova`.
