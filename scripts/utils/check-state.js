const fs = require('fs');
const t = fs.readFileSync('src/app/operate/watchers/WatchersManager.tsx', 'utf8');
console.log('import useT:', t.includes('useT'));
console.log('const { t }:', t.includes('const { t }'));
console.log('watchers.empty:', t.includes('watchers.empty'));
