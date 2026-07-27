const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync('spamCrops.json', 'utf8'));

console.log('__dirname is:', __dirname);
console.log('');

const first = config[0];
const fullPath = path.join(__dirname, first.yield);
console.log('Config says:', first.yield);
console.log('Full path:', fullPath);
console.log('Exists:', fs.existsSync(fullPath));
console.log('');

console.log('Listing data/ folder:');
try {
  const items = fs.readdirSync(path.join(__dirname, 'data'));
  items.forEach(function(i){ console.log('  ' + i); });
} catch(e){
  console.log('  Cannot read data/:', e.message);
}

console.log('');
console.log('Listing data/Spam/ folder:');
try {
  const items = fs.readdirSync(path.join(__dirname, 'data', 'Spam'));
  items.forEach(function(i){ console.log('  ' + i); });
} catch(e){
  console.log('  Cannot read data/Spam/:', e.message);
}
