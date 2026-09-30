import { wkdAdvancedUrl, wkdLocalPartHash } from "@lojo/core";

const localPart = process.argv[2] ?? "lojo";
const domain = process.argv[3] ?? process.env.LOJO_DOMAIN ?? "cyberphysical.us";
const hash = wkdLocalPartHash(localPart);
console.log(hash);
console.log(wkdAdvancedUrl(domain, localPart));
