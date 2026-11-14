// Requests that tell nothing about a defect: analytics, session replay vendors, ad pixels, beacons
// and inline data. They crowd the evidence and the HAR, so the collector never records them.

const HOSTS =
  /(^|\.)(google-analytics\.com|analytics\.google\.com|googletagmanager\.com|doubleclick\.net|segment\.(io|com)|mixpanel\.com|amplitude\.com|hotjar\.(com|io)|clarity\.ms|posthog\.com|plausible\.io|fullstory\.com|heapanalytics\.com|logrocket\.(io|com)|sentry\.io|datadoghq\.(com|eu)|bat\.bing\.com|licdn\.com|ads\.linkedin\.com|connect\.facebook\.net|vercel-insights\.com|intercom\.io|intercomcdn\.com|hs-analytics\.net|hubspot\.com)$/i;
const PATHS = /^\/(_vercel\/(speed-)?insights|g\/collect|j\/collect|r\/collect|collect|tr|api\/\d+\/envelope)\b/i;
/** Types the debugger reports for beacons and browser reports. */
const TYPES = new Set(['Ping', 'CSPViolationReport', 'beacon', 'ping', 'csp_report']);

export function isNoise(url: string, resourceType = '', postData = ''): boolean {
  if (TYPES.has(resourceType)) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return true;
  if (HOSTS.test(parsed.hostname) || PATHS.test(parsed.pathname)) return true;
  // PostHog behind a site's own proxy path (such as /api/phr or /ingest): its library adds these.
  const q = parsed.searchParams;
  if (q.has('ver') && (q.has('_') || q.has('compression'))) return true;
  return /"(distinct_id|\$lib|\$session_id)"\s*:|"api_key"\s*:\s*"phc_/.test(postData.slice(0, 4096));
}
