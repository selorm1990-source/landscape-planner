const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync('spamCrops.json', 'utf8'));

let found = 0;
let missing = 0;

config.forEach(function(c){
  const yPath = path.join(__dirname, c.yield);
  const aPath = path.join(__dirname, c.area);
  const yExists = fs.existsSync(yPath);
  const aExists = fs.existsSync(aPath);

  if (yExists && aExists){
    found++;
  } else {
    console.log('MISSING: ' + c.crop);
    if (yExists === false) console.log('  yield: ' + c.yield);
    if (aExists === false) console.log('  area:  ' + c.area);
    missing++;
  }
});

console.log('');
console.log('Found: ' + found);
console.log('Missing: ' + missing);
