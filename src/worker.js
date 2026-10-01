// SproutScore public MCP server (Streamable HTTP).
// Read-only query access to NYC DOHMH childcare-center inspection data.
// Data window: 2020-05-29 to 2023-04-24. The city has not published newer
// daycare inspection rows since April 2023. Every tool and response carries
// that caveat. No email, no payments, no PII collection. Read-only tools.
import { DATA_META, CENTERS } from "./data.js";
import { CODE_META, CODES, FAMILIES } from "./codes.js";

const SERVER_NAME = "sproutscore-mcp";
const SERVER_VERSION = "1.0.0";
const PROTOCOL_VERSION = "2025-06-18";

const DATA_CAVEAT =
  "Inspection history: 2020-2023. The city has not published newer NYC daycare " +
  "inspection data since April 2023 - always confirm current conditions on a tour.";
const DECODE_CAVEAT =
  "Plain-English violation decodes are AI-seeded and pending human review - not expert-verified.";

// Positional column contracts (must match pack.py)
const C = { ID: 0, NAME: 1, BOROUGH: 2, ADDR: 3, ZIP: 4, CCTYPE: 5, INSP: 6, FLAG: 7, LAST: 8, RATE: 9, VIOL: 10 };
const V = { CODE: 0, N: 1, DATES: 2, CAT: 3, STATUSES: 4 };
const K = { PE: 0, SEV: 1, FAM: 2, TOUR: 3, CATMAX: 4, CORR: 5, OPEN: 6 };

const SEV_RANK = { critical: 0, major: 1, minor: 2 };
const BOROUGH_ALIASES = {
  "BROOKLYN": "BROOKLYN", "BKLYN": "BROOKLYN", "BK": "BROOKLYN",
  "QUEENS": "QUEENS", "QNS": "QUEENS", "QN": "QUEENS",
  "BRONX": "BRONX", "BX": "BRONX",
  "MANHATTAN": "MANHATTAN", "MN": "MANHATTAN", "MANH": "MANHATTAN", "NY": "MANHATTAN",
  "STATEN ISLAND": "STATEN ISLAND", "SI": "STATEN ISLAND",
};

// ---------- light per-IP rate limiting (best-effort, per isolate) ----------
const RATE_LIMIT = 60; // requests per window
const RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map();
function rateLimitCheck(ip) {
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b || now - b.start > RATE_WINDOW_MS) {
    b = { start: now, count: 0 };
    rateBuckets.set(ip, b);
  }
  b.count += 1;
  if (b.count > RATE_LIMIT) {
    return Math.ceil((b.start + RATE_WINDOW_MS - now) / 1000);
  }
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) {
      if (now - v.start > RATE_WINDOW_MS) rateBuckets.delete(k);
      if (rateBuckets.size <= 4000) break;
    }
  }
  return 0;
}

// ---------- data helpers ----------
function cohortAvg(childCareType) {
  const raw = DATA_META.cohort_avg_violation_rate_pct[childCareType];
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : DATA_META.global_flagged_rate_pct;
}

function verdictFor(center) {
  const avg = cohortAvg(center[C.CCTYPE]);
  const rate = Number(center[C.RATE]) || 0;
  let verdict, plain;
  if (center[C.INSP] < 3) {
    verdict = "too_few_inspections";
    plain = `Only ${center[C.INSP]} inspection(s) on record - too few to judge a pattern. Treat this as a starting point, not a verdict.`;
  } else if (rate < 0.8 * avg) {
    verdict = "below_average";
    plain = `Flagged at ${rate}% vs ~${avg}% NYC average for ${center[C.CCTYPE]} - below average.`;
  } else if (rate <= 1.2 * avg) {
    verdict = "near_average";
    plain = `Flagged at ${rate}% vs ~${avg}% NYC average for ${center[C.CCTYPE]} - near average.`;
  } else {
    verdict = "above_average";
    plain = `Flagged at ${rate}% vs ~${avg}% NYC average for ${center[C.CCTYPE]} - above average.`;
  }
  return { center_violation_rate_pct: rate, nyc_avg_pct: avg, verdict, plain };
}

