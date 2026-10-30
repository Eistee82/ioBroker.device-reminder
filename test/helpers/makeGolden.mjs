// Writes test/fixtures/detectorGolden.json from the current build (run once with the 3.1.2 detector
// of commit cd5e67f: `npm run build && node test/helpers/makeGolden.mjs`).
import { writeFileSync } from "node:fs";
import { createDetector } from "../../build/lib/detector/index.js";
import { goldenHashes } from "./golden.js";

const target = new URL("../fixtures/detectorGolden.json", import.meta.url);
writeFileSync(target, `${JSON.stringify(goldenHashes(createDetector), null, "\t")}\n`);
