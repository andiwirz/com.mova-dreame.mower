'use strict';
const sharp=require('sharp');const path=require('node:path');
function svg(type,dark){const bg=dark?'#1c2720':'#fff',fg=dark?'#c7ddcc':'#256943';let s=`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect x="48" y="48" width="928" height="928" rx="64" fill="${bg}"/>`;
 if(type==='camera'){s+=`<rect x="110" y="155" width="804" height="540" rx="40" fill="#172a20"/><path d="M160 640 360 365 525 550 655 400 865 640Z" fill="#598265"/><circle cx="730" cy="280" r="55" fill="#c7ddcc"/><rect x="395" y="760" width="234" height="98" rx="49" fill="${fg}"/><circle cx="565" cy="809" r="36" fill="${bg}"/>`;}
 else {s+=`<path d="M120 410V190L325 100 530 190V410Z" fill="none" stroke="${fg}" stroke-width="24"/><path d="M195 400V220H450V400M195 275H450M195 330H450" fill="none" stroke="${fg}" stroke-width="18"/><rect x="595" y="165" width="280" height="200" rx="24" fill="#172a20"/><circle cx="735" cy="265" r="52" fill="#598265"/>`;
 for(let i=0;i<9;i++)s+=`<rect x="${130+i*85}" y="480" width="85" height="300" fill="${i%2?'#609363':'#add39b'}"/>`;
 s+=`<rect x="135" y="825" width="190" height="65" rx="20" fill="${fg}"/><rect x="415" y="825" width="190" height="65" rx="20" fill="#9b322e"/><rect x="695" y="825" width="190" height="65" rx="20" fill="${fg}"/>`;}
 return s+'</svg>';}
(async()=>{for(const type of ['camera','overview'])for(const dark of [false,true])await sharp(Buffer.from(svg(type,dark))).png().toFile(path.join(__dirname,`../widgets/${type}/preview-${dark?'dark':'light'}.png`));})().catch(e=>{console.error(e);process.exitCode=1;});
