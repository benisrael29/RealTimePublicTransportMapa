import { getGtfsZip } from './_gtfsZip';

type CalendarRow = {
  serviceId: string;
  startDate: number;
  endDate: number;
  days: {
    monday: boolean;
    tuesday: boolean;
    wednesday: boolean;
    thursday: boolean;
    friday: boolean;
    saturday: boolean;
    sunday: boolean;
  };
};

let calendarCache: Map<string, CalendarRow> | null = null;
let addedByDateCache: Map<number, Set<string>> | null = null;
let removedByDateCache: Map<number, Set<string>> | null = null;
let feedTimeZoneCache: string | null = null;
let cacheTimestamp = 0;
const CACHE_DURATION = 86400000;

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function parseYyyyMmDdToNumber(s: string): number | null {
  const t = s.replace(/^"|"$/g, '').trim();
  if (!/^\d{8}$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function pickTzFromAgencyTxt(text: string): string | null {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return null;
  const headers = parseCSVLine(lines[0]);
  const tzIndex = headers.indexOf('agency_timezone');
  if (tzIndex === -1) return null;
  const first = parseCSVLine(lines[1]);
  if (first.length <= tzIndex) return null;
  const tz = first[tzIndex].replace(/^"|"$/g, '').trim();
  return tz || null;
}

async function ensureCalendarLoaded() {
  const now = Date.now();
  if (
    calendarCache &&
    addedByDateCache &&
    removedByDateCache &&
    feedTimeZoneCache &&
    now - cacheTimestamp < CACHE_DURATION
  ) {
    return;
  }

  const zip = await getGtfsZip(86400);

  if (!feedTimeZoneCache) {
    const agencyEntry = zip.getEntry('agency.txt');
    if (agencyEntry) {
      const tz = pickTzFromAgencyTxt(agencyEntry.getData().toString('utf8'));
      feedTimeZoneCache = tz || 'Australia/Brisbane';
    } else {
      feedTimeZoneCache = 'Australia/Brisbane';
    }
  }

  const calMap = new Map<string, CalendarRow>();
  const addedByDate = new Map<number, Set<string>>();
  const removedByDate = new Map<number, Set<string>>();

  const calendarEntry = zip.getEntry('calendar.txt');
  if (calendarEntry) {
    const text = calendarEntry.getData().toString('utf8');
    const lines = text.split('\n').filter((l) => l.trim());
    if (lines.length > 0) {
      const headers = parseCSVLine(lines[0]);
      const serviceIdIndex = headers.indexOf('service_id');
      const startIndex = headers.indexOf('start_date');
      const endIndex = headers.indexOf('end_date');
      const monIndex = headers.indexOf('monday');
      const tueIndex = headers.indexOf('tuesday');
      const wedIndex = headers.indexOf('wednesday');
      const thuIndex = headers.indexOf('thursday');
      const friIndex = headers.indexOf('friday');
      const satIndex = headers.indexOf('saturday');
      const sunIndex = headers.indexOf('sunday');

      if (
        serviceIdIndex !== -1 &&
        startIndex !== -1 &&
        endIndex !== -1 &&
        monIndex !== -1 &&
        tueIndex !== -1 &&
        wedIndex !== -1 &&
        thuIndex !== -1 &&
        friIndex !== -1 &&
        satIndex !== -1 &&
        sunIndex !== -1
      ) {
        for (let i = 1; i < lines.length; i++) {
          const values = parseCSVLine(lines[i].trim());
          const maxIndex = Math.max(
            serviceIdIndex,
            startIndex,
            endIndex,
            monIndex,
            tueIndex,
            wedIndex,
            thuIndex,
            friIndex,
            satIndex,
            sunIndex
          );
          if (values.length <= maxIndex) continue;
          const serviceId = values[serviceIdIndex].replace(/^"|"$/g, '').trim();
          const startDate = parseYyyyMmDdToNumber(values[startIndex]);
          const endDate = parseYyyyMmDdToNumber(values[endIndex]);
          if (!serviceId || startDate === null || endDate === null) continue;
          const toBool = (v: string) => v.replace(/^"|"$/g, '').trim() === '1';
          calMap.set(serviceId, {
            serviceId,
            startDate,
            endDate,
            days: {
              monday: toBool(values[monIndex]),
              tuesday: toBool(values[tueIndex]),
              wednesday: toBool(values[wedIndex]),
              thursday: toBool(values[thuIndex]),
              friday: toBool(values[friIndex]),
              saturday: toBool(values[satIndex]),
              sunday: toBool(values[sunIndex]),
            },
          });
        }
      }
    }
  }

  const datesEntry = zip.getEntry('calendar_dates.txt');
  if (datesEntry) {
    const text = datesEntry.getData().toString('utf8');
    const lines = text.split('\n').filter((l) => l.trim());
    if (lines.length > 0) {
      const headers = parseCSVLine(lines[0]);
      const serviceIdIndex = headers.indexOf('service_id');
      const dateIndex = headers.indexOf('date');
      const exIndex = headers.indexOf('exception_type');
      if (serviceIdIndex !== -1 && dateIndex !== -1 && exIndex !== -1) {
        for (let i = 1; i < lines.length; i++) {
          const values = parseCSVLine(lines[i].trim());
          const maxIndex = Math.max(serviceIdIndex, dateIndex, exIndex);
          if (values.length <= maxIndex) continue;
          const serviceId = values[serviceIdIndex].replace(/^"|"$/g, '').trim();
          const date = parseYyyyMmDdToNumber(values[dateIndex]);
          const ex = Number(values[exIndex].replace(/^"|"$/g, '').trim());
          if (!serviceId || date === null || !Number.isFinite(ex)) continue;
          const add = ex === 1;
          const remove = ex === 2;
          if (!add && !remove) continue;
          const target = add ? addedByDate : removedByDate;
          const set = target.get(date);
          if (set) set.add(serviceId);
          else target.set(date, new Set([serviceId]));
        }
      }
    }
  }

  calendarCache = calMap;
  addedByDateCache = addedByDate;
  removedByDateCache = removedByDate;
  cacheTimestamp = now;
}

export async function getFeedTimeZone(): Promise<string> {
  await ensureCalendarLoaded();
  return feedTimeZoneCache || 'Australia/Brisbane';
}

export function getLocalDateParts(ms: number, timeZone: string): {
  dateNumber: number;
  weekdayKey: keyof CalendarRow['days'];
  secondsSinceMidnight: number;
} {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(ms));
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const year = pick('year');
  const month = pick('month');
  const day = pick('day');
  const weekday = pick('weekday').toLowerCase();
  const hour = Number(pick('hour'));
  const minute = Number(pick('minute'));
  const second = Number(pick('second'));
  const dateNumber = Number(`${year}${month}${day}`);
  const weekdayKey =
    weekday.startsWith('mon')
      ? 'monday'
      : weekday.startsWith('tue')
        ? 'tuesday'
        : weekday.startsWith('wed')
          ? 'wednesday'
          : weekday.startsWith('thu')
            ? 'thursday'
            : weekday.startsWith('fri')
              ? 'friday'
              : weekday.startsWith('sat')
                ? 'saturday'
                : 'sunday';
  const secondsSinceMidnight = hour * 3600 + minute * 60 + second;
  return {
    dateNumber: Number.isFinite(dateNumber) ? dateNumber : 0,
    weekdayKey,
    secondsSinceMidnight: Number.isFinite(secondsSinceMidnight) ? secondsSinceMidnight : 0,
  };
}

export async function getActiveServiceIdsForDate(dateNumber: number, weekdayKey: keyof CalendarRow['days']) {
  await ensureCalendarLoaded();
  const cal = calendarCache || new Map<string, CalendarRow>();
  const addedByDate = addedByDateCache || new Map<number, Set<string>>();
  const removedByDate = removedByDateCache || new Map<number, Set<string>>();

  const active = new Set<string>();
  for (const [serviceId, row] of cal.entries()) {
    if (dateNumber < row.startDate || dateNumber > row.endDate) continue;
    if (!row.days[weekdayKey]) continue;
    active.add(serviceId);
  }

  const removed = removedByDate.get(dateNumber);
  if (removed) {
    for (const sid of removed.values()) active.delete(sid);
  }
  const added = addedByDate.get(dateNumber);
  if (added) {
    for (const sid of added.values()) active.add(sid);
  }
  return active;
}





