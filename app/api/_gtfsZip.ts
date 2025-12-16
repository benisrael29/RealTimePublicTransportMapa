import AdmZip from 'adm-zip';

export const GTFS_ZIP_URL = 'https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip';

let zipCache: AdmZip | null = null;
let zipFetchedAt = 0;
let inFlight: Promise<AdmZip> | null = null;

export async function getGtfsZip(revalidateSeconds: number): Promise<AdmZip> {
  const now = Date.now();
  const cacheMs = Math.max(60_000, revalidateSeconds * 1000);

  if (zipCache && (now - zipFetchedAt) < cacheMs) {
    return zipCache;
  }

  if (inFlight) {
    return inFlight;
  }

  inFlight = (async () => {
    const response = await fetch(GTFS_ZIP_URL, {
      headers: {
        'Accept': 'application/zip, application/x-zip-compressed, */*',
      },
      next: { revalidate: revalidateSeconds },
    });

    if (!response.ok) {
      throw new Error(`Failed to download GTFS ZIP: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const zip = new AdmZip(buffer);

    zipCache = zip;
    zipFetchedAt = Date.now();
    return zip;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}


