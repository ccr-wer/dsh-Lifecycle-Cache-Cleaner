// 从 app.asar 里取出指定文件的文本。
// 用法: node dsh-asar-extract.mjs <app.asar> <内部路径>
import fs from 'node:fs';

const [asar, wanted] = process.argv.slice(2);
const buf = fs.readFileSync(asar);
const headerPickleSize = buf.readUInt32LE(4);
const jsonLen = buf.readUInt32LE(12);
const tree = JSON.parse(buf.toString('utf8', 16, 16 + jsonLen));
const dataStart = 8 + headerPickleSize;

const find = (node, base) => {
  for (const [name, v] of Object.entries(node.files || {})) {
    const p = base ? `${base}/${name}` : name;
    if (v.files) {
      const hit = find(v, p);
      if (hit) return hit;
    } else if (p === wanted) {
      return v;
    }
  }
  return null;
};

const entry = find(tree, '');
if (!entry) {
  console.error(`not found: ${wanted}`);
  process.exit(1);
}
const start = dataStart + Number(entry.offset);
process.stdout.write(buf.toString('utf8', start, start + entry.size));
