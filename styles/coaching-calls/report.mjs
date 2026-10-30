#!/usr/bin/env node
// Writes the ranked clip report (the clip-selection prompt's format) from clips.json + analysis.json.
//   node report.mjs   (run in the video's project folder)
// analysis.json: { clips: { c01: { rank, score, type, why, scores: [hook, relate, edu, tension, payoff, standalone, viral], notes: [] } },
//   groups: { must: [], edu: [], psych: [], relatable: [], debate: [] }, series: [[name, text]] }
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const cfg = JSON.parse(readFileSync('clips.json', 'utf8'));
const A = JSON.parse(readFileSync('analysis.json', 'utf8'));
const words = JSON.parse(readFileSync('assets/raw.json', 'utf8')).words;
const text = (s, e) => words.filter((w) => w.start >= s - 0.01 && w.end <= e + 0.01).map((w) => w.text.trim()).join(' ');
const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const dur = (c) => {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', `renders/${c.id}.mp4`], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return `${Math.round(Number(r.stdout))} s (edited clip)`;
  return `about ${Math.round(c.segs.reduce((n, [s, e]) => n + e - s, 0) * 0.88)} s after tight cuts`;
};
const label = ['Hook strength', 'Trader relatability', 'Educational value', 'Emotional tension', 'Payoff', 'Standalone quality', 'Viral/comment potential'];
const byId = Object.fromEntries(cfg.clips.map((c) => [c.id, c]));
const ranked = Object.entries(A.clips).sort((a, b) => a[1].rank - b[1].rank);
const name = (id) => `#${A.clips[id].rank} ${byId[id].hook.join(' ')}`;

let md = `# ${cfg.name}: clip report\n\nRanked with \`styles/coaching-calls/clip-selection-prompt.md\`. Every clip is at least 60 seconds.\n` +
  `Files: \`outbox/${cfg.name}/${cfg.name}-NN-<topic>-${cfg.version ?? 'v1'}.mp4\` (NN is the clip id below).\n\n`;
for (const [id, a] of ranked) {
  const c = byId[id];
  const cap = (t) => t.split(" ").slice(0, 22).join(" ") + (t.split(" ").length > 22 ? " ..." : "");
  const first = text(...c.segs[0].slice(0, 2)), last = text(...c.segs.at(-1).slice(0, 2));
  md += `## Clip #${a.rank} (${id}, ${c.slug})\n\n**Score:** ${a.score}/10  \n**Hook type:** ${a.type}  \n` +
    `**Suggested hook (on screen):** ${c.hook.join(' / ')}  \n**Estimated duration:** ${dur(c)}\n\n` +
    `**Start:** "${cap(first.split(/(?<=[.?!])\s/)[0])}"  \n**End:** "${cap(last.split(/(?<=[.?!])\s/).at(-1))}"\n\n` +
    `**Exact transcript** (source times; parts in the order they play):\n\n` +
    c.segs.map(([s, e]) => `> [${mmss(s)}-${mmss(e)}] ${text(s, e)}`).join('\n>\n') + '\n\n' +
    `**Why this works:** ${a.why}\n\n` + label.map((l, i) => `${l}: ${a.scores[i]}/10`).join('  \n') + '\n\n' +
    `**Editing notes:**\n\n${a.notes.map((n) => `- ${n}`).join('\n')}\n\n`;
}
const G = A.groups;
md += `## Groups\n\n` +
  `**🔥 MUST CLIP:** ${G.must.map(name).join('; ')}\n\n` +
  `**💰 HIGH-VALUE EDUCATIONAL:** ${G.edu.map(name).join('; ')}\n\n` +
  `**🧠 PSYCHOLOGY:** ${G.psych.map(name).join('; ')}\n\n` +
  `**🎯 RELATABLE TRADER PROBLEMS:** ${G.relatable.map(name).join('; ')}\n\n` +
  `**⚡ CONTROVERSIAL / DEBATABLE:** ${G.debate.map(name).join('; ')}\n\n` +
  `## 5 recurring trader problems (series ideas)\n\n${A.series.map(([n, t], i) => `${i + 1}. **${n}**: ${t}`).join('\n')}\n` +
  (A.extra?.length ? `\n## Editor's notes\n\n${A.extra.map((x) => `- ${x}`).join('\n')}\n` : '');
const out = `../../../outbox/${cfg.name}/${cfg.name}-clip-report.md`;
writeFileSync(out, md);
console.log('wrote', out);