function sproutGrade(center) {
  if (center[C.INSP] < 3) {
    return { grade: "N/A", basis: "too few inspections (<3) for a stable comparison" };
  }
  const avg = cohortAvg(center[C.CCTYPE]);
  const rate = Number(center[C.RATE]) || 0;
  const ratio = avg > 0 ? rate / avg : 0;
  const grade = ratio <= 0.5 ? "A" : ratio <= 0.8 ? "B" : ratio <= 1.2 ? "C" : ratio <= 1.8 ? "D" : "F";
  return {
    grade,
    basis: `SproutScore comparison grade: center flagged rate ${rate}% vs NYC cohort average ${avg}% (${center[C.CCTYPE]}). Not a city rating.`,
  };
}

function decodeCode(code) {
  const e = CODES[code];
  if (!e) return null;
  const famLabel = FAMILIES[e[K.FAM]] ? FAMILIES[e[K.FAM]][0] : e[K.FAM];
  const corr = e[K.CORR], open = e[K.OPEN];
  const statusPlain = open > 0
    ? `Across ${corr + open} citywide citation(s) of this code: ${corr} marked CORRECTED, ${open} marked OPEN (no correction recorded by the city's last data update, 2023-04-24). OPEN does not prove it is still broken today.`
    : `Across ${corr} citywide citation(s) of this code, all marked CORRECTED (the city recorded that it was fixed).`;
  return {
    code,
    plain_english: e[K.PE],
    severity: e[K.SEV],
    severity_meaning: CODE_META.severity_tiers[e[K.SEV]] || "",
    category: famLabel,
    city_category_max: e[K.CATMAX],
    tour_question: e[K.TOUR],
    status_plain: statusPlain,
    decode_caveat: DECODE_CAVEAT,
  };
}

function statusPlainForCenter(statuses) {
  if (statuses.length === 1 && statuses[0] === "CORRECTED") {
    return "City records show the violation was corrected.";
  }
  if (statuses.includes("OPEN")) {
    return "No correction recorded by the city's last data update (April 2023). Does NOT prove it is still broken today.";
  }
  return "City status recorded as: " + statuses.join(", ") + ".";
}

function findCenter(id) {
  const needle = String(id || "").trim().toUpperCase();
  return CENTERS.find((c) => c[C.ID].toUpperCase() === needle) || null;
}

// ---------- tools ----------
const TOOLS = [
  {
    name: "search_centers",
    description:
      "Search NYC childcare centers by name substring and/or borough. " +
      "Returns matching centers (id, name, borough, address, inspection count, flagged count, SproutScore comparison grade). " +
      "DATA CAVEAT: inspection data covers 2020-2023 only; the city has not published newer daycare inspection data since April 2023.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Name substring, e.g. 'jackson'. Case-insensitive." },
        borough: { type: "string", description: "Borough: Brooklyn, Queens, Bronx, Manhattan, or Staten Island (aliases like BK, BX, QNS, MN, SI accepted)." },
        limit: { type: "integer", description: "Max results, default 10, max 50." },
      },
    },
  },
  {
    name: "get_center_report",
    description:
      "Get a decoded inspection summary for one center by its center_id (e.g. 'DC1000'): violation counts vs the NYC cohort average, top violations decoded into plain English with severity and inspection dates. " +
      "DATA CAVEAT: data as of 2020-2023; the city has not published newer daycare inspection data since April 2023. " +
      "Violation decodes are AI-seeded, pending human review - not expert-verified.",
    inputSchema: {
      type: "object",
      properties: {
        center_id: { type: "string", description: "The center's day care ID, e.g. 'DC1000'." },
      },
      required: ["center_id"],
    },
  },
  {
    name: "decode_violation",
    description:
      "Decode an NYC DOHMH childcare violation code (e.g. '47.41(j)') into plain English: meaning, severity tier, category, tour question. " +
      "A family prefix like '47.33' returns a family-level decode. Unknown codes return a clean error. " +
      "Decodes are AI-seeded, pending human review - not expert-verified. City data ends April 2023.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Violation code, e.g. '47.41(j)' or family prefix '47.33'." },
      },
      required: ["code"],
    },
  },
];

