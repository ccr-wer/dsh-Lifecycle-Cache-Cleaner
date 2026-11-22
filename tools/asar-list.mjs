// 列出 app.asar 内路径（按正则筛选）。
// 用法: node dsh-asar-list.mjs <app.asar> <regex> [limit]
import fs from 'node:fs';

const [asar, pattern, limitArg] = process.argv.slice(2);
const limit = Number(limitArg ?? 80);
const re = new RegExp(pattern);

const buf = fs.readFileSync(asar);
const headerPickleSize = buf.readUInt32LE(4);
const jsonLen = buf.readUInt32LE(12);
const tree = JSON.parse(buf.toString('utf8', 16, 16 + jsonLen));

const out = [];
const walk = (node, base) => {
  for (const [name, v] of Object.entries(node.files || {})) {
    const p = base ? `${base}/${name}` : name;
    if (v.files) walk(v, p);
    else if (re.test(p) && out.length < limit) out.push(p);
  }
};
walk(tree, '');
console.log(`${out.length} 条`);
for (const p of out) console.log(p);
