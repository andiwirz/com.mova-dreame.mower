# MOVA A2: Feldlog vom 3. November 2026 – Analyse und gezielte Korrektur

**Eingang:** `MOVA_Log_20261103_102716_187_EXPORT.zip`, App **1.2.153** (private Kamera-Version), 3.450 Ereignisse, keine Logger-Lücken, 10:27:16–10:46:31 Uhr (MEZ).

## Ergebnis auf einen Blick

- Externer Original-App-Start mit STOP/PAUSE, Toröffnung und anschließendem Wiederstart funktioniert. Das reale OFFEN-Sensorsignal und die Freigabe sind dokumentiert.
- Wartungspunkt **P2**: Ankunft **10:30:58**, native Bestätigung `75`, nur **128 mm** Abstand zur bekannten Position; unmittelbar darauf sicherer Torschließauftrag.
- Wartungspunkt **P1**: Ankunft **10:36:18**, native Bestätigung `75`, nur **157 mm** Abstand zur gespeicherten Position.
- Rückkehr durch die Original-App: **10:37:29** erkannt. Die Position `(-280,-4800)` wurde vor PAUSE/STOP gesichert. Konservativer Linienabstand/ETA führten zur korrekten Entscheidung „über P1“.
- Tor wurde **10:38:56** bereits während der Fahrt zu P1 parallel geöffnet; echter OFFEN-Sensor **10:39:03**, stabil offen **10:39:13**. P1-Ankunft während dieser Rückfahrt **10:39:00**, native `75` und **272 mm** Abweichung.
- **Fehler 1 (10:39:02):** Nach erfolgreichem nativen `200` und `204` meldete die Firmware kurzfristig wieder `mowing`/`mapping`. Die Sperrzonen-Schreibsicherung verweigerte dadurch `218`, obwohl IDLE/Positionslage vorher bestätigt waren. Meldung `Map edit checkpoint expired before mutation` bezeichnet in diesem Lauf nicht den Ablauf der 30-Sekunden-Frist, sondern eine verweigerte Berechtigung unmittelbar vor der eigentlichen Mutation.
- **10:39:20:** Erster 30-Sekunden-Wartungspunkt-Checkpoint endet ohne bestätigte Löschung. Der Sicherheits-HOLD war damit korrekt, wenn auch durch einen Softwarefehler verursacht.
- **10:39:35–10:39:49:** Automatischer Rückkehr-Wiederholungsweg erwirkt erneut STOP/IDLE und Kartenänderung. **10:39:49** beweist direkte MAPD-Karte, dass Sperrzone **102** tatsächlich **nicht mehr vorhanden** ist (`remaining=none`, nur Zone 101 verbleibt).
- **Fehler 2:** Derselbe Rückkehrtoken hatte bereits ein MAPD-Attempt-Merkmal, aber die unabhängige erfolgreiche MAPD-Bestätigung wurde nicht in das `VerifiedToken` des Wartungspunktzweigs übernommen. Die Fortsetzung behandelte den schon erfolgreich gelöschten Bereich als unbestätigt und lief **10:39:57** erschöpft in MANUAL RECOVERY.
- **10:42:17:** Mäher nach manueller Original-App-Übernahme tatsächlich `IN_STATION`, Ladesignal. **10:42:24:** Zone 102 wurde wiederhergestellt und durch MAPD bestätigt. **10:45:31:** Manuelle Wiederfreigabe nach unabhängigen nativen Dockmessungen. **10:46:24:** Tor GESCHLOSSEN gemeldet.

## Positionssprünge während der Ausfahrt

Die App protokolliert bis 10:28:58 mehrfach eine ältere `LOCN`-Fallback-Kartenposition (`1390,-330`), während noch **keine frische körperliche Position** für die Sicherheitslinienüberwachung vorlag. Der Sicherheitspfad vermerkte mehrfach `wartet auf erste gültige Position`; außerdem wurden `LOCN history quarantined` und später `authority=mqtt_live; fallback updates suppressed` protokolliert. Somit ist kein sicherheitskritischer Torbefehl infolge dieser fragwürdigen Ersatzposition erkennbar. Dass eine Kartenanzeige zeitweilig an falsche Stellen sprang, lässt sich damit plausibel erklären, aber ohne Widget-Screenshot nicht jedem Marker eindeutig zuordnen.

