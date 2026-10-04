# Kamera direkt auf Homey

Die aktive Kamera verwendet einen appinternen ARM64-XP2P-Worker und genau einen lokalen FLV-Abruf. Native Geräteansicht und Widgets teilen denselben Worker. Kein externer NodeLab-Dienst, keine Kopplung zu einem PC und kein FFmpeg. Der frühere Test-Worker ist als Binärdatei samt Quellstand eingebunden; sein Herkunftsname begründet keine externe Betriebsabhängigkeit.

Das Tencent-2.4.50-SDK wird beim ersten Bedarf von der App geladen und per SHA-256 geprüft. Linux/ARM64 mit 4-KiB-Seiten wird vorausgesetzt; eine inkompatible Laufzeit wird abgelehnt. Der reale Homey-Lauf wurde hier nicht ausgeführt.

Der aktuelle Homey-Pfad ist bewusst video-only; der frühere Audio-Versuch und die Audio-/AAC-Testpfade sind nicht Bestandteil der PR-Version.

Die Kameraidentität wird zur Laufzeit ausschließlich über die angemeldete Dreame/MOVA-Cloud-Sitzung ermittelt. Es gibt keinen manuellen Identity-Import und keinen externen Companion-/PC-Dienst. Eine automatische Neukopplung des Geräts wird nicht erzwungen.

Widgets holen komprimierte H.264-Frames über Homeys Widget-API; der Browser decodiert mit WebCodecs. Die native VideoOther-Gerätekamera erhält einen zufällig tokenisierten privaten Homey-LAN-FLV-Endpunkt. Kein neu eingerichteter Fernzugriff. Stream-Puffer sind begrenzt; mehrere Ansichten erzeugen keine mehrfachen SDK-Prozesse.

EIN startet erst bei frischem Stationsaustrittsnachweis. AUS beendet die Freigabe der jeweiligen Ansicht. Die letzte Ansicht stoppt den Worker; unsichtbare/abgebrochene Ansichten verfallen nach rund 15 Sekunden ohne Lebenszeichen. Maximale Laufzeit 15 Minuten. Ein unbestätigter Worker-Stop sperrt erneuten Start. Die optionale automatische Vorschau läuft nur während der sichtbaren Ausfahrtsübersicht, maximal fünf Minuten; manuelles AUS unterdrückt erneuten Autostart im selben Manöver.

Geprüft: synthetische Cloud-Antworten, Gerätebindung, gemeinsamer HTTP-Abruf, FLV-Parsing, begrenzte Puffer, Abschalten/Abbruch und native Registrierungsfunktion mit SDK-Doubles. Nicht geprüft: reale Homey-ABI, echtes Hersteller-Livebild, Browserdecodierung und native LAN-Erreichbarkeit auf deinem Gerät.
