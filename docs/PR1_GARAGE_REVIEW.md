# PR1 – Garagenbetrieb und Wartungspunkte (Review-Kandidat)

Basis: vom Nutzer geliefertes Andy-Archiv 1.1.44. Der Stand enthält die zusammengehörigen Geräte-, Fahr-, Sicherheits-, MAPD-Checkpoint- und Wartungspunkt-/Garagen-Einrichtungsfunktionen.

**Warum der Karteneditor schon in PR1 liegt:** Die Garageneinrichtung (`garage_settings.html`) öffnet `map_editor.html` für die Sicherheitslinie A/B und den Gefahrenbereich. Eine isolierte Wartungspunktsteuerung ohne diese Oberfläche wäre nicht nutzbar. Die erweiterte Zoneneditor-UI ist deshalb teilweise schon Teil von PR1 und wird nicht doppelt als neue Feature-Grenze beansprucht.

**Was bewusst fehlt:** neue Karten-/Verlaufswidget-Darstellung und das Overview-Widget. Diese kommen in Folge-PRs.

**Abnahme:** Homey-Reparaturansichten; Garagenmodus AN/AUS; P2-Anlage/-Auswahl aus Original-App; Tor öffnen/Endlage bestätigen; Ausfahrt und Prio 1–3; Pause/Resume; Rückkehr mit native MAPD-Beweis; sichere Sperre bei ungeklärten Zonen. Realgerätetest erforderlich.

**Nicht versprochen:** reiner kleiner Patch oder vollständige Hardwarefreigabe. Diese PR ist notwendigerweise groß, weil der vollständige CORE die engine stark mit MAPD verknüpft.
