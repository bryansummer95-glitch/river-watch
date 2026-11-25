export const towns = {
  Clonmel: [52.352, -7.704, 'EI26', 'Suir'],
  Fermoy: [52.139, -8.226, 'EI04', 'Blackwater'],
  Mallow: [52.133, -8.643, 'EI04', 'Blackwater'],
  Bandon: [51.747, -8.689, 'EI04', 'Bandon'],
  Enniscorthy: [52.502, -6.563, 'EI30', 'Slaney'],
  Ennis: [52.845, -9.031, 'EI03', 'Fergus'],
  Athlone: [53.423, -7.993, 'EI29 EI24', 'Shannon'],
  'Carrick-on-Shannon': [53.945, -8.096, 'EI14 EI24', 'Shannon']
};

const areas = {
  Clonmel: ['Clonmel', 'Fermoy', 'Enniscorthy'],
  Mallow: ['Mallow', 'Fermoy', 'Bandon'],
  Athlone: ['Athlone', 'Carrick-on-Shannon', 'Ennis']
};

export const levels = ['Normal', 'Standby', 'Barriers'];
const severity = { yellow: 1, orange: 2, red: 3 };
const number = value => String(value ?? '').trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0;

export function parseSheet(csv) {
  const records = [[]];
  let field = '', quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (ch === '"' && quoted && csv[i + 1] === '"') {
      field += '"';
      i++;
    } else if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === ',' || ch === '\n')) {
      records.at(-1).push(field.replace(/\r$/, ''));
      field = '';
      if (ch === '\n') records.push([]);
    } else field += ch;
  }
  if (quoted) throw Error('Unclosed quote in Sheet CSV');
  records.at(-1).push(field.replace(/\r$/, ''));
  const headers = 'town,county,river,crew_based_here,barrier_sets,pumps,sandbags,staff_on_call,flow_override_m3s,warning_override,notes';
  if (records.shift().join(',').replace(/^\uFEFF/, '') !== headers) throw Error('Sheet column names or order changed');
  const result = {};
  for (const record of records.filter(row => row.some(Boolean))) {
    const row = Object.fromEntries(headers.split(',').map((key, i) => [key, record[i]?.trim()]));
    if (record.length !== 11 || !Object.hasOwn(towns, row.town) || Object.hasOwn(result, row.town) ||
        row.river !== towns[row.town][3] || !/^(yes|no)$/i.test(row.crew_based_here) ||
        !['barrier_sets', 'pumps', 'sandbags', 'staff_on_call'].every(key => number(row[key]) && Number.isInteger(Number(row[key]))) ||
        (row.flow_override_m3s && !number(row.flow_override_m3s)) || !/^(orange|red)?$/i.test(row.warning_override)) {
      throw Error('Invalid or duplicate Sheet row for ' + (row.town || 'unnamed town'));
    }
    result[row.town] = row;
  }
  if (Object.keys(result).length !== 8) throw Error('The Sheet must contain all eight towns');
  return result;
}

export function rainWarnings(feed, countyCodes, now) {
  return feed.filter(item => {
    if (String(item.type).trim().toLowerCase() !== 'rain') return false;
    const start = Date.parse(item.onset), end = Date.parse(item.expiry);
    if (!Array.isArray(item.regions) || !Number.isFinite(start) || !Number.isFinite(end) ||
        end < start || !severity[String(item.level).toLowerCase()]) throw Error('Invalid rain warning in national feed');
    return start <= now + 48 * 3600000 && end > now &&
      item.regions.some(code => countyCodes.includes(String(code).toUpperCase()));
  });
}

