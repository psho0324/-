// renderer/ 폴더를 브라우저 테스트용 단일 페이지(tools/browser-tests/preview/index.html)로 합칩니다.
// (예시 데이터 preview-seed.js가 함께 들어가요. 실제 앱에는 포함되지 않습니다.)
// 사용: node tools/browser-tests/build-preview.js
const fs = require('fs');
const path = require('path');

const src = process.argv[2] || path.join(__dirname, '..', '..', 'renderer');
const out = process.argv[3] || path.join(__dirname, 'preview');
fs.mkdirSync(out, { recursive: true });
const read = (f) => fs.readFileSync(path.join(src, f), 'utf8');

const html = read('index.html');
const bodyInner = html.split('<body>')[1].split('<script src=')[0].trim();

const scripts = [
  read('recurrence.js'),
  read('holidays.js'),
  read('quickadd.js'),
  read('storage.js'),
  fs.readFileSync(path.join(__dirname, 'preview-seed.js'), 'utf8'),
  read('app.js'),
];
for (const s of scripts) {
  if (/<\/script/i.test(s)) throw new Error('스크립트 안에 </script 가 있어 인라인할 수 없어요');
}

const page = `<meta charset="utf-8">
<link rel="icon" href="data:,">
<title>내 플래너</title>
<style>
${read('styles.css')}
</style>

${bodyInner}

<script>
${scripts.join('\n</script>\n<script>\n')}
</script>
`;

fs.writeFileSync(path.join(out, 'index.html'), page);
fs.writeFileSync(path.join(out, 'all-scripts.check.js'), scripts.join('\n;\n'));
console.log('built', page.length, 'bytes');
