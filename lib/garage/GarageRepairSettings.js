'use strict';
// Single source of truth for the Garage Repair UI and its validated persisted values.
const CATALOG = {
  "groups": [
    {
      "id": "door",
      "label": {
        "en": "Door & sensor",
        "de": "Tor & Sensor"
      },
      "keys": [
        "garage_sensor_enabled",
        "garage_sensor_min_battery",
        "garage_open_stabilize_seconds",
        "garage_open_duration_seconds",
        "garage_close_duration_seconds"
      ]
    },
    {
      "id": "safety",
      "label": {
        "en": "Distances & movement",
        "de": "Abstände & Bewegung"
      },
      "keys": [
        "garage_speed_source",
        "garage_mower_speed_value",
        "garage_speed_unit",
        "garage_danger_radius_mm",
        "garage_danger_hysteresis_mm",
        "garage_line_hysteresis_mm",
        "garage_line_segment_margin_mm",
        "garage_caution_radius_mm"
      ]
    },
    {
      "id": "display",
      "label": {
        "en": "Garage map display",
        "de": "Garagen-Kartenanzeige"
      },
      "keys": [
        "garage_map_overlay_enabled",
        "garage_show_safety_line",
        "garage_show_danger_area"
      ]
    },
    {
      "id": "notifications",
      "label": {
        "en": "Alerts & diagnostics",
        "de": "Hinweise & Diagnose"
      },
      "keys": [
        "garage_mission_push_notifications",
        "garage_logging_enabled",
        "garage_debug_verbose"
      ]
    },
    {
      "id": "names",
      "label": {
        "en": "Maintenance point names",
        "de": "Wartungspunktnamen"
      },
      "keys": [
        "maintenance_point_1_name",
        "maintenance_point_2_name",
        "maintenance_point_3_name",
        "maintenance_point_4_name",
        "maintenance_point_5_name"
      ]
    }
  ],
  "fields": {
    "garage_sensor_enabled": {
      "id": "garage_sensor_enabled",
      "type": "checkbox",
      "label": {
        "en": "Use garage door sensor",
        "de": "Torsensor verwenden"
      },
      "value": false,
      "hint": {
        "de": "Der Sensor hat 30 Sekunden für die Bestätigung einer Torbewegung. Dies ist keine einstellbare Offline-Überwachung. Ohne Sensor beweist eine abgelaufene Laufzeit keine Tor-Endlage.",
        "en": "The sensor waits up to 30 seconds for a door movement confirmation. This is not a configurable offline watchdog. Without sensor, elapsed runtime is not physical proof of the gate position."
      }
    },
    "garage_sensor_min_battery": {
      "id": "garage_sensor_min_battery",
      "type": "number",
      "label": {
        "en": "Minimum sensor battery (%)",
        "de": "Mindestladung Torsensor (%)"
      },
      "value": 15,
      "min": 0,
      "max": 100,
      "step": 1,
      "hint": {
        "de": "Nur wirksam, wenn Garagenmodus UND Torsensor aktiviert sind. Bei abgeschaltetem Torsensor wird dieser Wert ignoriert.",
        "en": "Only applies when both garage mode and door sensor are enabled. Ignored when the sensor is disabled."
      }
    },
    "garage_sensor_watchdog_minutes": {
      "id": "garage_sensor_watchdog_minutes",
      "type": "number",
      "label": {
        "en": "Legacy sensor idle watchdog (unused; min)",
        "de": "Alte Sensor-Überwachung (nicht verwendet; min)"
      },
      "value": 30,
      "min": 1,
      "max": 240,
      "step": 1,
      "hint": {
        "de": "Ohne Funktion. Historischer Altwert bleibt ausschließlich für Bestandsinstallationen und Migrationen gespeichert; die Torbestätigung dauert weiterhin 30 Sekunden.",
        "en": "Inactive legacy value retained solely for existing installations and migration. The door-confirmation timeout remains 30 seconds."
      }
    },
    "garage_open_stabilize_seconds": {
      "id": "garage_open_stabilize_seconds",
      "type": "number",
      "label": {
        "en": "Open stabilisation time (s)",
        "de": "Tor-offen-Stabilisierungszeit (s)"
      },
      "value": 10,
      "min": 0,
      "max": 60,
      "step": 1
    },
    "garage_open_duration_seconds": {
      "id": "garage_open_duration_seconds",
      "type": "number",
      "label": {
        "en": "Door opening time (s)",
        "de": "Tor-Öffnungsdauer (s)"
      },
      "value": 10,
      "min": 0,
      "max": 120,
      "step": 1,
      "hint": {
        "en": "Also used to reassert an already displayed open door before a return.",
        "de": "Auch zur erneuten Offen-Anforderung vor einer Rückfahrt bei bereits als offen angezeigtem Tor."
      }
    },
    "garage_close_duration_seconds": {
      "id": "garage_close_duration_seconds",
      "type": "number",
      "label": {
        "en": "Door closing time without sensor (s)",
        "de": "Tor-Schließdauer ohne Sensor (s)"
      },
      "value": 10,
      "min": 0,
      "max": 120,
      "step": 1,
      "hint": {
        "en": "Also used to reassert an already displayed open door before a return.",
        "de": "Auch zur erneuten Offen-Anforderung vor einer Rückfahrt bei bereits als offen angezeigtem Tor."
      }
    },
    "garage_speed_source": {
      "id": "garage_speed_source",
      "type": "dropdown",
      "label": {
        "en": "Speed source for garage ETA",
        "de": "Geschwindigkeitsquelle für Garagen-ETA"
      },
      "value": "auto",
      "values": [
        {
          "id": "auto",
          "label": {
            "en": "Automatic: live → measured → model → user",
            "de": "Automatisch: Live → gemessen → Modell → Benutzer"
          }
        },
        {
          "id": "live",
          "label": {
            "en": "Prefer live mower speed",
            "de": "Live-Geschwindigkeit bevorzugen"
          }
        },
        {
          "id": "measured",
          "label": {
            "en": "Prefer measured position average",
            "de": "Gemessenen Positionsdurchschnitt bevorzugen"
          }
        },
        {
          "id": "model",
          "label": {
            "en": "Prefer model default",
            "de": "Modellstandard bevorzugen"
          }
        },
        {
          "id": "user",
          "label": {
            "en": "Use user setting only",
            "de": "Nur Benutzereinstellung verwenden"
          }
        }
      ],
      "hint": {
        "en": "Used only for garage return ETA and half-map decision logging. Live speed is used automatically if the mower exposes it.",
        "de": "Nur für Rückkehr-ETA und Halb-Karten-Entscheidungen. Live-Geschwindigkeit wird automatisch genutzt, falls der Mäher sie liefert."
      }
    },
    "garage_mower_speed_value": {
      "id": "garage_mower_speed_value",
      "type": "number",
      "label": {
        "en": "Fallback/custom mower speed",
        "de": "Fallback-/benutzerdefinierte Mähergeschwindigkeit"
      },
      "value": 1.8,
      "min": 0,
      "max": 10000,
      "step": 0.1,
      "hint": {
        "en": "Used only when no higher-priority speed source is available or when speed source is set to user only. Internally converted to m/s.",
        "de": "Wird nur genutzt, wenn keine höher priorisierte Quelle verfügbar ist oder die Quelle auf Nur Benutzer steht. Intern wird in m/s umgerechnet."
      }
    },
    "garage_speed_unit": {
      "id": "garage_speed_unit",
      "type": "dropdown",
      "label": {
        "en": "Speed unit",
        "de": "Geschwindigkeitseinheit"
      },
      "value": "kmh",
      "values": [
        {
          "id": "kmh",
          "label": {
            "en": "km/h",
            "de": "km/h"
          }
        },
        {
          "id": "mph",
          "label": {
            "en": "mph",
            "de": "mph"
          }
        },
        {
          "id": "mmps",
          "label": {
            "en": "mm/s",
            "de": "mm/s"
          }
        },
        {
          "id": "mps",
          "label": {
            "en": "m/s",
            "de": "m/s"
          }
        }
      ]
    },
    "garage_danger_radius_mm": {
      "id": "garage_danger_radius_mm",
      "type": "number",
      "label": {
        "en": "Danger area radius (mm)",
        "de": "Gefahrenbereich-Radius (mm)"
      },
      "value": 1200,
      "min": 100,
      "max": 10000,
      "step": 100
    },
    "garage_danger_hysteresis_mm": {
      "id": "garage_danger_hysteresis_mm",
      "type": "number",
      "label": {
        "en": "Danger area hysteresis (mm)",
        "de": "Gefahrenbereich-Hysterese (mm)"
      },
      "value": 250,
      "min": 0,
      "max": 2000,
      "step": 50,
      "hint": {
        "en": "Prevents inside/outside flicker at the edge of the danger circle.",
        "de": "Verhindert Flackern am Rand des Gefahrenbereich-Kreises."
      }
    },
    "garage_line_hysteresis_mm": {
      "id": "garage_line_hysteresis_mm",
      "type": "number",
      "label": {
        "en": "Safety line hysteresis (mm)",
        "de": "Sicherheitslinien-Hysterese (mm)"
      },
      "value": 250,
      "min": 0,
      "max": 2000,
      "step": 50,
      "hint": {
        "en": "Line side only changes after the mower is clearly on the other side.",
        "de": "Die Linienseite wechselt erst, wenn der Mäher klar auf der anderen Seite ist."
      }
    },
    "garage_line_segment_margin_mm": {
      "id": "garage_line_segment_margin_mm",
      "type": "number",
      "label": {
        "en": "Safety line segment margin (mm)",
        "de": "Sicherheitslinien-Karenz A/B (mm)"
      },
      "value": 500,
      "min": 0,
      "max": 3000,
      "step": 50,
      "hint": {
        "en": "Only crossings on the A-B line segment plus this margin are accepted.",
        "de": "Nur Querungen auf dem Abschnitt A–B plus dieser Karenz werden ausgewertet."
      }
    },
    "garage_logging_enabled": {
      "id": "garage_logging_enabled",
      "type": "checkbox",
      "label": {
        "en": "Enable garage logging",
        "de": "Garagen-Logging aktivieren"
      },
      "value": false,
      "hint": {
        "en": "Shows normal, user-relevant garage events in the Homey timeline.",
        "de": "Zeigt normale, benutzerrelevante Garagenereignisse in der Homey-Zeitleiste."
      }
    },
    "garage_debug_verbose": {
      "id": "garage_debug_verbose",
      "type": "checkbox",
      "label": {
        "en": "Enable debug logging",
        "de": "Debug-Logging aktivieren"
      },
      "value": false,
      "hint": {
        "de": "Nur bei aktivem Garagenmodus und eingeschaltetem Garagen-Logging wirksam. Fügt interne Zustände und Diagnoseentscheidungen hinzu.",
        "en": "Only applies when garage mode and garage logging are both enabled. Adds detailed internal decisions."
      }
    },
    "garage_map_overlay_enabled": {
      "id": "garage_map_overlay_enabled",
      "type": "checkbox",
      "label": {
        "en": "Show garage overlay on map",
        "de": "Garagen-Overlay auf Karte anzeigen"
      },
      "value": false,
      "hint": {
        "en": "Draws safety line, danger area, maintenance point and caution zone on the map widget. Original map remains unchanged when disabled.",
        "de": "Zeichnet Sicherheitslinie, Gefahrenbereich, Wartungspunkt und Vorsichtszone im Karten-Widget. Bei deaktivierter Option bleibt die Karte unverändert."
      }
    },
    "garage_caution_radius_mm": {
      "id": "garage_caution_radius_mm",
      "type": "number",
      "label": {
        "en": "Caution zone radius (mm)",
        "de": "Vorsichtsbereich-Radius (mm)"
      },
      "value": 1800,
      "min": 0,
      "max": 10000,
      "step": 100,
      "hint": {
        "en": "Additional visual/diagnostic slow-care area around the garage. 0 disables it.",
        "de": "Zusätzlicher visueller/diagnostischer Vorsichtsbereich um die Garage. 0 deaktiviert ihn."
      }
    },
    "maintenance_point_1_name": {
      "id": "maintenance_point_1_name",
      "type": "text",
      "label": {
        "de": "Name Wartungspunkt 1",
        "en": "Point 1 name"
      },
      "value": "Haupt-Wartungspunkt",
      "hint": {
        "de": "Nur Anzeigetext. P1 ist standardmäßig Hauptpunkt; die Auswahl erfolgt separat oben.",
        "en": "Display name only. P1 is primary by default; selection is separate."
      }
    },
    "maintenance_point_2_name": {
      "id": "maintenance_point_2_name",
      "type": "text",
      "label": {
        "en": "Point 2 name",
        "de": "Name Wartungspunkt 2"
      },
      "value": "Rasenende",
      "hint": {
        "en": "Create point 2 in the MOVA/Dreame app first. Clear this name to hide its Homey button.",
        "de": "Wartungspunkt 2 zuerst in der MOVA/Dreame-App anlegen. Namen leeren, um den Homey-Button auszublenden."
      }
    },
    "maintenance_point_3_name": {
      "id": "maintenance_point_3_name",
      "type": "text",
      "label": {
        "en": "Point 3 name",
        "de": "Name Wartungspunkt 3"
      },
      "value": "",
      "hint": {
        "en": "Create point 3 in the MOVA/Dreame app first. Enter a name to show its Homey button.",
        "de": "Wartungspunkt 3 zuerst in der MOVA/Dreame-App anlegen. Einen Namen eintragen, um den Homey-Button einzublenden."
      }
    },
    "maintenance_point_4_name": {
      "id": "maintenance_point_4_name",
      "type": "text",
      "label": {
        "en": "Point 4 name",
        "de": "Name Wartungspunkt 4"
      },
      "value": "",
      "hint": {
        "en": "Create point 4 in the MOVA/Dreame app first. Enter a name to show its Homey button.",
        "de": "Wartungspunkt 4 zuerst in der MOVA/Dreame-App anlegen. Einen Namen eintragen, um den Homey-Button einzublenden."
      }
    },
    "maintenance_point_5_name": {
      "id": "maintenance_point_5_name",
      "type": "text",
      "label": {
        "en": "Point 5 name",
        "de": "Name Wartungspunkt 5"
      },
      "value": "",
      "hint": {
        "en": "Create point 5 in the MOVA/Dreame app first. Enter a name to show its Homey button.",
        "de": "Wartungspunkt 5 zuerst in der MOVA/Dreame-App anlegen. Einen Namen eintragen, um den Homey-Button einzublenden."
      }
    },
    "garage_mission_push_notifications": {
      "id": "garage_mission_push_notifications",
      "type": "checkbox",
      "label": {
        "de": "Garagenhinweise (optional)",
        "en": "Garage notices (optional)"
      },
      "value": false,
      "hint": {
        "de": "Optionale Hinweise für Ausfahrt, Rückkehr und Torbewegung über die Flow-Karte „Mäher-/Garagen-Hinweis“. Safety Block, Notfall und Wartungspunkt-Auswahl lösen dieselbe Karte immer aus, sobald der Garagenmodus aktiv ist. Den Token „Meldung“ mit einer Push-Aktion verbinden.",
        "en": "Optional departure, return and gate-movement notices via the “Mower / garage notice” Flow card. Safety Block, emergency and maintenance-point choice always trigger the same card when Garage Mode is enabled. Connect its Message token to a push action."
      }
    },
    "garage_show_safety_line": {
      "id": "garage_show_safety_line",
      "type": "checkbox",
      "label": {
        "en": "Show safety line on map",
        "de": "Sicherheitslinie in Karte anzeigen"
      },
      "value": true,
      "hint": {
        "en": "Only changes map visibility. The real safety line remains enforced when garage mode is on.",
        "de": "Ändert ausschließlich die Anzeige. Die reale Sicherheitslinie bleibt bei aktiviertem Garagenmodus wirksam."
      }
    },
    "garage_show_danger_area": {
      "id": "garage_show_danger_area",
      "type": "checkbox",
      "label": {
        "en": "Show danger area on map",
        "de": "Gefahrenbereich in Karte anzeigen"
      },
      "value": true,
      "hint": {
        "en": "Only changes map visibility. The configured danger zone stays active.",
        "de": "Ändert ausschließlich die Anzeige. Der konfigurierte Gefahrenbereich bleibt aktiv."
      }
    }
  }
};
const FIELDS=Object.freeze(CATALOG.fields);
const STORE_KEY='garage_repair_settings_v1';
const BACKUP_KEY='garage_repair_upgrade_backup_v2';
const AUDIT_KEY='garage_repair_upgrade_audit_v2';
// If a previously enabled garage has no recoverable copy of these values,
// alert the owner rather than silently treating defaults as their settings.
const SAFETY_CRITICAL_KEYS=Object.freeze([
  'garage_sensor_enabled', 'garage_open_duration_seconds', 'garage_close_duration_seconds',
  'garage_open_stabilize_seconds', 'garage_danger_radius_mm', 'garage_speed_source'
]);
function defaults(){return Object.fromEntries(Object.entries(FIELDS).map(([k,f])=>[k,f.value]));}
function validate(patch){
 if(!patch||typeof patch!=='object'||Array.isArray(patch))throw Error('Invalid settings payload');
 const out={};
 for(const [key,value] of Object.entries(patch)){
  const f=FIELDS[key]; if(!f)throw Error('Unknown garage setting: '+key);
  if(f.type==='checkbox'){if(typeof value!=='boolean')throw Error('Expected boolean for '+key);}
  else if(f.type==='number'){if(typeof value!=='number'||!Number.isFinite(value)||value<f.min||value>f.max||Math.abs((value-f.min)/f.step-Math.round((value-f.min)/f.step))>1e-6)throw Error('Invalid number for '+key);}
  else if(f.type==='dropdown'){if(typeof value!=='string'||!f.values.some(opt=>String(opt.id)===value))throw Error('Invalid option for '+key);}
  else if(f.type==='text'){if(typeof value!=='string'||value.length>80||/[\x00-\x1f\x7f]/.test(value))throw Error('Invalid text for '+key);}
  else throw Error('Unsupported field type: '+f.type);
  out[key]=value;
 }
 return out;
}
module.exports={CATALOG,FIELDS,STORE_KEY,BACKUP_KEY,AUDIT_KEY,SAFETY_CRITICAL_KEYS,defaults,validate};