function toolSearchCenters(args) {
  const query = String(args.query || "").trim().toLowerCase();
  const boroughRaw = String(args.borough || "").trim().toUpperCase();
  const borough = boroughRaw ? BOROUGH_ALIASES[boroughRaw] : null;
  if (!query && !borough) {
    throw rpcError(-32602, "Provide at least one of: query (name substring) or borough.");
  }
  if (query && query.length < 2) {
    throw rpcError(-32602, "query must be at least 2 characters.");
  }
  let limit = parseInt(args.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 10;
  limit = Math.min(limit, 50);

  const matches = CENTERS.filter((c) => {
    if (borough && c[C.BOROUGH] !== borough) return false;
    if (query && !c[C.NAME].toLowerCase().includes(query)) return false;
    return true;
  });
  matches.sort((a, b) => {
    if (query) {
      const as = a[C.NAME].toLowerCase().startsWith(query) ? 0 : 1;
      const bs = b[C.NAME].toLowerCase().startsWith(query) ? 0 : 1;
      if (as !== bs) return as - bs;
    }
    return b[C.INSP] - a[C.INSP];
  });
  const results = matches.slice(0, limit).map((c) => {
    const g = sproutGrade(c);
    return {
      center_id: c[C.ID],
      name: c[C.NAME],
      borough: c[C.BOROUGH],
      address: `${c[C.ADDR]}, ${c[C.BOROUGH]}, NY ${c[C.ZIP]}`,
      inspections: c[C.INSP],
      flagged: c[C.FLAG],
      last_inspection: c[C.LAST],
      grade: g.grade,
      grade_basis: g.basis,
    };
  });
  return {
    matches: results,
    total_matches: matches.length,
    returned: results.length,
    data_as_of: DATA_META.data_as_of,
    data_caveat: DATA_CAVEAT,
  };
}

function toolGetCenterReport(args) {
  const c = findCenter(args.center_id);
  if (!c) {
    return {
      error: "center_not_found",
      message: `We couldn't find "${args.center_id}" in NYC's published daycare inspection records (2020-2023). Check the spelling, or try the legal name on the center's door. Newer centers may not appear - the city's public data ends in April 2023.`,
      data_as_of: DATA_META.data_as_of,
    };
  }
  const vs = verdictFor(c);
  const viol = c[C.VIOL].map((v) => {
    const d = decodeCode(v[V.CODE]);
    const latest = v[V.DATES][v[V.DATES].length - 1];
    return {
      code: v[V.CODE],
      plain_english: d ? d.plain_english : "(decode unavailable)",
      severity: d ? d.severity : "unknown",
      city_category: v[V.CAT],
      citations: v[V.N],
      dates: v[V.DATES],
      latest_date: latest,
      statuses: v[V.STATUSES],
      status_plain: statusPlainForCenter(v[V.STATUSES]),
      tour_question: d ? d.tour_question : "",
    };
  });
  viol.sort((a, b) =>
    (SEV_RANK[a.severity] ?? 3) - (SEV_RANK[b.severity] ?? 3) ||
    b.latest_date.localeCompare(a.latest_date)
  );
  const bySeverity = { critical: 0, major: 0, minor: 0 };
  for (const v of viol) {
    if (bySeverity[v.severity] !== undefined) bySeverity[v.severity] += v.citations;
  }
  const dates = [...new Set(c[C.VIOL].flatMap((v) => v[V.DATES]))].sort();
  return {
    center: {
      center_id: c[C.ID],
      name: c[C.NAME],
      address: `${c[C.ADDR]}, ${c[C.BOROUGH]}, NY ${c[C.ZIP]}`,
      borough: c[C.BOROUGH],
      child_care_type: c[C.CCTYPE],
    },
    summary: {
      inspections: c[C.INSP],
      flagged: c[C.FLAG],
      violations_total: viol.reduce((s, v) => s + v.citations, 0),
      by_severity: bySeverity,
      last_inspection: c[C.LAST],
      inspection_dates: dates,
      data_as_of: DATA_META.data_as_of,
    },
    vs_nyc_average: vs,
    top_violations: viol.slice(0, 20),
    total_distinct_violation_codes: viol.length,
    data_caveat: DATA_CAVEAT,
    decode_caveat: DECODE_CAVEAT,
    low_data_caveat: c[C.INSP] < 3
      ? `Only ${c[C.INSP]} inspection(s) on record - too few to judge a pattern. Treat this as a starting point, not a verdict.`
      : null,
  };
}

function toolDecodeViolation(args) {
  const raw = String(args.code || "").trim();
  if (!raw) throw rpcError(-32602, "code is required, e.g. '47.41(j)'.");
  const exact = decodeCode(raw);
  if (exact) return { level: "code", ...exact, data_as_of: DATA_META.data_as_of };
  const famKey = raw.replace(/\(.*\)$/, "").trim();
  const fam = FAMILIES[famKey];
  if (fam) {
    const codesInFam = Object.keys(CODES).filter((k) => k === famKey || k.startsWith(famKey + "(")).slice(0, 25);
    return {
      level: "family",
      code: raw,
      family: famKey,
      label: fam[0],
      tour_question: fam[1],
      codes_in_family: codesInFam,
      note: "Family-level decode. Cite a full code (e.g. '" + famKey + "(b)') for the exact decode.",
      decode_caveat: DECODE_CAVEAT,
      data_as_of: DATA_META.data_as_of,
    };
  }
  return {
    error: "unknown_violation_code",
    message: `We don't recognize violation code "${raw}". Codes look like "47.41(j)" or a family prefix like "47.33". Check the code on the inspection report and try again.`,
    data_as_of: DATA_META.data_as_of,
  };
}

// ---------- JSON-RPC plumbing ----------
function rpcError(code, message, data) {
  const e = new Error(message);
  e.rpcCode = code;
  e.rpcData = data;
  return e;
}

function jsonRpcResponse(id, result) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function jsonRpcError(id, code, message, data) {
  const err = { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
  if (data !== undefined) err.error.data = data;
  return err;
}

const HANDLERS = {
  search_centers: toolSearchCenters,
  get_center_report: toolGetCenterReport,
  decode_violation: toolDecodeViolation,
};

async function handleRpc(body) {
  const { jsonrpc, id, method, params } = body || {};
  if (jsonrpc !== "2.0" || typeof method !== "string") {
    return jsonRpcError(id, -32600, "Invalid JSON-RPC 2.0 request.");
  }
  try {
    if (method === "initialize") {
      return jsonRpcResponse(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    if (method === "notifications/initialized" || method.startsWith("notifications/")) {
      return null; // notification: no response body (202)
    }
    if (method === "ping") return jsonRpcResponse(id, {});
    if (method === "tools/list") {
      return jsonRpcResponse(id, { tools: TOOLS });
    }
    if (method === "tools/call") {
      const name = params && params.name;
      const handler = HANDLERS[name];
      if (!handler) return jsonRpcError(id, -32602, `Unknown tool: ${name}`);
      try {
        const result = handler(params.arguments || {});
        return jsonRpcResponse(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        });
      } catch (e) {
        if (e.rpcCode) return jsonRpcError(id, e.rpcCode, e.message, e.rpcData);
        return jsonRpcError(id, -32603, "Tool execution failed: " + e.message);
      }
    }
    return jsonRpcError(id, -32601, `Method not found: ${method}`);
  } catch (e) {
    if (e.rpcCode) return jsonRpcError(id, e.rpcCode, e.message, e.rpcData);
    return jsonRpcError(id, -32603, "Internal error: " + e.message);
  }
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id",
  };
}

function usageDoc(host) {
  const endpoint = "https://" + host + "/mcp";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SproutScore MCP Server</title>
<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;line-height:1.6}code,pre{background:#f4f4f5;padding:.2em .4em;border-radius:6px}pre{padding:1em;overflow:auto}.warn{background:#fffbeb;border:1px solid #f59e0b;padding:1em;border-radius:8px}</style>
</head><body>
<h1>SproutScore MCP Server</h1>
<p>Public, read-only <a href="https://modelcontextprotocol.io">Model Context Protocol</a> (Streamable HTTP) access to
NYC childcare-center inspection summaries.</p>
<div class="warn"><strong>Data caveat:</strong> ${DATA_CAVEAT}<br>
<strong>Decode caveat:</strong> ${DECODE_CAVEAT}</div>
<h2>Endpoint</h2>
<p><code>POST ${endpoint}</code> with <code>Content-Type: application/json</code>, JSON-RPC 2.0 body.
Supports <code>Accept: application/json</code> and <code>Accept: text/event-stream</code> (SSE).</p>
<h2>Tools</h2>
<ul>
<li><strong>search_centers</strong> — query by name substring and/or borough. Returns id, name, borough, address, inspection count, flagged count, SproutScore comparison grade.</li>
<li><strong>get_center_report</strong> — center id (e.g. <code>DC1000</code>) to decoded summary: counts vs NYC cohort average, top violations in plain English with severity and inspection dates.</li>
<li><strong>decode_violation</strong> — violation code (e.g. <code>47.41(j)</code>) to plain-English meaning, severity tier, category. Unknown codes return a clean error.</li>
</ul>
<h2>Example</h2>
<pre>curl -X POST ${endpoint} \\
  -H 'Content-Type: application/json' -H 'Accept: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"search_centers","arguments":{"query":"jackson","borough":"queens"}}}'
</pre>
<h2>Rate limit</h2>
<p>60 requests/minute per IP (best-effort per edge location). HTTP 429 with <code>retry_after_seconds</code> when exceeded.</p>
<p style="color:#666">Dataset: ${DATA_META.centers} centers, ${DATA_META.inspections} inspections, data as of ${DATA_META.data_as_of}. Source: ${DATA_META.source}.</p>
</body></html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(usageDoc(url.host), {
        headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() },
      });
    }
    if (url.pathname === "/mcp" && request.method === "POST") {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const retryAfter = rateLimitCheck(ip);
      if (retryAfter > 0) {
        return new Response(
          JSON.stringify(jsonRpcError(null, -32000, "Rate limit exceeded (60 req/min per IP).", { retry_after_seconds: retryAfter })),
          { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(retryAfter), ...corsHeaders() } }
        );
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify(jsonRpcError(null, -32700, "Parse error: body must be JSON.")),
          { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders() } });
      }
      const results = Array.isArray(body)
        ? await Promise.all(body.map(handleRpc))
        : [await handleRpc(body)];
      const filtered = results.filter((r) => r !== null);
      const accept = request.headers.get("Accept") || "";
      const payload = Array.isArray(body) ? filtered : filtered[0];
      if (filtered.length === 0) {
        return new Response(null, { status: 202, headers: corsHeaders() });
      }
      if (accept.includes("text/event-stream") && !accept.includes("application/json")) {
        const sse = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
        return new Response(sse, {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...corsHeaders() },
        });
      }
      return new Response(JSON.stringify(payload), {
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      });
    }
    return new Response(JSON.stringify({ error: "not_found", hint: "GET / for usage, POST /mcp for JSON-RPC." }),
      { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders() } });
  },
};
