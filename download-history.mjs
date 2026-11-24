import { mkdir, writeFile } from 'node:fs/promises';
import { floodUrl, towns, summarizeHistory, start, end } from './plan.mjs';

const output = new URL('./history.json', import.meta.url);
const raw = new URL('./history-raw/', import.meta.url);
await mkdir(raw, {recursive:true});
const summaries = {};
for (const town of Object.keys(towns)) {
  const source = floodUrl(town, true);
  try {
    const response = await fetch(source, {signal:AbortSignal.timeout(20000)});
    if (!response.ok) throw Error('HTTP ' + response.status);
    const input = await response.json();
    const summary = summarizeHistory(input.daily);
    await writeFile(new URL(encodeURIComponent(town) + '.json', raw), JSON.stringify(input));
    summaries[town] = { ...summary, source, requested:towns[town].slice(0,2), grid:[input.latitude,input.longitude] };
    console.log(town, summary.days, summary.p99, summary.total);
  } catch (error) {
    console.error(town + ': ' + error.message + (error.cause ? ' · ' + error.cause.message : ''));
    process.exitCode = 1;
  }
}
if (!process.exitCode) await writeFile(output, JSON.stringify({start, end, model:'seamless_v4', retrieved:new Date().toISOString(),
  reachVerification:'Unverified model cells. Compare against independent river evidence before relying on these figures.', towns:summaries}, null, 2) + '\n');

