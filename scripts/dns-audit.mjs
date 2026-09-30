#!/usr/bin/env node
/**
 * Read-only audit of a Route 53 record set export.
 *
 *   aws route53 list-resource-record-sets --hosted-zone-id ZONE --output json > zone.json
 *   node scripts/dns-audit.mjs zone.json cyberphysical.us us-east-1
 *
 * Does not call AWS. Does not change DNS.
 */

import { readFile } from "node:fs/promises";

/**
 * @typedef {{ name: string, type: string, ttl?: number, values: string[] }} DnsRecord
 * @typedef {{ level: "info" | "warn" | "blocker", name?: string, type?: string, message: string }} Finding
 */

/**
 * @param {unknown} raw
 * @returns {DnsRecord[]}
 */
export function parseRoute53Export(raw) {
  const doc = typeof raw === "string" ? JSON.parse(raw) : raw;
  const sets = Array.isArray(doc)
    ? doc
    : doc && typeof doc === "object" && "ResourceRecordSets" in doc
      ? /** @type {{ ResourceRecordSets: unknown[] }} */ (doc).ResourceRecordSets
      : null;
  if (!sets) {
    throw new Error("Expected a Route 53 list-resource-record-sets JSON document or an array of records.");
  }
  return sets.map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("Record set entry is not an object.");
    }
    const rec = /** @type {Record<string, unknown>} */ (item);
    const name = typeof rec.name === "string" ? rec.name : typeof rec.Name === "string" ? rec.Name : "";
    const type = typeof rec.type === "string" ? rec.type : typeof rec.Type === "string" ? rec.Type : "";
    const ttl = typeof rec.ttl === "number" ? rec.ttl : typeof rec.TTL === "number" ? rec.TTL : undefined;
    const values = collectValues(rec);
    if (!name || !type) throw new Error("Record is missing name or type.");
    return { name: name.toLowerCase(), type: type.toUpperCase(), ttl, values };
  });
}

/**
 * @param {Record<string, unknown>} rec
 * @returns {string[]}
 */
function collectValues(rec) {
  const raw = rec.values ?? rec.Values ?? rec.ResourceRecords ?? rec.resourceRecords;
  if (!Array.isArray(raw)) {
    if (typeof rec.Value === "string") return [rec.Value];
    return [];
  }
  return raw.map((entry) => {
    if (typeof entry === "string") return entry;
    if (entry && typeof entry === "object" && "Value" in entry && typeof entry.Value === "string") {
      return entry.Value;
    }
    return JSON.stringify(entry);
  });
}

/**
 * @param {string} name
 * @param {string} domain
 */
function apex(name, domain) {
  const d = domain.toLowerCase().replace(/\.$/, "");
  const n = name.toLowerCase().replace(/\.$/, "");
  return n === d;
}

/**
/**
 * @param {string[]} values
 * @returns {string | null}
 */
function sesInboundRegion(values) {
  const joined = values.join(" ").toLowerCase();
  const match = joined.match(/inbound-smtp\.([a-z0-9-]+)\.amazonaws\.com/);
  return match?.[1] ?? null;
}

/**
 * @param {DnsRecord[]} records
 * @param {string} domain
 * @param {string} [expectedRegion]
 * @returns {{ domain: string, recordCount: number, findings: Finding[], blockers: number }}
 */
