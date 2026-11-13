'use strict';
// Deliberate interim release policy: while Garage Mode is enabled, PR1 does
// not have the full CORE external return interceptor or safe dock controller.
// Safe default is to withhold all automatic dock dispatch until PR2.
function returnHoldRequired(garageEnabled) { return garageEnabled === true; }
function interimReturnMessage(translate) {
  const de = 'PR1-Sicherheitsstopp: automatische Garagen-Rückkehr gesperrt. Mäher und Tor sofort vor Ort prüfen. Kein automatisches Fortsetzen.';
  const en = 'PR1 safety hold: automatic garage return disabled. Inspect mower and gate on site. No automatic resume.';
  return typeof translate === 'function' ? translate(de,en) : de;
}
module.exports = {returnHoldRequired,interimReturnMessage};
