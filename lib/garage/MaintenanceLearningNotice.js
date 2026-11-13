'use strict';
// Human-facing feedback, independent from the future central notice router.
// Never sends a mower, garage, or map command.
const {setTimeout: delay} = require('node:timers');
class MaintenanceLearningNotice {
  constructor(device, log=()=>{}) { this.device=device; this.log=log; this.last=null; }
  language() { return String(this.device.homey?.i18n?.getLanguage?.() || 'de').toLowerCase().startsWith('de') ? 'de' : 'en'; }
  async show(type, point, detail='') {
    const i=Number(point);
    if(!Number.isInteger(i)||i<2||i>5) return false;
    const texts={
      prepared:{de:`P${i}: Tor bereit. P${i} jetzt innerhalb von 15 Minuten in MOVA anfahren.`,en:`P${i}: Gate ready. Drive to P${i} in MOVA within 15 minutes.`},
      blocked:{de:`P${i}: Anlernen nicht gestartet; Torfreigabe fehlt.`,en:`P${i}: Learning not started; gate release unavailable.`},
      observed:{de:`P${i}: MOVA-Fahrt erkannt. Warte auf eindeutige Ankunft.`,en:`P${i}: MOVA trip detected. Waiting for verified arrival.`},
      uncertain:{de:`P${i}: Ankunft nicht eindeutig bestätigt. Keine P${i}-Fahrt freigegeben.`,en:`P${i}: Arrival not verified. P${i} travel remains blocked.`},
      positionObserved:{de:`P${i}: Ankunftsposition auf Karte vorgemerkt. MOVA-Zielnummer fehlt; Homey-Anfahrt weiterhin gesperrt.`,en:`P${i}: Arrival position shown on map. MOVA target number missing; Homey travel still blocked.`},
      confirmed:{de:`P${i}: Position bestätigt und gespeichert.`,en:`P${i}: Position verified and saved.`},
      expired:{de:`P${i}: Anlernzeit abgelaufen. Bitte erneut starten.`,en:`P${i}: Learning window expired. Start again.`},
    };
    const value=texts[type]?.[this.language()]; if(!value)return false;
    if (this.last?.type === type && this.last.point === i && Date.now()-this.last.at < 30000) return true;
    this.last={type,point:i,at:Date.now(),detail};
    this.log(`[maintenance-feedback] ${type} P${i}${detail?` ${String(detail).slice(0,100)}`:''}`);
    try {
      if(!this.device.hasCapability?.('maintenance_learning_status')) await this.device.addCapability?.('maintenance_learning_status');
      await this.device.setCapabilityValue?.('maintenance_learning_status',value);
      return true;
    } catch(e) {this.log(`[maintenance-feedback] capability: ${e.message}`);return false;}
  }
}
module.exports={MaintenanceLearningNotice};
