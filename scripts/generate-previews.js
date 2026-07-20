#!/usr/bin/env node
// Generates widget preview PNGs (1024x1024) following Athom guidelines:
// - Transparent background
// - No text
// - Simple shapes only
// - Shadow styles from Figma template
'use strict';

const sharp = require('sharp');
const path  = require('path');

// ─── Map widget ──────────────────────────────────────────────────────────────
// Shows: lawn polygon · zone areas · no-go zone · dock · robot · mow path
// No text anywhere.

function mapSvg(dark) {
  const card    = dark ? '#1C1C2E' : '#FFFFFF';
  const lawn    = dark ? '#2A4A2A' : '#C8E6C9';
  const lawnStr = dark ? '#3D6B3D' : '#81C784';
  const zone1   = dark ? '#1A3560' : '#BBDEFB';
  const z1str   = dark ? '#2979B0' : '#64B5F6';
  const zone2   = dark ? '#4A2E10' : '#FFE0B2';
  const z2str   = dark ? '#B06A29' : '#FFA726';
  const nogo    = dark ? '#4A1010' : '#FFCDD2';
  const nogoStr = dark ? '#B02929' : '#E57373';
  const dock    = dark ? '#3D7A3D' : '#388E3C';
  const robot   = '#E53935';
  const path_c  = dark ? '#4DB6AC' : '#009688';
  const shadow  = dark
    ? '0 12px 40px rgba(0,0,0,0.6)'
    : '0 8px 32px rgba(0,0,0,0.14)';
  const shadowFilter = dark
    ? '<feDropShadow dx="0" dy="12" stdDeviation="24" flood-color="rgba(0,0,0,0.6)"/>'
    : '<feDropShadow dx="0" dy="8"  stdDeviation="20" flood-color="rgba(0,0,0,0.14)"/>';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <filter id="s" x="-10%" y="-10%" width="120%" height="130%">
      ${shadowFilter}
    </filter>
    <clipPath id="card">
      <rect x="48" y="48" width="928" height="928" rx="48"/>
    </clipPath>
  </defs>

  <!-- Card -->
  <rect x="48" y="48" width="928" height="928" rx="48" fill="${card}" filter="url(#s)"/>

  <!-- Lawn polygon -->
  <polygon clip-path="url(#card)"
    points="130,210 510,155 850,195 900,710 700,850 180,840 110,630"
    fill="${lawn}" stroke="${lawnStr}" stroke-width="4"/>

  <!-- Zone 1 (upper-left, dashed border) -->
  <polygon clip-path="url(#card)"
    points="155,225 440,188 460,460 145,490"
    fill="${zone1}" stroke="${z1str}" stroke-width="3" stroke-dasharray="14,7" fill-opacity="0.85"/>

  <!-- Zone 2 (right, dashed border) -->
  <polygon clip-path="url(#card)"
    points="510,188 848,204 858,570 520,580"
    fill="${zone2}" stroke="${z2str}" stroke-width="3" stroke-dasharray="14,7" fill-opacity="0.85"/>

  <!-- No-go zone (small rectangle) -->
  <rect clip-path="url(#card)"
    x="590" y="600" width="180" height="130" rx="10"
    fill="${nogo}" stroke="${nogoStr}" stroke-width="3" stroke-dasharray="8,5" fill-opacity="0.9"/>
  <!-- X pattern inside no-go -->
  <line x1="606" y1="616" x2="754" y2="714" stroke="${nogoStr}" stroke-width="4" stroke-linecap="round"/>
  <line x1="754" y1="616" x2="606" y2="714" stroke="${nogoStr}" stroke-width="4" stroke-linecap="round"/>

  <!-- Mowing path (zigzag snake, no text) -->
  <polyline clip-path="url(#card)"
    points="170,475 215,450 260,472 305,447 350,470 395,445 440,468 440,410
            395,387 350,410 305,387 260,410 215,387 175,405
            175,345 220,322 265,345 310,322 355,345 400,322 440,345 440,287
            395,264 350,287 305,264 260,287 215,264 178,280"
    fill="none" stroke="${path_c}" stroke-width="7"
    stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>

  <!-- Dock (simple house: rect + triangle roof) -->
  <g clip-path="url(#card)" transform="translate(152,730)">
    <rect x="-24" y="-26" width="48" height="38" rx="5" fill="${dock}"/>
    <polygon points="-30,-26 0,-56 30,-26" fill="${dock}"/>
    <rect x="-10" y="-10" width="20" height="20" rx="3" fill="${dark ? '#1C1C2E' : 'white'}" opacity="0.85"/>
  </g>

  <!-- Robot marker (red circle with white centre) -->
  <circle clip-path="url(#card)" cx="265" cy="275" r="26" fill="${robot}"/>
  <circle clip-path="url(#card)" cx="265" cy="275" r="12" fill="white"/>
</svg>`;
}

// ─── History widget ───────────────────────────────────────────────────────────
// Shows: session picker bar · stat bars · lawn polygon + gradient path ·
//        photo thumbnail row — all as simple shapes, NO text.

function historySvg(dark) {
  const card    = dark ? '#1C1C2E' : '#FFFFFF';
  const pill    = dark ? '#2A2A44' : '#EEEEEE';   // placeholder bars / pills
  const lawn    = dark ? '#2A4A2A' : '#C8E6C9';
  const lawnStr = dark ? '#3D6B3D' : '#81C784';
  const photo   = dark ? '#252540' : '#E8E8E8';
  const dot     = dark ? '#4DB6AC' : '#009688';   // active carousel dot
  const dotOff  = dark ? '#333355' : '#CCCCCC';
  const shadowFilter = dark
    ? '<feDropShadow dx="0" dy="12" stdDeviation="24" flood-color="rgba(0,0,0,0.6)"/>'
    : '<feDropShadow dx="0" dy="8"  stdDeviation="20" flood-color="rgba(0,0,0,0.14)"/>';
  const gradStart = dark ? '#1565C0' : '#1E88E5';
  const gradEnd   = dark ? '#69F0AE' : '#00E676';
  const obst1 = '#EF5350'; // red = person
  const obst2 = '#78909C'; // grey = obstacle
  const obst3 = '#FFA726'; // orange = animal

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <filter id="s" x="-10%" y="-10%" width="120%" height="130%">
      ${shadowFilter}
    </filter>
    <clipPath id="card">
      <rect x="48" y="48" width="928" height="928" rx="48"/>
    </clipPath>
    <linearGradient id="pg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%"   stop-color="${gradStart}"/>
      <stop offset="100%" stop-color="${gradEnd}"/>
    </linearGradient>
  </defs>

  <!-- Card -->
  <rect x="48" y="48" width="928" height="928" rx="48" fill="${card}" filter="url(#s)"/>

  <!-- Session picker bar (rounded rectangle, no text) -->
  <rect clip-path="url(#card)"
    x="72" y="80" width="880" height="72" rx="14" fill="${pill}"/>
  <!-- Chevron indicator (small triangle shape on right) -->
  <polygon clip-path="url(#card)"
    points="894,108 914,108 904,124" fill="${dark ? '#555570' : '#AAAAAA'}"/>

  <!-- Stat row 1 (shorter pills representing metadata) -->
  <rect clip-path="url(#card)" x="72"  y="172" width="160" height="22" rx="11" fill="${pill}"/>
  <rect clip-path="url(#card)" x="248" y="172" width="120" height="22" rx="11" fill="${pill}"/>
  <rect clip-path="url(#card)" x="384" y="172" width="140" height="22" rx="11" fill="${pill}"/>
  <rect clip-path="url(#card)" x="540" y="172" width="160" height="22" rx="11" fill="${pill}"/>
  <rect clip-path="url(#card)" x="716" y="172" width="80"  height="22" rx="11" fill="${pill}"/>

  <!-- Mini-map area (lawn polygon) -->
  <rect clip-path="url(#card)" x="72" y="210" width="880" height="470" rx="14" fill="${lawn}"/>
  <polygon clip-path="url(#card)"
    points="120,250 530,225 900,255 892,630 680,660 112,648"
    fill="${lawn}" stroke="${lawnStr}" stroke-width="3"/>

  <!-- Mowing trajectory (gradient zigzag — time progress from blue→green) -->
  <polyline clip-path="url(#card)"
    points="152,630 196,606 240,628 284,603 328,626 372,601 416,624 460,599 504,622 548,597 548,552
            504,575 460,550 416,574 372,549 328,572 284,547 240,570 200,548 158,564
            158,516 200,492 244,516 288,491 332,515 376,490 420,514 464,489 508,513 548,490
            548,440 508,463 464,438 420,462 376,437 332,461 288,436 244,460 200,435 162,455
            162,405 206,380 250,404 294,379 338,403 382,378 420,400"
    fill="none" stroke="url(#pg)" stroke-width="6"
    stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>

  <!-- Path start dot -->
  <circle clip-path="url(#card)" cx="420" cy="400" r="12" fill="white" stroke="${gradStart}" stroke-width="3"/>
  <!-- Dock ring -->
  <circle clip-path="url(#card)" cx="148" cy="640" r="20" fill="none" stroke="white" stroke-width="4"/>
  <circle clip-path="url(#card)" cx="148" cy="640" r="9"  fill="white" opacity="0.6"/>

  <!-- Obstacle dots (coloured circles on path) -->
  <circle clip-path="url(#card)" cx="464" cy="530" r="14" fill="${obst1}" opacity="0.9"/>
  <circle clip-path="url(#card)" cx="300" cy="590" r="14" fill="${obst2}" opacity="0.9"/>
  <circle clip-path="url(#card)" cx="548" cy="460" r="14" fill="${obst3}" opacity="0.9"/>

  <!-- Photo thumbnail row (4 simple rectangles) -->
  <rect clip-path="url(#card)" x="72"  y="702" width="200" height="164" rx="12" fill="${photo}"/>
  <rect clip-path="url(#card)" x="286" y="702" width="200" height="164" rx="12" fill="${photo}"/>
  <rect clip-path="url(#card)" x="500" y="702" width="200" height="164" rx="12" fill="${photo}"/>
  <rect clip-path="url(#card)" x="714" y="702" width="236" height="164" rx="12" fill="${photo}"/>

  <!-- Carousel dots -->
  <circle clip-path="url(#card)" cx="486" cy="900" r="8"  fill="${dot}"/>
  <circle clip-path="url(#card)" cx="514" cy="900" r="6"  fill="${dotOff}"/>
  <circle clip-path="url(#card)" cx="538" cy="900" r="6"  fill="${dotOff}"/>
  <circle clip-path="url(#card)" cx="562" cy="900" r="6"  fill="${dotOff}"/>
</svg>`;
}

// ─── Write PNGs ───────────────────────────────────────────────────────────────

async function main() {
  const jobs = [
    { svg: mapSvg(false),     out: 'widgets/map/preview-light.png'     },
    { svg: mapSvg(true),      out: 'widgets/map/preview-dark.png'      },
    { svg: historySvg(false), out: 'widgets/history/preview-light.png' },
    { svg: historySvg(true),  out: 'widgets/history/preview-dark.png'  },
  ];

  for (const { svg, out } of jobs) {
    const outPath = path.join(__dirname, '..', out);
    await sharp(Buffer.from(svg))
      .png()
      .toFile(outPath);
    console.log('✓', out);
  }
  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