export function nightlyPlan(sheet, flows, history, warningFeed, now, scenario) {
  const rows = Object.keys(towns).map(town => {
    const row = sheet[town];
    const thresholds = history[town];
    const forecast = flows[town];
    const warnings = warningFeed === null ? null : rainWarnings(warningFeed, towns[town][2].split(' '), now);
    const flowSource = scenario?.town === town ? 'What-if scenario' : row.flow_override_m3s ? 'Sheet rehearsal' : 'Live forecast';
    const peak = flowSource === 'What-if scenario' ? scenario.flow : flowSource === 'Sheet rehearsal' ? Number(row.flow_override_m3s) : forecast?.peak;
    const warningOverride = row.warning_override.toLowerCase();
    const upgrade = Boolean(severity[warningOverride] >= 2 || warnings?.some(warning => severity[warning.level.toLowerCase()] >= 2));
    const base = !number(peak) || !thresholds ? null : peak >= thresholds.p99 ? 2 : peak >= thresholds.p95 ? 1 : 0;
    const target = base === null || (warnings === null && !upgrade && base < 2) ? null : Math.min(2, base + Number(upgrade));
    const barriers = Number(row.barrier_sets) > 0 && !/on loan|no barriers? available|barrier sets? unavailable/i.test(row.notes);
    const reason = target === null
      ? [!thresholds && 'historical thresholds unavailable', !number(peak) && 'forecast peak unavailable', warnings === null && 'warning feed unavailable'].filter(Boolean).join(', ')
      : levels[base] + ' from flow thresholds' + (upgrade ? ', orange/red rain warning applied' : ', no orange/red rain escalation');
    return { town, row, forecast, peak, flowSource, thresholds, warnings, warningOverride, target, barriers, reason };
  });

  const priority = rows.filter(row => row.target === 2 && row.barriers);
  const excess = row => row.thresholds.p99 > 0 ? (row.peak / row.thresholds.p99 - 1) * 100 : row.peak > 0 ? Infinity : 0;
  priority.sort((a, b) => excess(b) - excess(a) || b.peak - a.peak || a.town.localeCompare(b.town, 'en-IE'));
  const slots = Object.entries(areas).flatMap(([crew, area]) => {
    const row = sheet[crew];
    if (row.crew_based_here.toLowerCase() !== 'yes' || /crew unavailable|crew off duty/i.test(row.notes)) return [];
    const permitted = /can work in .* only|van in repair|local only/i.test(row.notes) ? [crew] : area;
    return [{ crew, permitted }, { crew, permitted }];
  });
  const assignments = new Map();
  function assign(town, seen) {
    for (const slot of slots) {
      if (seen.has(slot) || !slot.permitted.includes(town)) continue;
      seen.add(slot);
      if (!assignments.has(slot) || assign(assignments.get(slot), seen)) {
        assignments.set(slot, town);
        return true;
      }
    }
    return false;
  }
  for (const row of priority) assign(row.town, new Set());
  const crewByTown = new Map([...assignments].map(([slot, town]) => [town, slot.crew]));
  return rows.map(row => {
    const crew = crewByTown.get(row.town);
    const flagged = row.target === 2 && !crew;
    return { ...row, crew, flagged, level: row.target === null ? 'Undetermined' : levels[flagged ? 1 : row.target],
      reason: row.reason + (flagged ? (row.barriers ? '. No eligible crew place' : '. No available barrier set') + '. Flag to Area Manager' : ''),
      excess: row.target === 2 ? excess(row) : null };
  });
}

export const start = '2016-01-01';
export const end = '2025-12-31';
export function dateRange(first, last) {
  const dates = [];
  for (let time = Date.parse(first); time <= Date.parse(last); time += 86400000) dates.push(new Date(time).toISOString().slice(0, 10));
  return dates;
}

export function summarizeHistory(daily) {
  const calendar = dateRange(start, end);
  if (daily.time.length !== calendar.length || daily.river_discharge.length !== calendar.length ||
      !calendar.every((date, i) => date === daily.time[i] && typeof daily.river_discharge[i] === 'number' && number(daily.river_discharge[i]))) {
    throw Error('Incomplete or invalid daily discharge history');
  }
  const sorted = [...daily.river_discharge].sort((a, b) => a - b);
  const quantile = p => {
    const index = (sorted.length - 1) * p, low = Math.floor(index);
    return sorted[low] + (sorted[Math.ceil(index)] - sorted[low]) * (index - low);
  };
  const p99 = quantile(.99);
  const events = Object.fromEntries(Array.from({length: 9}, (_, i) => {
    const year = 2016 + i;
    let count = 0, previousHigh = false;
    const first = calendar.indexOf(year + '-10-01'), last = calendar.indexOf((year + 1) + '-03-31');
    for (let j = first; j <= last; j++) {
      const high = daily.river_discharge[j] >= p99;
      if (high && !previousHigh) count++;
      previousHigh = high;
    }
    return [year + '/' + String(year + 1).slice(-2), count];
  }));
  const counts = Object.values(events);
  const sum = values => values.reduce((total, count) => total + count, 0);
  return { days: sorted.length, median: quantile(.5), p95: quantile(.95), p99, events,
    total: sum(counts), firstFour: sum(counts.slice(0, 4)), lastFour: sum(counts.slice(-4)) };
}

export function floodUrl(town, historical = false) {
  const [latitude, longitude] = towns[town];
  const params = new URLSearchParams({latitude, longitude, daily: 'river_discharge', models: 'seamless_v4',
    ...(historical ? {start_date: start, end_date: end} : {forecast_days: 4, past_days: 1})});
  return 'https://flood-api.open-meteo.com/v1/flood?' + params;
}