export function auditZone(records, domain, expectedRegion = "us-east-1") {
  const d = domain.toLowerCase().replace(/\.$/, "");
  const region = expectedRegion.toLowerCase();
  /** @type {Finding[]} */
  const findings = [];
  const mailFrom = `mail.${d}`;
  let dkimCount = 0;

  findings.push({
    level: "info",
    message: `${records.length} record(s) in the export. Expected receiving region is ${region}. Read every record before changing anything.`,
  });

  const soa = records.filter((r) => r.type === "SOA");
  const ns = records.filter((r) => r.type === "NS");
  if (soa.length === 0 || ns.length === 0) {
    findings.push({
      level: "blocker",
      message: "Export has no SOA or no NS. This does not look like a full hosted zone. Stop.",
    });
  } else {
    findings.push({
      level: "info",
      message: `SOA and ${ns.length} NS record(s) present. Do not edit them as part of mail cutover.`,
    });
  }

  for (const rec of records) {
    const bare = rec.name.replace(/\.$/, "");
    const joined = rec.values.join(" ").toLowerCase();

    const isDkim = bare.includes("._domainkey.") || bare.endsWith("._domainkey");
    const isAcm = rec.type === "CNAME" && joined.includes("acm-validations.aws");
    const isAutodiscover = bare.startsWith("autodiscover.") || bare.startsWith("autoconfig.") || bare.includes("_autodiscover");
    const isChime = bare === `_amazonchime.${d}` || bare.startsWith("_amazonchime.");
    const isSesVerification = rec.type === "TXT" && bare === `_amazonses.${d}`;

    if (isAcm) {
      findings.push({
        level: "info",
        name: rec.name,
        type: rec.type,
        message: "Protected. ACM validation CNAME. Do not edit or delete it.",
      });
    } else if (isDkim) {
      dkimCount += 1;
      findings.push({
        level: "info",
        name: rec.name,
        type: rec.type,
        message: "Protected. Existing Easy DKIM CNAME. Do not add another _domainkey record and do not delete this one.",
      });
    } else if (isSesVerification) {
      findings.push({
        level: "info",
        name: rec.name,
        type: rec.type,
        message: "Protected. _amazonses TXT is the SES verification record. Do not delete it.",
      });
    } else if (isAutodiscover) {
      findings.push({
        level: "info",
        name: rec.name,
        type: rec.type,
        message: "Optional cleanup. autodiscover is a WorkMail leftover. Remove it only after confirming WorkMail is gone. lojo-mail does not use it.",
      });
    } else if (isChime) {
      findings.push({
        level: "info",
        name: rec.name,
        type: rec.type,
        message: "Optional cleanup. _amazonchime TXT is a WorkMail leftover. Remove it only after confirming WorkMail is gone.",
      });
    } else if ((rec.type === "A" || rec.type === "AAAA" || rec.type === "CAA" || rec.type === "CNAME") && !joined.includes("amazonses") && !joined.includes("inbound-smtp")) {
      findings.push({
        level: "info",
        name: rec.name,
        type: rec.type,
        message: "Looks like website or verification infrastructure. Leave it alone unless you know it is mail-related.",
      });
    }

    if (rec.type === "TXT" && /google-site-verification|apple-domain-verification|github-pages|ms=|stripe-verification|atlassian|brave-ledger|have-i-been-pwned|protonmail-verification/.test(joined)) {
      findings.push({
        level: "info",
        name: rec.name,
        type: rec.type,
        message: "Site or service verification TXT. Do not delete it while adding SPF or DMARC.",
      });
    }

    if (rec.type === "MX" && apex(rec.name, d)) {
      const inbound = sesInboundRegion(rec.values);
      const ttlNote = rec.ttl === undefined ? "" : ` TTL ${rec.ttl}.`;
      if (inbound === region) {
        findings.push({
          level: "info",
          name: rec.name,
          type: rec.type,
          message: `Apex MX already points at SES inbound in ${region} (${rec.values.join(", ")}).${ttlNote} Do not change the target. Lower the TTL only before a future region move.`,
        });
      } else if (inbound) {
        findings.push({
          level: "blocker",
          name: rec.name,
          type: rec.type,
          message: `Apex MX points at SES inbound in ${inbound}, not ${region}. Do not stand up a receipt rule in ${region} until the MX and the rule region match.`,
        });
      } else {
        findings.push({
          level: "blocker",
          name: rec.name,
          type: rec.type,
          message: `Existing apex MX is not SES (${rec.values.join(", ")}).${ttlNote} Write the current values down before any cutover. Do not assume the zone is mail-free.`,
        });
      }
    } else if (rec.type === "MX") {
      const sesFeedback = joined.includes("feedback-smtp") && joined.includes("amazonses.com");
      findings.push({
        level: bare === mailFrom && sesFeedback ? "info" : "warn",
        name: rec.name,
        type: rec.type,
        message:
          bare === mailFrom
            ? sesFeedback
              ? "mail.<domain> MX already points at the SES feedback endpoint."
              : "mail.<domain> already has an MX that is not SES. Custom MAIL FROM requires exactly one MX, so this must be resolved before SES will accept the MAIL FROM domain."
            : `Non-apex MX on ${bare} (${rec.values.join(", ")}). Confirm it is unrelated before adding records.`,
      });
    }

    if (rec.type === "TXT" && joined.includes("v=spf1")) {
      const ses = joined.includes("amazonses.com");
      findings.push({
        level: ses ? "info" : "warn",
        name: rec.name,
        type: rec.type,
        message: ses
          ? "SPF already includes amazonses.com. Do not publish a second SPF TXT on this name."
          : "Existing SPF does not mention amazonses.com. Merge include:amazonses.com into this record. A second TXT that also starts with v=spf1 is a permanent SPF error.",
      });
    }

    if (rec.type === "TXT" && bare === `_dmarc.${d}`) {
      const hasRua = joined.includes("rua=");
      findings.push({
        level: "info",
        name: rec.name,
        type: rec.type,
        message: hasRua
          ? `Existing DMARC (${rec.values.join(" ")}). Edit this one record if the policy changes. Do not publish a second _dmarc TXT.`
          : `Existing DMARC without rua (${rec.values.join(" ")}). Keep p=quarantine. Edit this single TXT to add a dedicated rua. Do not publish a second _dmarc TXT and do not relax the policy to stand up receipt.`,
      });
    }
  }

  if (dkimCount > 0) {
    findings.push({
      level: "info",
      message: `${dkimCount} Easy DKIM CNAME(s). The September 2026 audit found six on this domain. Do not publish additional _domainkey records.`,
    });
  }

  const spfByName = new Map();
  for (const rec of records) {
    if (rec.type !== "TXT") continue;
    if (!rec.values.some((v) => v.toLowerCase().includes("v=spf1"))) continue;
    const key = rec.name;
    spfByName.set(key, (spfByName.get(key) ?? 0) + rec.values.filter((v) => v.toLowerCase().includes("v=spf1")).length);
  }
  for (const [name, count] of spfByName) {
    if (count > 1) {
      findings.push({
        level: "blocker",
        name,
        type: "TXT",
        message: "More than one SPF string on this name. Fix that before adding anything. Mail receivers will treat SPF as a permanent error.",
      });
    }
  }

  const blockers = findings.filter((f) => f.level === "blocker").length;
  return { domain: d, recordCount: records.length, findings, blockers };
}

function printReport(report) {
  console.log(`# DNS audit for ${report.domain}`);
  console.log(`# records: ${report.recordCount}`);
  console.log(`# blockers: ${report.blockers}`);
  for (const finding of report.findings) {
    const where = finding.name ? ` [${finding.type ?? "?"} ${finding.name}]` : "";
    console.log(`${finding.level.toUpperCase()}${where}: ${finding.message}`);
  }
}

async function main() {
  const file = process.argv[2];
  const domain = process.argv[3] ?? "cyberphysical.us";
  const region = process.argv[4] ?? "us-east-1";
  if (!file || file === "--help") {
    console.error("usage: node scripts/dns-audit.mjs <zone.json> [domain] [region]");
    process.exit(2);
  }
  const raw = await readFile(file, "utf8");
  const report = auditZone(parseRoute53Export(raw), domain, region);
  printReport(report);
  process.exit(report.blockers > 0 ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  });
}