## Korrekturen an CORE und Kamera

1. **Eng begrenzte native Map-Editor-Ausnahme:** Die temporäre `mowing`-Meldung nach bestätigten TASK-ACKs für `200`/`204` blockiert den nachfolgenden Mutationsschritt nicht mehr *allein wegen des Labels*. Die Ausnahme ist auf den aktuellen Rückkehrtoken, Kartenindex, sicher bestätigte P1–P5-Ankunft, unabhängiges **task-freies natives IDLE vor Edit-Beginn**, aktives Tor-Öffnen/Offen, und **zwei frische übereinstimmende native SIID-Positionsmessungen nach dem BEGIN** begrenzt. Bei tatsächlicher Bewegung, Positionskonflikt, fehlendem IDLE, schließendem Tor oder Recovery/Notfall wird die Mutation weiterhin abgewiesen. `200 → 204 → 218 → 201` kann dadurch im unveränderten sicheren Fall durchlaufen.
2. **VerifiedToken korrekt übergeben:** Eine bereits im selben Rückkehrtoken durch direkte MAPD bestätigte Sperrzonenlöschung wird auch beim Fortsetzen vom Wartungspunkt erkannt. Es wird nicht erneut gelöscht und kein unberechtigter HOLD wegen „nicht bestätigt“ ausgelöst. Das ersetzt **keinen** Nachweis über sichere Toröffnung und Position vor DOCK.
3. **Unverändert:** Echte STOP/IDLE-Pflicht vor nativen Änderungen, unabhängige Tor- und Sicherheitslinienlogik, Priority-Mechanismen, 30-Sekunden-Grenze, Pending-Markierung, bedingte Fallback-Befehle und Videoisolierung.

## Regressionstests

- CORE **1.2.154**: 1.450/1.450 Tests bestanden.
- CORE+KAMERA **1.2.155**: 1.517/1.517 Tests bestanden.
- CORE-PR-Quellfassung **1.2.0** gegen Andy 1.1.43: 270/270 Tests bestanden.
- Neue Regressionen prüfen `200/204`-MOWING mit anschließendem echtem `218`, verweigerte Mutation ohne doppelte Native-Messung, Positionsbewegung, fehlendes Task-IDLE, schließendes Tor, Notfallzustand und Weitergabe des erfolgreichen `MAPD`-Nachweises an den Wartungspunkt-Rückkehrzweig.

## Freigabestatus und weiterer Feldtest

**Aktualisierung nach der ersten Fehleranalyse (03.11.2026):** Der ursprüngliche Abschnitt oben dokumentiert den fehlgeschlagenen Lauf mit App 1.2.153 und die unmittelbar danach noch ungetestete Korrektur. Anschließend wurde ein weiterer beaufsichtigter A2-Rückkehrlauf erfolgreich durchgeführt: Original-App-Rückkehr, native Löschung der Zone 102 mit MAPD-Bestätigung, parallele Toröffnung, automatische sichere Dock-Rückkehr, Wiederherstellung der Zone und Torverschluss ohne manuelle Recovery. Pause/Fortsetzen und Widgets wurden im Feld ebenfalls als funktionsfähig gemeldet. Die Angabe „noch nicht physisch getestet“ gilt somit **nur für den Zeitpunkt der ersten Fehleranalyse**, nicht für diesen nachgetragenen Erfolgsnachweis. Die gesonderte Software-Testzahl 270/270 bezieht sich auf die damalige extrahierte CORE-PR-Fassung, nicht automatisch auf jeden späteren Commit. Sonderfälle mit echter Notbremsung, konkurrierendem Herstellerauftrag oder abweichenden Modellen bleiben ohne vollständigen physischen Nachweis. „Keine nötige Zonenänderung → kein MAPD-STOP“ weiterhin separat als Regression absichern; API-ACK oder alte Koordinaten sind keine Sicherheitsfreigabe.

**Logger-Leistung:** 544 `logs`-Abfragen, null Fehler, Ø 636 ms, max. 2.328 ms; 126 `status`-Abfragen, null Fehler, Ø 674 ms. Keine Loglücken. Diese Messungen erlauben **keine** Aussage über tatsächliche Homey-CPU-/RAM-Spitzen.
