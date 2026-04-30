'use strict';

const Homey = require('homey');

class DreameApp extends Homey.App {
  async onInit() {
    this.log('MOVA & Dreame Mower app started');
  }
}

module.exports = DreameApp;
