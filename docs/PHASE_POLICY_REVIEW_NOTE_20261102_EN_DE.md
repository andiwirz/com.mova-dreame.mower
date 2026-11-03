# 02 November 2026 — mission-phase semantics / Fahrphasen-Regeln

**Issue:** The previous `prestart` decision armed even a `return`-only native zone before departure. This contradicted the label and could obstruct the outbound corridor. The fix excludes `return` from outbound pre-arming.

**Mowing only / Mowing + return:** They remain conservatively pre-armed while docked and during departure, even though the user-facing label names the phase in which protection is principally needed. This is an explicit A2 hardware constraint: the native no-go map cannot be changed while a task is active; PAUSED is not enough. All editors display the exception. No unsafe attempt is made while driving.

**Return only:** Activated only at a verified task-free return checkpoint, if one is available, and reported successful only after authoritative direct MAPD verification. If an original-app return doesn't provide this checkpoint, the change is pending; the label alone is not evidence of protection.

**No garage required:** Lifecycle evaluation is independent of the electric gate. Gate/priority safety still requires Garage Mode. No required native geometry transition means no extra map-edit STOP, though a separate door/danger guard may pause the mower.

**EN/DE logging:** User-facing notifications are localized with Homey language. Developer logs translate common state/reason text; raw protocol codes and some technical keys are deliberately kept as-is. This is not full translation parity for every debug string.

**Independent validation:** Contributor reports that `homey app validate --level publish` and repeated physical emergency/Priority checks succeeded on their setup. The local audit did not rerun either on Homey hardware.

**DE:** Frühere Regel `Nur Rückkehr` wurde fehlerhaft bereits vor der Ausfahrt scharfgeschaltet, jetzt korrigiert. `Nur Mähen` und `Mähen + Rückkehr` müssen weiterhin an der Station voraktiviert sein, da native Kartenschreibvorgänge während einer laufenden Aufgabe nicht möglich sind. Dies steht in allen drei Editoren. Ein echtes neues Polygon gilt erst nach nativer Bestätigung durch MAPD als aktiv. Ohne Änderungsbedarf kein zusätzlicher STOP für Sperrzonen, aber andere Tor-/Gefahrenbremsen bleiben aktiv.
